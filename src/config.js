// -----------------------------------------------------------------------------
// Every knob is an env var, so moving the LLM or the voice to IU hardware later
// is a Render env change plus a redeploy, never a code edit.
// -----------------------------------------------------------------------------

// ONE prompt for both conditions, so text and voice participants get the same
// words; only the reply channel differs. Neutral on purpose: it must not push
// either the benefits or the risks, since that is what the study measures.
// Plain spoken prose because the same reply has to sound natural read aloud.
export const DEFAULT_SYSTEM_PROMPT =
  "You are an assistant helping a participant in a research study understand the privacy policies of two AI " +
  "chatbot companies, OpenAI (ChatGPT) and Anthropic (Claude). The participant has just read these policies. " +
  "Help them understand what the policies say about how personal information and conversation data are " +
  "collected, used, stored, shared and protected, and what choices users have. Explain both the benefits and " +
  "the risks of sharing personal information with a chatbot in a balanced, even-handed way; do not try to " +
  "persuade the participant either way. " +
  "Accuracy rules, which matter more than sounding complete: when policy text is provided below, answer ONLY from " +
  "that text. Keep the two companies separate: never attribute one company's terms to the other, and when you " +
  "compare them, check each claim against that company's own policy. If a policy does not address something " +
  "(for example default settings, exact time periods, or features it does not mention), say plainly that the " +
  "policy does not say, instead of guessing. Include important exceptions and conditions the policy states " +
  "(for example cases where data is still used or kept after a user opts out or deletes it), because leaving " +
  "them out changes the meaning. Do not use outside knowledge about either company. " +
  "Answer in plain conversational prose, as if speaking. Do not use markdown, bullet points, numbered lists, " +
  "tables, headings, links, code blocks or emoji. Keep answers under about 120 words unless the participant " +
  "asks for more.";

const TTS_BACKENDS = ["browser", "kokoro", "openai", "mock"];
const MODES = ["text", "voice"];

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${value}"`);
  return n;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

/**
 * Build the config from an env object. Throws one error listing every problem,
 * so a bad Render deploy fails at boot with a readable log line instead of a
 * 500 the first time Nick types.
 */
export function loadConfig(env = process.env) {
  const problems = [];

  const llmMock = bool(env.LLM_MOCK, false);
  const llm = {
    mock: llmMock,
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL ?? (llmMock ? "mock" : undefined),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 45_000),
    // Always capped: the endpoint is public, so an uncapped reply is an open
    // tab on the REALLMS key. Leaves room for gpt-oss reasoning tokens.
    maxTokens: num(env.LLM_MAX_TOKENS, 1024),
    temperature: env.LLM_TEMPERATURE ? num(env.LLM_TEMPERATURE) : undefined,
    reasoningEffort: env.LLM_REASONING_EFFORT || undefined,
  };
  if (!llm.mock) {
    // STUDY_TOKEN is required with a real LLM: without it /api/chat is an open
    // proxy to the REALLMS key for anyone who finds the URL.
    for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "STUDY_TOKEN"]) {
      if (!env[k]) problems.push(`${k} is required (or set LLM_MOCK=1 for local dev)`);
    }
  }

  // Default is the browser's built-in voice: instant, free, no server load.
  // Kokoro stays fully wired up; set TTS_BACKEND=kokoro to switch back.
  const backend = (env.TTS_BACKEND ?? "browser").toLowerCase();
  if (!TTS_BACKENDS.includes(backend)) {
    problems.push(`TTS_BACKEND must be one of ${TTS_BACKENDS.join(", ")}`);
  }
  const tts = {
    backend,
    voice: env.TTS_VOICE ?? (backend === "openai" ? "alloy" : "af_heart"),
    speed: num(env.TTS_SPEED, 1),
    // Browser voice: preferred voice NAME (substring match, e.g. "Aria" or
    // "Samantha"). Voices differ per device, so the page logs which one played.
    browserVoice: env.TTS_BROWSER_VOICE ?? "",
    // Kokoro (in-process)
    kokoroModel: env.KOKORO_MODEL ?? "onnx-community/Kokoro-82M-v1.0-ONNX",
    kokoroDtype: env.KOKORO_DTYPE ?? "q8",
    cacheDir: env.MODEL_CACHE_DIR ?? "./.model-cache",
    // Any OpenAI-compatible /v1/audio/speech server (OpenAI itself, or
    // Kokoro-FastAPI running on IU hardware next to REALLMS).
    baseURL: env.TTS_BASE_URL,
    apiKey: env.TTS_API_KEY,
    model: env.TTS_MODEL ?? "kokoro",
    // Limits. One request = one sentence-sized chunk, see speech-text.js.
    // /api/chat never produces chunks over 300 chars, so nothing legit is longer.
    maxChars: num(env.TTS_MAX_CHARS, 300),
    maxQueue: num(env.TTS_MAX_QUEUE, 8),
    cacheEntries: num(env.TTS_CACHE_ENTRIES, 200),
    // Byte cap too: 200 long WAVs alone would OOM a 512 MB Render box.
    cacheBytes: num(env.TTS_CACHE_MB, 64) * 1024 * 1024,
  };
  if (backend === "openai" && !tts.baseURL) {
    problems.push("TTS_BASE_URL is required when TTS_BACKEND=openai");
  }

  const defaultMode = (env.DEFAULT_MODE ?? "voice").toLowerCase();
  if (!MODES.includes(defaultMode)) problems.push(`DEFAULT_MODE must be text or voice`);

  // Study data store. REQUIRED unless explicitly turned off, so a deploy that
  // forgot the Supabase vars fails at boot instead of silently saving nothing.
  // Mock LLM (local dev/tests) defaults to no database unless one is given.
  const storeDisabled = bool(env.STORE_DISABLED, false) || (llmMock && !env.SUPABASE_URL);
  const store = {
    enabled: !storeDisabled,
    url: env.SUPABASE_URL,
    key: env.SUPABASE_SERVICE_KEY,
    timeoutMs: num(env.SUPABASE_TIMEOUT_MS, 5000),
    // Ping the database on this interval (hours, 0 = off). Proves it is awake in
    // the logs and keeps a Free-plan project from pausing while this server runs.
    keepAliveHours: num(env.SUPABASE_KEEPALIVE_HOURS, 6),
  };
  if (store.enabled) {
    for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) {
      if (!env[k]) problems.push(`${k} is required (or set STORE_DISABLED=1 for local dev without a database)`);
    }
  }

  // Qualtrics origins allowed to receive usage counts via postMessage.
  const parentOrigins = String(env.PARENT_ORIGINS ?? "https://iu.co1.qualtrics.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    err.problems = problems;
    throw err;
  }

  return {
    port: num(env.PORT, 3000),
    security: {
      // Shared token carried in the study link (?k=...). Required with a real
      // LLM (see above); may be empty only with LLM_MOCK=1 for local dev.
      studyToken: env.STUDY_TOKEN ?? "",
      // Who may embed the page in an iframe (CSP frame-ancestors).
      frameAncestors: env.FRAME_ANCESTORS ?? "'self' https://*.qualtrics.com",
    },
    llm,
    tts,
    store,
    // Render sets RENDER_GIT_COMMIT; stored on every participant row so data can
    // always be traced to the exact code that produced it.
    appVersion: (env.APP_VERSION || env.RENDER_GIT_COMMIT || "dev").slice(0, 12),
    study: {
      // Whole conversations are kept and logged; only the most recent messages
      // are sent to the model, so a long 10-minute chat never hits a hard limit.
      maxHistory: num(env.MAX_HISTORY_MESSAGES, 200),
      contextMessages: num(env.LLM_CONTEXT_MESSAGES, 40),
      policyDir: env.POLICY_DIR ?? "./policies",
    },
    ui: {
      defaultMode,
      // In voice mode, hide the words by default so the manipulation is
      // "heard, not read". ?transcript=1 overrides per page load.
      showTranscript: bool(env.SHOW_TRANSCRIPT, false),
      title: env.CHAT_TITLE ?? "Assistant",
      // "New chat" wipes the visible history mid-study, which muddies the data.
      showReset: bool(env.SHOW_RESET, false),
      parentOrigins,
    },
    systemPrompt: env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
  };
}
