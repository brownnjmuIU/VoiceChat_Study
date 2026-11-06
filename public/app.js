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
const serverConfig = await fetch("/api/config")
  .then((r) => r.json())
  .catch(() => ({ defaultMode: "voice", showTranscript: false, title: "Assistant" }));

const mode = ["text", "voice"].includes(params.get("mode")) ? params.get("mode") : serverConfig.defaultMode;
const showTranscript = params.has("transcript") ? params.get("transcript") === "1" : serverConfig.showTranscript;

document.title = serverConfig.title;
$("title").textContent = serverConfig.title;
document.body.dataset.mode = mode;

// "browser" = the device's own speechSynthesis voice (instant, no server work).
// Anything else = WAV clips fetched from /api/speak (Kokoro, OpenAI-compatible).
const useBrowserVoice = serverConfig.ttsBackend === "browser";

// Small, inspectable event trail (window.voiceChat.events). Nothing is sent
// anywhere; it exists so a later Qualtrics embed can read play/replay counts.
const events = [];
const track = (type, detail = {}) => events.push({ type, t: Date.now(), ...detail });
window.voiceChat = { mode, showTranscript, backend: serverConfig.ttsBackend ?? "unknown", events };

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
    headers: { "Content-Type": "application/json" },
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

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json().catch(() => ({}));
    pending.remove();

    if (!res.ok) {
      addBubble("error", data.error ?? `Request failed (${res.status}).`);
      messages.pop(); // so a retry does not resend a broken history
      return;
    }

    messages.push({ role: "assistant", content: data.reply });
    track("reply", { chars: data.reply.length, chunks: data.chunks?.length ?? 0 });

    if (mode === "voice" && data.chunks?.length) {
      addVoiceBubble(data.reply, data.chunks).autoplay();
    } else {
      addBubble("assistant", data.reply);
    }
  } catch {
    pending.remove();
    addBubble("error", "Could not reach the server. Check your connection and try again.");
    messages.pop();
  } finally {
    setBusy(false);
  }
});
