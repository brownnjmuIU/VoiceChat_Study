import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("real LLM requires all three vars, reported together", () => {
  assert.throws(() => loadConfig({}), (e) => e.problems.length === 3);
});

test("mock LLM + defaults boot", () => {
  const c = loadConfig({ LLM_MOCK: "1" });
  assert.equal(c.tts.backend, "browser");
  assert.equal(c.tts.voice, "af_heart");
  assert.equal(c.ui.defaultMode, "voice");
  assert.equal(c.ui.showTranscript, false);
});

test("openai TTS backend needs a base URL", () => {
  assert.throws(() => loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "openai" }), /TTS_BASE_URL/);
  const c = loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "openai", TTS_BASE_URL: "http://iu:8880/v1" });
  assert.equal(c.tts.voice, "alloy");
});

test("bad values are rejected", () => {
  assert.throws(() => loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "siri" }), /TTS_BACKEND/);
  assert.throws(() => loadConfig({ LLM_MOCK: "1", DEFAULT_MODE: "video" }), /DEFAULT_MODE/);
  assert.throws(() => loadConfig({ LLM_MOCK: "1", TTS_SPEED: "fast" }), /number/);
});

test("kokoro is still one env var away", () => {
  const c = loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "kokoro" });
  assert.equal(c.tts.backend, "kokoro");
  assert.equal(loadConfig({ LLM_MOCK: "1", TTS_BROWSER_VOICE: "Aria" }).tts.browserVoice, "Aria");
});
