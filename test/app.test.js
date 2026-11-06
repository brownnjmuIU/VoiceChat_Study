import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { createTts } from "../src/tts.js";
import { createApp, validateMessages, rateLimiter } from "../src/app.js";

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
  assert.equal((await post("/api/speak", { text: "x".repeat(301) })).status, 400);
});

test("malformed JSON gets a JSON 400, never a stack trace", async () => {
  const res = await fetch(base + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.doesNotMatch(text, /at .*\.js|node_modules|SyntaxError/);
  assert.equal(JSON.parse(text).error, "Malformed request.");
});

test("security headers are set and x-powered-by is hidden", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'.*frame-ancestors 'self' https:\/\/\*\.qualtrics\.com/);
});

test("study token gate, when configured", async () => {
  const cfg = loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "mock", STUDY_TOKEN: "s3cret" });
  const app = createApp({ config: cfg, llm: createLlm(cfg.llm), tts: createTts(cfg.tts) });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const chat = (headers) => fetch(url + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  try {
    assert.equal((await chat({})).status, 401);
    assert.equal((await chat({ "X-Study-Token": "wrong!" })).status, 401);
    assert.equal((await chat({ "X-Study-Token": "s3cret" })).status, 200);
    assert.equal((await fetch(url + "/api/config")).status, 200); // page can still boot
  } finally { srv.close(); }
});

test("rate limiter sweep keeps live counters", () => {
  let t = 0;
  const mw = rateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  const hit = (ip) => { let code = 200; mw({ ip }, { status: (c) => ((code = c), { json() {} }) }, () => {}); return code; };
  assert.equal(hit("victim"), 200);
  for (let i = 0; i < 10_001; i++) hit(`spoof-${i}`); // overflow the map inside the window
  assert.equal(hit("victim"), 429); // counter survived; old code cleared it
});

test("LLM output is capped by default", () => {
  assert.equal(loadConfig({ LLM_MOCK: "1" }).llm.maxTokens, 1024);
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
