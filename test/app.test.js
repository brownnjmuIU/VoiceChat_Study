import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { createTts } from "../src/tts.js";
import { createApp, validateMessages } from "../src/app.js";

let server, base;
const config = loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "mock" });

before(async () => {
  const app = createApp({ config, llm: createLlm(config.llm), tts: createTts(config.tts) });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("chat returns the reply and speakable chunks", async () => {
  const res = await post("/api/chat", { messages: [{ role: "user", content: "Should I share my location?" }] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.reply, /mock reply/);
  assert.ok(data.chunks.length >= 2);
  for (const c of data.chunks) assert.ok(c.length <= 300);
});

test("chat validates input", async () => {
  assert.equal((await post("/api/chat", {})).status, 400);
  assert.equal((await post("/api/chat", { messages: [{ role: "system", content: "x" }] })).status, 400);
  assert.match(validateMessages([{ role: "assistant", content: "hi" }]), /last message/);
});

test("speak returns audio/wav", async () => {
  const res = await post("/api/speak", { text: "Hello." });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/wav");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
});

test("speak rejects empty and oversized text", async () => {
  assert.equal((await post("/api/speak", { text: "  " })).status, 400);
  assert.equal((await post("/api/speak", { text: "x".repeat(601) })).status, 400);
});

test("config and health expose what the deploy is running, no secrets", async () => {
  const cfg = await (await fetch(base + "/api/config")).json();
  assert.equal(cfg.defaultMode, "voice");
  assert.equal(cfg.ttsBackend, "mock");
  const health = await (await fetch(base + "/healthz")).json();
  assert.equal(health.ok, true);
  assert.equal(health.tts.backend, "mock");
  assert.ok(!JSON.stringify({ cfg, health }).toLowerCase().includes("key"));
});

test("static page is served", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /app\.js/);
});

test("browser backend: server makes no audio and tells the page to speak", async () => {
  const cfg = loadConfig({ LLM_MOCK: "1", TTS_BROWSER_VOICE: "Aria", TTS_SPEED: "1.1" });
  const app = createApp({ config: cfg, llm: createLlm(cfg.llm), tts: createTts(cfg.tts) });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const speak = await fetch(url + "/api/speak", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hello." }),
    });
    assert.equal(speak.status, 404);
    const c = await (await fetch(url + "/api/config")).json();
    assert.equal(c.ttsBackend, "browser");
    assert.equal(c.browserVoice, "Aria");
    assert.equal(c.speed, 1.1);
    // chat still returns the sentence chunks the browser will speak
    const chat = await fetch(url + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.ok((await chat.json()).chunks.length >= 2);
  } finally { srv.close(); }
});
