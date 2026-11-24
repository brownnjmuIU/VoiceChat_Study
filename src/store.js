// -----------------------------------------------------------------------------
// Study data -> Supabase (PostgREST over plain fetch, no supabase-js).
//
// Design rules, learned the hard way on the Religion-framing study:
//   1. A database problem must never be silent. Every failure is logged, counted,
//      and shown on /healthz, so "chats are not saving" is visible in seconds.
//   2. A database problem must never break the chat for a participant. Failed
//      writes go into an in-memory retry queue and are retried with backoff.
//   3. Writes are idempotent. Every row carries a natural key and is inserted
//      with "ignore duplicates", so a browser retry or a queue retry can never
//      create a second copy of the same message.
//
// Limits worth knowing: the retry queue lives in memory, so rows still queued
// when the server restarts are lost. /healthz shows `queued`; it should be 0.
// -----------------------------------------------------------------------------

/** Natural keys used for "on_conflict". Must match the UNIQUE constraints in sql/schema.sql. */
export const CONFLICT_KEYS = {
  participants: "response_id,session_id",
  chat_turns: "response_id,session_id,client_msg_id,role",
  client_events: "response_id,session_id,seq",
};

const MAX_QUEUE = 5000;

/** "https://x.supabase.co/rest/v1/" -> "https://x.supabase.co" (a Week 8 mistake). */
export function normalizeSupabaseUrl(url) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/, "");
}

export function createStore(storeConfig, { fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
  if (!storeConfig?.enabled) {
    return {
      enabled: false,
      async insert() {
        return { ok: true, skipped: true };
      },
      async ping() {
        return { ok: true, skipped: true };
      },
      status: () => ({ enabled: false }),
      stop() {},
    };
  }

  const base = normalizeSupabaseUrl(storeConfig.url);
  const timeoutMs = storeConfig.timeoutMs ?? 5000;
  const headers = {
    apikey: storeConfig.key,
    Authorization: `Bearer ${storeConfig.key}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=ignore-duplicates",
  };

  const stats = { written: 0, failed: 0, lastError: null, lastErrorAt: null, lastOkAt: null, lastCallOk: true };
  const queue = []; // { table, rows, attempts }
  let timer = null;

  async function send(table, rows) {
    const onConflict = CONFLICT_KEYS[table];
    if (!onConflict) throw new Error(`Unknown table "${table}"`);
    // PostgREST bulk insert needs every row to have the same keys (PGRST102).
    const keys = Object.keys(rows[0]).sort().join(",");
    for (const r of rows) {
      if (Object.keys(r).sort().join(",") !== keys) throw new Error(`Rows for ${table} have different columns`);
    }
    const res = await fetchImpl(`${base}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers,
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Supabase ${table} insert failed: HTTP ${res.status} ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
  }

  function recordOk() {
    stats.lastCallOk = true;
    stats.lastOkAt = new Date(now()).toISOString();
  }

  function recordError(err) {
    stats.lastCallOk = false;
    stats.failed++;
    stats.lastError = err.message;
    stats.lastErrorAt = new Date(now()).toISOString();
    log.error(`[store] ${err.message}`);
  }

  function enqueue(table, rows, attempts) {
    if (queue.length >= MAX_QUEUE) {
      log.error(`[store] retry queue full, DROPPING ${rows.length} ${table} row(s)`);
      return;
    }
    queue.push({ table, rows, attempts });
    schedule();
  }

  function schedule() {
    if (timer || !queue.length) return;
    const attempts = queue[0].attempts;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(attempts, 5));
    timer = setTimeout(drain, delay);
    timer.unref?.();
  }

  async function drain() {
    timer = null;
    while (queue.length) {
      const item = queue[0];
      try {
        await send(item.table, item.rows);
        queue.shift();
        stats.written += item.rows.length;
        recordOk();
      } catch (err) {
        item.attempts++;
        recordError(err);
        // 4xx other than 408/429 = the request itself is wrong (bad column, bad
        // key). Retrying forever will not fix it; keep it in the log and move on.
        if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
          // Never log row contents: chat_turns rows hold participant messages.
          log.error(`[store] permanent error (HTTP ${err.status}), dropping ${item.rows.length} ${item.table} row(s); contents not logged`);
          queue.shift();
          continue;
        }
        break;
      }
    }
    schedule();
  }

  return {
    enabled: true,
    /**
     * Insert rows. Resolves { ok } and NEVER throws: on failure the rows are
     * queued for retry, so callers can await it without risking the chat.
     */
    async insert(table, rows) {
      if (!rows?.length) return { ok: true };
      try {
        await send(table, rows);
        stats.written += rows.length;
        recordOk();
        return { ok: true };
      } catch (err) {
        recordError(err);
        enqueue(table, rows, 1);
        return { ok: false, queued: true };
      }
    },
    /** Cheap read to prove the database is awake and the key works. */
    async ping() {
      try {
        const res = await fetchImpl(`${base}/rest/v1/participants?select=response_id&limit=1`, {
          headers: { apikey: storeConfig.key, Authorization: `Bearer ${storeConfig.key}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw Object.assign(new Error(`Supabase ping failed: HTTP ${res.status}`), { status: res.status });
        recordOk();
        return { ok: true };
      } catch (err) {
        recordError(err);
        return { ok: false, error: err.message };
      }
    },
    status: () => ({
      enabled: true,
      // Healthy = nothing waiting to be retried and the last call worked.
      ok: queue.length === 0 && stats.lastCallOk,
      queued: queue.reduce((n, q) => n + q.rows.length, 0),
      written: stats.written,
      failed: stats.failed,
      lastOkAt: stats.lastOkAt,
      lastErrorAt: stats.lastErrorAt,
      // Error text can include table/column names but never the key.
      lastError: stats.lastError,
    }),
    stop() {
      clearTimeout(timer);
      timer = null;
    },
    _queue: queue, // tests only
    _drain: drain, // tests only
  };
}
