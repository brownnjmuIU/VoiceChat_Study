import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { describeUpstreamError } from "./llm.js";
import { TtsBusyError } from "./tts.js";
import { toSpeakable, splitForSpeech } from "./speech-text.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 8000;

/** Returns an error string, or null when the chat history is well formed. */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'Request body must include a non-empty "messages" array.';
  }
  if (messages.length > MAX_MESSAGES) {
    return `Conversation too long (max ${MAX_MESSAGES} messages). Start a new chat.`;
  }
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) {
      return 'Each message needs a role of "user" or "assistant".';
    }
    if (typeof m.content !== "string" || m.content.trim() === "") {
      return "Each message needs non-empty string content.";
    }
    if (m.content.length > MAX_CHARS_PER_MESSAGE) {
      return `Message too long (max ${MAX_CHARS_PER_MESSAGE} characters).`;
    }
  }
  if (messages[messages.length - 1].role !== "user") {
    return "The last message must be from the user.";
  }
  return null;
}

/**
 * Fixed-window per-IP counter. The URL is public and unauthenticated; this is a
 * floor against someone looping the endpoint, not real security.
 */
export function rateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      entry = { start: t, count: 0 };
      hits.set(key, entry);
      // Bounded memory: drop only EXPIRED windows. Clearing everything would let
      // anyone reset every counter by cycling through 10k source addresses.
      if (hits.size > 10_000) {
        for (const [k, e] of hits) if (t - e.start >= windowMs) hits.delete(k);
      }
    }
    if (++entry.count > limit) {
      return res.status(429).json({ error: "Too many requests. Wait a few minutes and try again." });
    }
    next();
  };
}

/**
 * Optional gate: when STUDY_TOKEN is set, /api/chat and /api/speak need the
 * same value in X-Study-Token (the page copies it from ?k= in the study link).
 * Not a real secret, participants can see it, but it stops drive-by scrapers
 * from using the REALLMS key.
 */
export function studyGate(token) {
  if (!token) return (_req, _res, next) => next();
  const expected = Buffer.from(token);
  return (req, res, next) => {
    const got = Buffer.from(req.get("x-study-token") ?? "");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return next();
    res.status(401).json({ error: "This study link is not valid. Please use the link you were given." });
  };
}

export function createApp({ config, llm, tts }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in front of us; req.ip = real client

  const frameAncestors = config.security?.frameAncestors ?? "'self'";
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy": `default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  app.use(express.json({ limit: "100kb" }));

  const gate = studyGate(config.security?.studyToken);

  app.post(
    "/api/chat",
    gate,
    rateLimiter({ limit: 30, windowMs: 10 * 60_000 }),
    async (req, res) => {
      const { messages } = req.body ?? {};
      const invalid = validateMessages(messages);
      if (invalid) return res.status(400).json({ error: invalid });

      try {
        const reply = await llm.complete([{ role: "system", content: config.systemPrompt }, ...messages]);
        // Chunks are computed here, once, so the browser does not need to know
        // how speech is split, and the logged reply and the spoken reply can
        // never drift apart.
        const chunks = splitForSpeech(toSpeakable(reply), Math.min(300, config.tts.maxChars));
        res.json({ reply, chunks });
      } catch (err) {
        console.error("LLM error:", err?.status, err?.message);
        const { status, error } = describeUpstreamError(err, llm.model);
        res.status(status).json({ error });
      }
    },
  );

  app.post(
    "/api/speak",
    gate,
    rateLimiter({ limit: 600, windowMs: 10 * 60_000 }),
    async (req, res) => {
      if (tts.backend === "browser") {
        return res.status(404).json({ error: "Voice is played by the browser in this configuration." });
      }
      const text = req.body?.text;
      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: 'Body must include non-empty "text".' });
      }
      if (text.length > config.tts.maxChars) {
        return res.status(400).json({ error: `Text too long to speak (max ${config.tts.maxChars} characters).` });
      }
      try {
        const { wav, cached } = await tts.synthesize(text.trim());
        res.set({
          "Content-Type": "audio/wav",
          "Content-Length": wav.length,
          "Cache-Control": "no-store",
          "X-TTS-Cache": cached ? "hit" : "miss",
        });
        res.end(wav);
      } catch (err) {
        if (err instanceof TtsBusyError) {
          return res.status(503).json({ error: "The voice is busy. Try again in a moment." });
        }
        console.error("TTS error:", err?.status, err?.message);
        res.status(502).json({ error: "The voice could not be generated." });
      }
    },
  );

  app.get("/api/config", (_req, res) => {
    res.json({
      ...config.ui,
      ttsBackend: tts.backend,
      // Only used by the browser backend; harmless otherwise.
      browserVoice: config.tts.browserVoice,
      speed: config.tts.speed,
    });
  });

  // Fast way to confirm what a deploy is actually running, and whether the
  // voice model has finished loading, without opening the Render dashboard.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, model: llm.model, tts: tts.status() });
  });

  app.use(express.static(PUBLIC_DIR));

  // Last: JSON errors only. Express's default handler prints a stack trace
  // (with server paths) whenever NODE_ENV is not "production", e.g. on a
  // malformed JSON body.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error("Unhandled error:", err?.message);
    const error =
      status === 413 ? "Request too large." : status < 500 ? "Malformed request." : "Something went wrong on the server.";
    res.status(status).json({ error });
  });

  return app;
}
