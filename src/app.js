import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { describeUpstreamError } from "./llm.js";
import { TtsBusyError } from "./tts.js";
import { toSpeakable, splitForSpeech } from "./speech-text.js";
import { createStore } from "./store.js";
import { readIdentity, cleanId } from "./ids.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const MAX_CHARS_PER_MESSAGE = 8000;
// Total characters of history sent to the model per call. Oldest turns are
// dropped first; the newest message is always kept.
const MAX_CONTEXT_CHARS = 40_000;
const MAX_EVENTS_PER_BATCH = 100;
const MAX_DETAIL_CHARS = 2000;

// Client event types we store. Anything else is dropped, so a buggy or hostile
// page cannot fill the table with junk types.
export const EVENT_TYPES = new Set([
  "page_load", "voice_used", "send", "reply", "reply_error", "retry", "slow_reply",
  "audio_start", "audio_replay", "audio_stop", "audio_end", "audio_error",
  "reset", "visibility_hidden", "visibility_visible", "page_hide",
]);

/** Returns an error string, or null when the chat history is well formed. */
export function validateMessages(messages, maxMessages = 200) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'Request body must include a non-empty "messages" array.';
  }
  if (messages.length > maxMessages) {
    return `Conversation too long (max ${maxMessages} messages).`;
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
export function rateLimiter({ limit, windowMs, now = Date.now, key: keyFn = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = keyFn(req);
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
 * Study gate: when STUDY_TOKEN is set (required with a real LLM), /api/chat and /api/speak need the
 * same value in X-Study-Token (the page copies it from ?k= in the study link).
 * Not a real secret, participants can see it, but it stops drive-by scrapers
 * from using the REALLMS key.
 */
export function studyGate(token) {
  if (!token) return (_req, _res, next) => next();
  const expected = Buffer.from(token);
  return (req, res, next) => {
    // Header from fetch(); body field from navigator.sendBeacon (no headers).
    const got = Buffer.from(req.get("x-study-token") ?? req.body?.k ?? "");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return next();
    res.status(401).json({ error: "This study link is not valid. Please use the link you were given." });
  };
}

export function createApp({ config, llm, tts, store = createStore({ enabled: false }), systemPrompt = config.systemPrompt }) {
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

  // A 10-minute chat can be long; history is re-sent on every turn.
  app.use(express.json({ limit: "1mb" }));

  const gate = studyGate(config.security?.studyToken);
  const study = { maxHistory: 200, contextMessages: 40, ...config.study };

  // Two layers of rate limiting. Per session: one participant looping. Per IP:
  // generous, because a campus lab puts many participants behind ONE address,
  // and a per-IP-only limit would block real participants mid-study.
  const perSession = (limit) =>
    rateLimiter({ limit, windowMs: 10 * 60_000, key: (req) => `s:${cleanId(req.body?.sessionId) ?? req.ip}` });
  const perIp = (limit) => rateLimiter({ limit, windowMs: 10 * 60_000 });

  // One row per page load: who, which condition, which browser, which code.
  app.post("/api/session", gate, perIp(600), async (req, res) => {
    const id = readIdentity(req.body);
    if (id.error) return res.status(400).json({ error: id.error });
    const saved = await store.insert("participants", [
      {
        response_id: id.responseId,
        session_id: id.sessionId,
        condition: id.condition,
        in_qualtrics: req.body?.embedded === true,
        show_transcript: req.body?.showTranscript === true,
        tts_backend: tts.backend,
        user_agent: String(req.get("user-agent") ?? "").slice(0, 400),
        app_version: config.appVersion ?? "dev",
      },
    ]);
    res.json({ ok: true, saved: saved.ok });
  });

  app.post("/api/chat", gate, perIp(1500), perSession(60), async (req, res) => {
    const body = req.body ?? {};
    const id = readIdentity(body);
    if (id.error) return res.status(400).json({ error: id.error });
    const clientMsgId = cleanId(body.clientMsgId);
    if (!clientMsgId) return res.status(400).json({ error: 'Missing or invalid "clientMsgId".' });
    const { messages } = body;
    const invalid = validateMessages(messages, study.maxHistory);
    if (invalid) return res.status(400).json({ error: invalid });

    const userText = messages[messages.length - 1].content;
    const turnIndex = messages.filter((m) => m.role === "user").length;
    const row = (role, content, extra = {}) => ({
      response_id: id.responseId,
      session_id: id.sessionId,
      condition: id.condition,
      client_msg_id: clientMsgId,
      turn_index: turnIndex,
      role,
      content,
      model: extra.model ?? null,
      latency_ms: extra.latencyMs ?? null,
      chunk_count: extra.chunkCount ?? null,
    });

    const started = Date.now();
    try {
      // History comes from the client. Only the newest user turn and the reply
      // are stored. The model gets the recent tail, cut down to role + content
      // (no extra fields reach the upstream API) and capped in total size.
      const context = messages.slice(-study.contextMessages).map(({ role, content }) => ({ role, content }));
      let contextChars = context.reduce((n, m) => n + m.content.length, 0);
      while (context.length > 1 && contextChars > MAX_CONTEXT_CHARS) contextChars -= context.shift().content.length;
      const reply = await llm.complete([{ role: "system", content: systemPrompt }, ...context]);
      const latencyMs = Date.now() - started;
      // Chunks are computed here, once, so the browser does not need to know
      // how speech is split, and the logged reply and the spoken reply can
      // never drift apart.
      const chunks = splitForSpeech(toSpeakable(reply), Math.min(300, config.tts.maxChars));
      // Awaited so the page knows whether this turn was saved. store.insert never
      // throws and has its own timeout; a failure is queued for retry.
      const saved = await store.insert("chat_turns", [
        row("user", userText),
        row("assistant", reply, { model: llm.model, latencyMs, chunkCount: chunks.length }),
      ]);
      res.json({ reply, chunks, saved: saved.ok, turn: turnIndex });
    } catch (err) {
      console.error("LLM error:", err?.status, err?.message);
      const { status, error } = describeUpstreamError(err, llm.model);
      // Keep what the participant typed even when the model failed, plus the
      // failure itself, so the transcript has no unexplained gaps.
      await store.insert("chat_turns", [
        row("user", userText),
        row("error", `${status}: ${error}`, { model: llm.model, latencyMs: Date.now() - started }),
      ]);
      res.status(status).json({ error });
    }
  });

  // Batched UI events (play, replay, stop, voice used, tab hidden, ...).
  app.post("/api/events", gate, perIp(3000), perSession(300), async (req, res) => {
    const id = readIdentity(req.body);
    if (id.error) return res.status(400).json({ error: id.error });
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_BATCH) {
      return res.status(400).json({ error: `"events" must be an array of 1-${MAX_EVENTS_PER_BATCH} items.` });
    }
    const rows = [];
    for (const e of events) {
      if (!Number.isInteger(e?.seq) || e.seq < 0 || !EVENT_TYPES.has(e?.type)) continue;
      const ts = Number(e.t);
      let detail = e.detail && typeof e.detail === "object" ? e.detail : {};
      if (JSON.stringify(detail).length > MAX_DETAIL_CHARS) detail = { truncated: true };
      rows.push({
        response_id: id.responseId,
        session_id: id.sessionId,
        condition: id.condition,
        seq: e.seq,
        type: e.type,
        client_ts: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
        detail,
      });
    }
    const saved = await store.insert("client_events", rows);
    res.json({ ok: true, accepted: rows.length, saved: saved.ok });
  });

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

  // Is the database awake and is the key right? One real round trip.
  app.get("/healthz/db", async (_req, res) => {
    const r = await store.ping();
    res.status(r.ok ? 200 : 503).json({ ok: r.ok, store: store.status() });
  });

  // Fast way to confirm what a deploy is actually running, and whether the
  // voice model has finished loading, without opening the Render dashboard.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: config.appVersion ?? "dev", model: llm.model, tts: tts.status(), store: store.status() });
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
