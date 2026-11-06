import { test } from "node:test";
import assert from "node:assert/strict";
import { createTts, TtsBusyError } from "../src/tts.js";
import { loadConfig } from "../src/config.js";

const cfg = (extra = {}) => ({ ...loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "mock" }).tts, ...extra });

test("mock backend returns a valid WAV", async () => {
  const { wav } = await createTts(cfg()).synthesize("Hello there.");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.ok(wav.length > 44);
});

test("same text is served from cache", async () => {
  let calls = 0;
  const engine = { name: "fake", speak: async () => (calls++, Buffer.from("x")) };
  const tts = createTts(cfg(), { engine });
  assert.equal((await tts.synthesize("a")).cached, false);
  assert.equal((await tts.synthesize("a")).cached, true);
  assert.equal(calls, 1);
});

test("synthesis is serialised, one at a time", async () => {
  let running = 0, peak = 0;
  const engine = { name: "fake", speak: async (t) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--; return Buffer.from(t);
  } };
  const tts = createTts(cfg(), { engine });
  await Promise.all(["a", "b", "c", "d"].map((t) => tts.synthesize(t)));
  assert.equal(peak, 1);
});

test("full queue refuses fast; one failure does not poison the queue", async () => {
  let n = 0;
  const engine = { name: "fake", speak: async (t) => {
    await new Promise((r) => setTimeout(r, 5));
    if (n++ === 0) throw new Error("boom");
    return Buffer.from(t);
  } };
  const tts = createTts(cfg({ maxQueue: 2 }), { engine });
  const results = await Promise.allSettled(["a", "b", "c"].map((t) => tts.synthesize(t)));
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.ok(results[2].reason instanceof TtsBusyError);
});

test("cache is bounded", async () => {
  const engine = { name: "fake", speak: async (t) => Buffer.from(t) };
  const tts = createTts(cfg({ cacheEntries: 2 }), { engine });
  for (const t of ["a", "b", "c"]) await tts.synthesize(t);
  assert.equal((await tts.synthesize("a")).cached, false); // evicted
  assert.equal((await tts.synthesize("c")).cached, true);
});

test("cache is bounded by bytes, not just entries", async () => {
  const engine = { name: "fake", speak: async () => Buffer.alloc(400) };
  const tts = createTts(cfg({ cacheEntries: 100, cacheBytes: 1000 }), { engine });
  for (const t of ["a", "b", "c", "d"]) await tts.synthesize(t);
  const s = tts.status();
  assert.ok(s.cacheBytes <= 1000, `cache holds ${s.cacheBytes} bytes`);
  assert.equal(s.cacheEntries, 2);
  assert.equal((await tts.synthesize("a")).cached, false); // oldest evicted
});
