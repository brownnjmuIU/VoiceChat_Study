import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { createTts } from "../src/tts.js";
import { createApp } from "../src/app.js";
import { loadPolicies, buildSystemPrompt } from "../src/policy.js";
import { cleanResponseId, readIdentity } from "../src/ids.js";

/** In-memory store that records inserts and can be told to fail. */
function memoryStore() {
  const rows = { participants: [], chat_turns: [], client_events: [] };
  return {
    enabled: true,
    rows,
    fail: false,
    async insert(table, r) {
      if (this.fail) return { ok: false, queued: true };
      rows[table].push(...r);
      return { ok: true };
    },
    async ping() { return { ok: !this.fail }; },
    status() { return { enabled: true, ok: !this.fail }; },
  };
}

async function boot({ env = {}, llm, store = memoryStore(), systemPrompt } = {}) {
  const config = loadConfig({ LLM_MOCK: "1", TTS_BACKEND: "mock", ...env });
  const app = createApp({ config, llm: llm ?? createLlm(config.llm), tts: createTts(config.tts), store, systemPrompt });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { base, post, store, close: () => server.close() };
}

const id = { rid: "R_abcDEF12345", sessionId: "s-1", condition: "voice" };

test("every chat turn stores the user message and the reply, keyed for Qualtrics", async (t) => {
  const s = await boot();
  t.after(s.close);
  const res = await s.post("/api/chat", { ...id, clientMsgId: "m1", messages: [{ role: "user", content: "Does OpenAI train on my chats?" }] });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.saved, true);
  assert.equal(data.turn, 1);
  const [u, a] = s.store.rows.chat_turns;
  assert.equal(u.role, "user");
  assert.equal(u.content, "Does OpenAI train on my chats?");
  assert.equal(a.role, "assistant");
  assert.equal(a.content, data.reply);
  for (const r of [u, a]) {
    assert.equal(r.response_id, "R_abcDEF12345");
    assert.equal(r.session_id, "s-1");
    assert.equal(r.condition, "voice");
    assert.equal(r.client_msg_id, "m1");
    assert.equal(r.turn_index, 1);
  }
  assert.ok(a.latency_ms >= 0);
  assert.deepEqual(Object.keys(u).sort(), Object.keys(a).sort()); // PGRST102-safe
});

test("model failure still stores what the participant typed, plus the error", async (t) => {
  const llm = { model: "x", async complete() { throw Object.assign(new Error("down"), { status: 500 }); } };
  const s = await boot({ llm });
  t.after(s.close);
  const res = await s.post("/api/chat", { ...id, clientMsgId: "m2", messages: [{ role: "user", content: "hello?" }] });
  assert.equal(res.status, 502);
  assert.deepEqual(s.store.rows.chat_turns.map((r) => r.role), ["user", "error"]);
  assert.equal(s.store.rows.chat_turns[0].content, "hello?");
});

test("a database outage never breaks the chat; the page is told it was not saved", async (t) => {
  const store = memoryStore();
  store.fail = true;
  const s = await boot({ store });
  t.after(s.close);
  const res = await s.post("/api/chat", { ...id, clientMsgId: "m3", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).saved, false);
  const db = await fetch(s.base + "/healthz/db");
  assert.equal(db.status, 503);
});

test("long conversations: whole history accepted, only the recent tail goes to the model", async (t) => {
  let seen;
  const llm = { model: "spy", async complete(m) { seen = m; return "ok."; } };
  const s = await boot({ llm, env: { LLM_CONTEXT_MESSAGES: "4" }, systemPrompt: "SYS" });
  t.after(s.close);
  const messages = [];
  for (let i = 0; i < 60; i++) messages.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
  messages.push({ role: "user", content: "last" });
  const res = await s.post("/api/chat", { ...id, clientMsgId: "m4", messages });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 5); // system + 4
  assert.deepEqual(seen[0], { role: "system", content: "SYS" });
  assert.equal(seen.at(-1).content, "last");
  assert.equal(s.store.rows.chat_turns[0].turn_index, 61);
});

test("session row records condition, embed and code version", async (t) => {
  const s = await boot({ env: { APP_VERSION: "abc123" } });
  t.after(s.close);
  const res = await s.post("/api/session", { ...id, embedded: true }, { "User-Agent": "TestBrowser/1" });
  assert.equal(res.status, 200);
  const [p] = s.store.rows.participants;
  assert.equal(p.condition, "voice");
  assert.equal(p.in_qualtrics, true);
  assert.equal(p.app_version, "abc123");
  assert.equal(p.user_agent, "TestBrowser/1");
  assert.equal((await s.post("/api/session", { ...id, condition: "both" })).status, 400);
});

test("events: known types stored with seq, unknown types and bad seq dropped", async (t) => {
  const s = await boot();
  t.after(s.close);
  const res = await s.post("/api/events", {
    ...id,
    events: [
      { seq: 0, type: "page_load", t: Date.now(), detail: { embedded: true } },
      { seq: 1, type: "audio_replay", t: Date.now(), detail: {} },
      { seq: 2, type: "drop_table", t: Date.now() },
      { seq: -1, type: "send", t: Date.now() },
      { seq: 3, type: "voice_used", t: Date.now(), detail: { name: "x".repeat(5000) } },
    ],
  });
  const data = await res.json();
  assert.equal(data.accepted, 3);
  const rows = s.store.rows.client_events;
  assert.deepEqual(rows.map((r) => r.type), ["page_load", "audio_replay", "voice_used"]);
  assert.deepEqual(rows[2].detail, { truncated: true });
  assert.equal((await s.post("/api/events", { ...id, events: [] })).status, 400);
});

test("sendBeacon path: study token accepted from the body", async (t) => {
  const s = await boot({ env: { STUDY_TOKEN: "tok" } });
  t.after(s.close);
  const ev = { ...id, events: [{ seq: 0, type: "page_hide", t: Date.now() }] };
  assert.equal((await s.post("/api/events", ev)).status, 401);
  assert.equal((await s.post("/api/events", { ...ev, k: "tok" })).status, 200);
});

test("rate limit is per participant, so a shared lab IP does not block others", async (t) => {
  const s = await boot();
  t.after(s.close);
  const send = (sessionId, n) =>
    s.post("/api/chat", { ...id, sessionId, clientMsgId: `c${n}`, messages: [{ role: "user", content: "hi" }] });
  let last;
  for (let i = 0; i < 61; i++) last = await send("loop", i);
  assert.equal(last.status, 429);
  assert.equal((await send("other-participant", 0)).status, 200);
});

test("health shows the store state and app version", async (t) => {
  const s = await boot({ env: { APP_VERSION: "v9" } });
  t.after(s.close);
  const h = await (await fetch(s.base + "/healthz")).json();
  assert.equal(h.version, "v9");
  assert.equal(h.store.ok, true);
  assert.equal((await fetch(s.base + "/healthz/db")).status, 200);
});

test("ids: Qualtrics unresolved piping and junk become no-rid", () => {
  assert.equal(cleanResponseId("R_1a2b3c4d5e6f"), "R_1a2b3c4d5e6f");
  assert.equal(cleanResponseId("${e://Field/ResponseID}"), "no-rid");
  assert.equal(cleanResponseId(""), "no-rid");
  assert.equal(cleanResponseId("R_1; drop table"), "no-rid");
  assert.match(readIdentity({ sessionId: "s", condition: "radio" }).error, /condition/);
});

test("policy files are appended to the prompt; README is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "pol-"));
  writeFileSync(join(dir, "README.md"), "ignore me");
  writeFileSync(join(dir, "openai.md"), "OpenAI policy text");
  writeFileSync(join(dir, "anthropic.txt"), "Anthropic policy text");
  const docs = loadPolicies(dir, { log: {} });
  assert.deepEqual(docs.map((d) => d.name), ["anthropic", "openai"]);
  const p = buildSystemPrompt("BASE", docs);
  assert.match(p, /^BASE/);
  assert.match(p, /<policy name="openai">\nOpenAI policy text\n<\/policy>/);
  assert.doesNotMatch(p, /ignore me/);
  assert.equal(buildSystemPrompt("BASE", loadPolicies(join(dir, "missing"))), "BASE");
});
