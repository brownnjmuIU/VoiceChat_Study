// Run during the Render BUILD (see render.yaml) so the ~90 MB model ships with
// the deploy. Boot then loads from disk instead of downloading from Hugging
// Face on every cold start, and a Hugging Face outage cannot take the voice down.
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { createTts } from "../src/tts.js";

const config = loadConfig({ ...process.env, LLM_MOCK: "1", TTS_BACKEND: "kokoro" });
const tts = createTts(config.tts);
const t0 = Date.now();
const { wav } = await tts.synthesize("Model check.");
console.log(`Kokoro prefetched to ${config.tts.cacheDir}, test clip ${wav.length} bytes, ${Date.now() - t0} ms`);
