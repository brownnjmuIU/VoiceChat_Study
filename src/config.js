// -----------------------------------------------------------------------------
// Every knob is an env var, so moving the LLM or the voice to IU hardware later
// is a Render env change plus a redeploy, never a code edit.
// -----------------------------------------------------------------------------

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
    timeoutMs: num(env.LLM_TIMEOUT_MS, 60_000),
    // Always capped: the endpoint is public, so an uncapped reply is an open
    // tab on the REALLMS key. Leaves room for gpt-oss reasoning tokens.
    maxTokens: num(env.LLM_MAX_TOKENS, 1024),
    temperature: env.LLM_TEMPERATURE ? num(env.LLM_TEMPERATURE) : undefined,
    reasoningEffort: env.LLM_REASONING_EFFORT || undefined,
  };
  if (!llm.mock) {
    for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) {
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

  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    err.problems = problems;
    throw err;
  }

  return {
    port: num(env.PORT, 3000),
    security: {
      // Optional shared token carried in the study link (?k=...). Empty = off.
      studyToken: env.STUDY_TOKEN ?? "",
      // Who may embed the page in an iframe (CSP frame-ancestors).
      frameAncestors: env.FRAME_ANCESTORS ?? "'self' https://*.qualtrics.com",
    },
    llm,
    tts,
    ui: {
      defaultMode,
      // In voice mode, hide the words by default so the manipulation is
      // "heard, not read". ?transcript=1 overrides per page load.
      showTranscript: bool(env.SHOW_TRANSCRIPT, false),
      title: env.CHAT_TITLE ?? "Assistant",
    },
    systemPrompt:
      env.SYSTEM_PROMPT ??
      // ONE prompt for both conditions, so text and voice participants get the
      // same words. Plain spoken prose because the same reply has to sound
      // natural read aloud: no markdown, lists, tables, links or emoji.
      "You are a helpful assistant. Answer in plain conversational prose, as if speaking. " +
        "Do not use markdown, bullet points, numbered lists, tables, headings, links, code blocks or emoji. " +
        "Keep answers under about 150 words unless the user asks for more.",
  };
}
