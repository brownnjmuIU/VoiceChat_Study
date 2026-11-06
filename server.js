import "dotenv/config";
import { loadConfig } from "./src/config.js";
import { createLlm } from "./src/llm.js";
import { createTts } from "./src/tts.js";
import { createApp } from "./src/app.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  console.error("Copy .env.example to .env for local dev, or set the variables in the Render dashboard.");
  process.exit(1);
}

const llm = createLlm(config.llm);
const tts = createTts(config.tts);
const app = createApp({ config, llm, tts });

// Render assigns PORT and health-checks it; bind 0.0.0.0, never localhost.
app.listen(config.port, "0.0.0.0", () => {
  console.log(`Listening on :${config.port}, model ${llm.model}, tts ${tts.backend}`);
  // Load the voice model in the background right after boot so the first
  // participant is not the one who waits ~10-20 s for it.
  tts.warm().catch(() => {});
});
