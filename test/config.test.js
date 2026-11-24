import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("real deploy requires LLM, study token and Supabase vars, reported together", () => {
  assert.throws(
    () => loadConfig({}),
    (e) => e.problems.length === 6 && e.problems.some((p) => /SUPABASE_SERVICE_KEY/.test(p)) && e.problems.some((p) => /STUDY_TOKEN/.test(p)),
  );
});

test("store can only be off on purpose", () => {
  const real = { LLM_BASE_URL: "https://x/v1", LLM_API_KEY: "k", LLM_MODEL: "m", STUDY_TOKEN: "t" };
  assert.throws(() => loadConfig(real), /SUPABASE_URL/);
  assert.equal(loadConfig({ ...real, STORE_DISABLED: "1" }).store.enabled, false);
  const c = loadConfig({ ...real, SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_KEY: "s" });
  assert.equal(c.store.enabled, true);
  assert.equal(loadConfig({ LLM_MOCK: "1" }).store.enabled, false);
});

test("study defaults: long chats allowed, reset hidden, Qualtrics origin allowed", () => {
  const c = loadConfig({ LLM_MOCK: "1" });
  assert.equal(c.study.maxHistory, 200);
  assert.equal(c.study.contextMessages, 40);
  assert.equal(c.ui.showReset, false);
  assert.deepEqual(c.ui.parentOrigins, ["https://iu.co1.qualtrics.com"]);
  assert.match(c.systemPrompt, /privacy policies/);
  assert.match(c.systemPrompt, /balanced/);
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
