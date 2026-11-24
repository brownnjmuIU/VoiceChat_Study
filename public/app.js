// -----------------------------------------------------------------------------
// One page, two study conditions:
//   ?mode=text   reply shown as words (the Week 2 chatbot, unchanged)
//   ?mode=voice  same reply, spoken; words hidden unless ?transcript=1
// The user always TYPES. Only the reply channel changes.
// -----------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const log = $("log");
const form = $("form");
const input = $("input");
const send = $("send");
const reset = $("reset");
const empty = $("empty");

const params = new URLSearchParams(location.search);
// Study link token (?k=...). The server requires it with a real LLM (only LLM_MOCK=1 skips it).
const apiHeaders = { "Content-Type": "application/json", ...(params.get("k") && { "X-Study-Token": params.get("k") }) };
const serverConfig = await fetch("/api/config")
  .then((r) => r.json())
  .catch(() => ({ defaultMode: "voice", showTranscript: false, title: "Assistant" }));

const mode = ["text", "voice"].includes(params.get("mode")) ? params.get("mode") : serverConfig.defaultMode;
const showTranscript = params.has("transcript") ? params.get("transcript") === "1" : serverConfig.showTranscript;

document.title = serverConfig.title;
$("title").textContent = serverConfig.title;
document.body.dataset.mode = mode;
if (!serverConfig.showReset) reset.hidden = true;

// --- Study identity ----------------------------------------------------------
// rid = Qualtrics ResponseID (from qualtrics/question.js). Missing outside
// Qualtrics; the server stores those rows under "no-rid".
const newId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const identity = {
  rid: params.get("rid") ?? "",
  sessionId: newId(),
  condition: mode,
  ...(params.get("k") && { k: params.get("k") }),
};
const embedded = window.parent !== window;

// Parent page (Qualtrics) to report usage counts to. Only origins the server
// allows; counts only, never message text.
const parentOrigin = (() => {
  const po = params.get("po");
  return po && (serverConfig.parentOrigins ?? []).includes(po) ? po : null;
})();

// "browser" = the device's own speechSynthesis voice (instant, no server work).
// Anything else = WAV clips fetched from /api/speak (Kokoro, OpenAI-compatible).
const useBrowserVoice = serverConfig.ttsBackend === "browser";

// --- Event log -----------------------------------------------------------------
// Every UI event gets a sequence number and is sent to /api/events in batches
// (every few seconds, and with sendBeacon when the page is hidden or closed).
// window.voiceChat.events keeps a local copy for debugging.
const events = [];
const outbox = [];
let seq = 0;
const stats = { turns: 0, replays: 0, stops: 0, unsaved: 0 };

function track(type, detail = {}) {
  const e = { seq: seq++, type, t: Date.now(), detail };
  events.push(e);
  outbox.push(e);
  if (type === "audio_replay" || type === "audio_stop") {
    stats[type === "audio_replay" ? "replays" : "stops"]++;
    reportToParent();
  }
}

let flushing = false;
async function flushEvents() {
  if (flushing || !outbox.length) return;
  flushing = true;
  const batch = outbox.splice(0, 100);
  try {
    const res = await fetch("/api/events", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ ...identity, events: batch }),
    });
    if (!res.ok && res.status >= 500) throw new Error(String(res.status));
  } catch {
    outbox.unshift(...batch); // try again next tick; seq makes it idempotent
  } finally {
    flushing = false;
  }
}
setInterval(flushEvents, 4000);

function beaconEvents() {
  if (!outbox.length) return;
  const batch = outbox.splice(0, 100);
  const blob = new Blob([JSON.stringify({ ...identity, events: batch })], { type: "application/json" });
  if (!navigator.sendBeacon?.("/api/events", blob)) outbox.unshift(...batch);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    track("visibility_hidden");
    beaconEvents();
  } else track("visibility_visible");
});
window.addEventListener("pagehide", () => {
  track("page_hide");
  beaconEvents();
});

/** Usage counts -> Qualtrics embedded data (see qualtrics/question.js). */
function reportToParent() {
  if (!parentOrigin) return;
  window.parent.postMessage(
    { source: "voice-text-study", type: "stats", condition: mode, sessionId: identity.sessionId, ...stats },
    parentOrigin,
  );
}

window.voiceChat = { mode, showTranscript, backend: serverConfig.ttsBackend ?? "unknown", identity, events, stats };

// One participants row per page load. Retried quietly; the chat works either way.
(async function registerSession(attempt = 0) {
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ ...identity, embedded, showTranscript: mode === "voice" && showTranscript }),
    });
    if (!res.ok && res.status >= 500) throw new Error(String(res.status));
  } catch {
    if (attempt < 3) setTimeout(() => registerSession(attempt + 1), 3000 * (attempt + 1));
  }
})();
track("page_load", { embedded, showTranscript: mode === "voice" && showTranscript, ua: navigator.userAgent.slice(0, 200) });
reportToParent();

let messages = [];
let busy = false;

// --- Audio -------------------------------------------------------------------

let ctx = null;
let current = null; // { stop() } for whatever is playing now

/**
 * Must run inside the click/Enter handler. Browsers (iOS Safari especially)
 * only allow audio that was started or unlocked by a user gesture, and the
 * reply arrives seconds later in an async callback, long after the gesture.
 */
function unlockAudio() {
  if (useBrowserVoice) {
    // iOS Safari only lets speechSynthesis start from a gesture, too. A silent
    // empty utterance spoken now keeps the later real one allowed.
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    return;
  }
  ctx ??=new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  const silent = ctx.createBufferSource();
  silent.buffer = ctx.createBuffer(1, 1, 22050);
  silent.connect(ctx.destination);
  silent.start(0);
}

function stopAudio() {
  current?.stop();
  current = null;
  if (useBrowserVoice && "speechSynthesis" in window) speechSynthesis.cancel();
}

// --- Browser voice -----------------------------------------------------------

let voicePromise = null;

/**
 * Pick ONE voice and keep it. Voices differ per device, which is a study
 * confound, so choose deterministically (TTS_BROWSER_VOICE hint first, then
 * a natural en-US voice) and log the name that was used.
 */
function getVoice() {
  voicePromise ??= new Promise((resolve) => {
    const hint = (serverConfig.browserVoice ?? "").toLowerCase();
    const choose = () => {
      const voices = speechSynthesis.getVoices();
      if (!voices.length) return false;
      const en = voices.filter((v) => /^en[-_]US/i.test(v.lang));
      resolve(
        (hint && voices.find((v) => v.name.toLowerCase().includes(hint))) ||
          en.find((v) => /natural|online/i.test(v.name)) ||
          en.find((v) => /google us english|samantha|aria|jenny|zira/i.test(v.name)) ||
          en[0] ||
          voices[0],
      );
      return true;
    };
    if (choose()) return;
    speechSynthesis.addEventListener("voiceschanged", choose, { once: true });
    setTimeout(() => choose() || resolve(null), 1500); // no voices: use the default
  });
  return voicePromise;
}

/** Speak chunks one after another with speechSynthesis. No network, no store. */
function playBrowserChunks(chunks, ui) {
  let cancelled = false;
  current = {
    stop() {
      cancelled = true;
      speechSynthesis.cancel();
    },
  };
  return (async () => {
    ui.setSpeaking(true);
    try {
      if (!("speechSynthesis" in window)) throw new Error("This browser cannot speak replies.");
      const voice = await getVoice();
      track("voice_used", { name: voice?.name ?? "default", lang: voice?.lang ?? "", local: voice?.localService ?? null });
      for (const text of chunks) {
        if (cancelled) break;
        await new Promise((resolve, reject) => {
          const u = new SpeechSynthesisUtterance(text);
          if (voice) {
            u.voice = voice;
            u.lang = voice.lang;
          }
          u.rate = serverConfig.speed || 1;
          u.onend = resolve;
          u.onerror = (e) =>
            cancelled || e.error === "canceled" || e.error === "interrupted"
              ? resolve()
              : reject(new Error(`Browser voice failed (${e.error}).`));
          speechSynthesis.speak(u);
        });
      }
    } finally {
      ui.setSpeaking(false);
    }
  })();
}

async function fetchClip(text) {
  const res = await fetch("/api/speak", {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Voice request failed (${res.status}).`);
  }
  return ctx.decodeAudioData(await res.arrayBuffer());
}

/**
 * Play chunks in order. Clip i+1 is requested as soon as clip i has arrived,
 * so the next sentence is usually ready before the current one ends.
 * Decoded clips are kept on `store` so Replay never re-synthesises.
 */
function playChunks(chunks, store, ui) {
  if (useBrowserVoice) return playBrowserChunks(chunks, ui);
  let cancelled = false;
  let source = null;
  const load = (i) => (store[i] ??= fetchClip(chunks[i]).catch((e) => { store[i] = undefined; throw e; }));

  const done = (async () => {
    ui.setSpeaking(true);
    try {
      for (let i = 0; i < chunks.length && !cancelled; i++) {
        const buffer = await load(i);
        if (i + 1 < chunks.length) load(i + 1).catch(() => {}); // prefetch
        if (cancelled) break;
        await new Promise((resolve) => {
          source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.onended = resolve;
          source.start();
        });
      }
    } finally {
      ui.setSpeaking(false);
    }
  })();

  current = {
    stop() {
      cancelled = true;
      try { source?.stop(); } catch {}
    },
  };
  return done;
}

// --- Rendering ---------------------------------------------------------------

// textContent, never innerHTML: model output is untrusted text.
function addBubble(role, text) {
  empty.remove?.();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
const STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>';

function addVoiceBubble(reply, chunks) {
  empty.remove?.();
  const el = document.createElement("div");
  el.className = "msg assistant voice";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "play";

  const meta = document.createElement("div");
  meta.className = "meta";
  const bars = document.createElement("div");
  bars.className = "bars";
  for (let i = 0; i < 18; i++) bars.appendChild(document.createElement("span"));
  const label = document.createElement("div");
  label.className = "label";
  meta.append(bars, label);

  if (showTranscript) {
    const tx = document.createElement("div");
    tx.className = "transcript";
    tx.textContent = reply;
    meta.appendChild(tx);
  }

  el.append(btn, meta);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;

  const store = [];
  let playing = false;
  const ui = {
    setSpeaking(on) {
      playing = on;
      el.classList.toggle("speaking", on);
      btn.innerHTML = on ? STOP : PLAY;
      btn.setAttribute("aria-label", on ? "Stop" : "Play reply");
      label.textContent = on ? "Speaking…" : "Voice reply";
    },
    error(msg) {
      label.textContent = msg + " Tap play to retry.";
    },
  };
  ui.setSpeaking(false);

  const play = (kind) => {
    stopAudio();
    track(kind, { chunks: chunks.length });
    return playChunks(chunks, store, ui)
      .then(() => track("audio_end"))
      .catch((e) => {
        track("audio_error", { message: e.message });
        ui.error(e.message);
      });
  };

  btn.addEventListener("click", () => {
    if (playing) {
      stopAudio();
      track("audio_stop");
    } else {
      unlockAudio();
      play("audio_replay");
    }
  });

  return { autoplay: () => play("audio_start") };
}

function setBusy(state) {
  busy = state;
  send.disabled = state;
  input.disabled = state;
  if (!state) input.focus();
}

// --- Input -------------------------------------------------------------------

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

reset.addEventListener("click", () => {
  stopAudio();
  messages = [];
  log.innerHTML = "";
  log.appendChild(empty);
  track("reset");
  input.focus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;

  if (mode === "voice") unlockAudio(); // inside the gesture, see unlockAudio()
  stopAudio();

  addBubble("user", text);
  messages.push({ role: "user", content: text });
  input.value = "";
  input.style.height = "auto";
  setBusy(true);
  track("send", { chars: text.length });

  const pending = document.createElement("div");
  pending.className = "typing";
  pending.textContent = "Thinking…";
  log.appendChild(pending);
  log.scrollTop = log.scrollHeight;

  // Long answers from REALLMS can take ~30 s. Say so, so it never looks frozen.
  const slowTimer = setTimeout(() => {
    pending.textContent = "Still thinking. Longer answers can take up to 30 seconds…";
    track("slow_reply");
  }, 12_000);

  try {
    const { res, data } = await postChat(messages);
    clearTimeout(slowTimer);
    pending.remove();

    if (!res.ok) {
      track("reply_error", { status: res.status });
      addBubble("error", data.error ?? `Request failed (${res.status}).`);
      messages.pop(); // so a retry does not resend a broken history
      return;
    }

    messages.push({ role: "assistant", content: data.reply });
    stats.turns++;
    if (data.saved === false) stats.unsaved++;
    track("reply", { chars: data.reply.length, chunks: data.chunks?.length ?? 0, saved: data.saved });
    reportToParent();

    if (mode === "voice" && data.chunks?.length) {
      addVoiceBubble(data.reply, data.chunks).autoplay();
    } else {
      addBubble("assistant", data.reply);
    }
  } catch {
    clearTimeout(slowTimer);
    pending.remove();
    track("reply_error", { status: 0 });
    addBubble("error", "Could not reach the assistant. Check your connection and send your message again.");
    messages.pop();
  } finally {
    setBusy(false);
    flushEvents();
  }
});

/**
 * POST /api/chat with a timeout, retrying ONCE on a network error or a 502/503/504.
 * The same clientMsgId is reused, so the server stores the turn at most once.
 */
async function postChat(history) {
  const clientMsgId = newId();
  const attempt = async () => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ ...identity, clientMsgId, messages: history }),
      signal: AbortSignal.timeout?.(100_000),
    });
    return { res, data: await res.json().catch(() => ({})) };
  };
  try {
    const r = await attempt();
    if (![502, 503, 504].includes(r.res.status)) return r;
  } catch {
    /* network error or timeout: fall through to one retry */
  }
  track("retry");
  await new Promise((r) => setTimeout(r, 2000));
  return attempt();
}
