import OpenAI from "openai";
import { encodeWav } from "./wav.js";

// -----------------------------------------------------------------------------
// Text -> WAV bytes. Three interchangeable backends behind one interface:
//
//   kokoro  Kokoro-82M (Apache-2.0, open weights) running INSIDE this Node
//           process via kokoro-js/onnxruntime. No third party ever sees the
//           text, every participant hears the identical voice. Default.
//   openai  Any OpenAI-compatible POST /v1/audio/speech server. That covers
//           OpenAI itself AND Kokoro-FastAPI, which is how the voice moves to
//           IU hardware next to REALLMS without touching this code.
//   mock    A short tone. For tests and local dev without the model.
//
// All backends return WAV so the browser only ever handles one format.
// -----------------------------------------------------------------------------

export class TtsBusyError extends Error {
  constructor() {
    super("Speech queue is full");
    this.status = 503;
  }
}

export function createTts(ttsConfig, { engine } = {}) {
  const impl = engine ?? pickEngine(ttsConfig);
  const cache = new Map(); // insertion-ordered -> cheap LRU
  const maxBytes = ttsConfig.cacheBytes ?? Infinity;
  let cacheBytes = 0;
  let chain = Promise.resolve();
  let pending = 0;

  async function synthesize(text) {
    const key = `${ttsConfig.voice}|${ttsConfig.speed}|${text}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit); // refresh recency
      return { wav: hit, cached: true };
    }

    // One synthesis at a time. ONNX already uses every core it has; running
    // two in parallel on a 1-CPU box just makes both slower. Excess requests
    // are refused fast instead of piling up behind each other.
    if (pending >= ttsConfig.maxQueue) throw new TtsBusyError();
    pending++;
    const job = chain.then(() => impl.speak(text, ttsConfig));
    chain = job.catch(() => {}); // one failure must not poison the queue
    try {
      const wav = await job;
      if (!cache.has(key) && wav.length <= maxBytes) {
        cache.set(key, wav);
        cacheBytes += wav.length;
      }
      // Evict oldest until both the entry and the byte limits hold.
      while (cache.size && (cache.size > ttsConfig.cacheEntries || cacheBytes > maxBytes)) {
        const [oldKey, oldWav] = cache.entries().next().value;
        cache.delete(oldKey);
        cacheBytes -= oldWav.length;
      }
      return { wav, cached: false };
    } finally {
      pending--;
    }
  }

  return {
    backend: impl.name,
    /** Start loading the model now so the first participant does not wait. */
    warm: () => impl.warm?.() ?? Promise.resolve(),
    status: () => ({ backend: impl.name, voice: ttsConfig.voice, ready: impl.ready?.() ?? true, queue: pending, cacheEntries: cache.size, cacheBytes }),
    synthesize,
  };
}

function pickEngine(c) {
  if (c.backend === "browser") return browserEngine();
  if (c.backend === "mock") return mockEngine();
  if (c.backend === "openai") return openaiEngine(c);
  return kokoroEngine(c);
}

// The browser speaks for itself (speechSynthesis), so the server makes no audio.
// /api/speak refuses in this mode and the page never calls it.
function browserEngine() {
  return {
    name: "browser",
    async speak() {
      throw new Error("Voice is generated in the browser; /api/speak is disabled");
    },
  };
}

function mockEngine() {
  return {
    name: "mock",
    async speak(text) {
      // ~45 ms per character, capped, so the browser queue behaves like the
      // real thing (longer text -> longer clip).
      const seconds = Math.min(8, Math.max(0.3, text.length * 0.045));
      const rate = 24000;
      const n = Math.round(seconds * rate);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = 0.08 * Math.sin((2 * Math.PI * 220 * i) / rate);
      return encodeWav(samples, rate);
    },
  };
}

function openaiEngine(c) {
  const client = new OpenAI({ apiKey: c.apiKey || "not-needed", baseURL: c.baseURL, maxRetries: 1, timeout: 60_000 });
  return {
    name: "openai",
    async speak(text) {
      const res = await client.audio.speech.create({
        model: c.model,
        voice: c.voice,
        input: text,
        response_format: "wav",
        speed: c.speed,
      });
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function kokoroEngine(c) {
  let loading = null;
  let tts = null;

  function load() {
    loading ??= (async () => {
      const t0 = Date.now();
      // Imported lazily so tests and the mock backend never pay for onnxruntime.
      const { env } = await import("@huggingface/transformers");
      env.cacheDir = c.cacheDir; // build step pre-downloads here, see scripts/
      const { KokoroTTS } = await import("kokoro-js");
      tts = await KokoroTTS.from_pretrained(c.kokoroModel, { dtype: c.kokoroDtype, device: "cpu" });
      if (!tts.voices[c.voice]) {
        throw new Error(`TTS_VOICE "${c.voice}" is not a Kokoro voice. Try af_heart, am_michael, bf_emma.`);
      }
      const mb = Math.round(process.memoryUsage().rss / 1e6);
      console.log(`Kokoro ${c.kokoroDtype} loaded in ${Date.now() - t0} ms, rss ${mb} MB, voice ${c.voice}`);
    })();
    // Let a failed load be retried on the next request instead of caching the failure.
    loading.catch((err) => {
      console.error("Kokoro failed to load:", err.message);
      loading = null;
    });
    return loading;
  }

  return {
    name: "kokoro",
    warm: load,
    ready: () => tts !== null,
    async speak(text) {
      await load();
      const t0 = Date.now();
      const audio = await tts.generate(text, { voice: c.voice, speed: c.speed });
      const secs = audio.audio.length / audio.sampling_rate;
      console.log(`tts ${text.length} chars -> ${secs.toFixed(1)} s audio in ${Date.now() - t0} ms`);
      return Buffer.from(audio.toWav());
    },
  };
}
