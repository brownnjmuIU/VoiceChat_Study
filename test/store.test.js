import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, normalizeSupabaseUrl, CONFLICT_KEYS } from "../src/store.js";

const quiet = { error() {}, log() {} };

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { ok: next < 400, status: next, text: async () => "boom" };
  };
  impl.calls = calls;
  return impl;
}

const cfg = { enabled: true, url: "https://p.supabase.co/rest/v1/", key: "service-key", timeoutMs: 1000 };

test("URL pasted with /rest/v1/ is normalised", () => {
  assert.equal(normalizeSupabaseUrl("https://p.supabase.co/rest/v1/"), "https://p.supabase.co");
  assert.equal(normalizeSupabaseUrl(" https://p.supabase.co "), "https://p.supabase.co");
});

test("insert posts with on_conflict + ignore-duplicates and the service key", async () => {
  const f = fakeFetch([201]);
  const store = createStore(cfg, { fetchImpl: f, log: quiet });
  const r = await store.insert("chat_turns", [{ a: 1 }, { a: 2 }]);
  assert.equal(r.ok, true);
  const { url, init } = f.calls[0];
  assert.equal(url, `https://p.supabase.co/rest/v1/chat_turns?on_conflict=${CONFLICT_KEYS.chat_turns}`);
  assert.match(init.headers.Prefer, /resolution=ignore-duplicates/);
  assert.equal(init.headers.apikey, "service-key");
  assert.equal(store.status().written, 2);
  assert.equal(store.status().ok, true);
});

test("a failed write never throws, is queued, retried, and visible in status", async () => {
  const f = fakeFetch([503, 201]);
  const store = createStore(cfg, { fetchImpl: f, log: quiet });
  const r = await store.insert("participants", [{ x: 1 }]);
  assert.deepEqual(r, { ok: false, queued: true });
  let s = store.status();
  assert.equal(s.ok, false);
  assert.equal(s.queued, 1);
  assert.match(s.lastError, /HTTP 503/);
  assert.ok(!JSON.stringify(s).includes("service-key"));
  store.stop();
  await store._drain();
  s = store.status();
  assert.equal(s.queued, 0);
  assert.equal(s.written, 1);
  assert.equal(s.ok, true);
  assert.deepEqual(f.calls[1].body, [{ x: 1 }]); // same rows re-sent
});

test("network errors (paused database) are queued too", async () => {
  const f = fakeFetch([new TypeError("fetch failed")]);
  const store = createStore(cfg, { fetchImpl: f, log: quiet });
  const r = await store.insert("client_events", [{ x: 1 }]);
  assert.equal(r.queued, true);
  store.stop();
});

test("permanent 4xx errors are dropped from the queue, not retried forever", async () => {
  const f = fakeFetch([503, 400]);
  const store = createStore(cfg, { fetchImpl: f, log: quiet });
  await store.insert("chat_turns", [{ bad: 1 }]);
  store.stop();
  await store._drain();
  assert.equal(store.status().queued, 0);
  assert.equal(store.status().written, 0);
});

test("rows with different keys are rejected (PostgREST PGRST102)", async () => {
  const f = fakeFetch([201]);
  const store = createStore(cfg, { fetchImpl: f, log: quiet });
  const r = await store.insert("chat_turns", [{ a: 1 }, { a: 1, b: 2 }]);
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0);
  store.stop();
});

test("ping reports a paused or unreachable database", async () => {
  const store = createStore(cfg, { fetchImpl: fakeFetch([540]), log: quiet });
  const r = await store.ping();
  assert.equal(r.ok, false);
  assert.match(r.error, /540/);
});

test("disabled store is a no-op", async () => {
  const store = createStore({ enabled: false });
  assert.equal((await store.insert("chat_turns", [{ a: 1 }])).skipped, true);
  assert.deepEqual(store.status(), { enabled: false });
});
