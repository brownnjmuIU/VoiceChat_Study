import "dotenv/config";
import { loadConfig } from "./src/config.js";
import { createLlm } from "./src/llm.js";
import { createTts } from "./src/tts.js";
import { createStore } from "./src/store.js";
import { loadPolicies, buildSystemPrompt } from "./src/policy.js";
import { createApp } from "./src/app.js";

let config, systemPrompt;
try {
  config = loadConfig();
  systemPrompt = buildSystemPrompt(config.systemPrompt, loadPolicies(config.study.policyDir));
} catch (err) {
  console.error(err.message);
  console.error("Copy .env.example to .env for local dev, or set the variables in the Render dashboard.");
  process.exit(1);
}

const llm = createLlm(config.llm);
const tts = createTts(config.tts);
const store = createStore(config.store);
const app = createApp({ config, llm, tts, store, systemPrompt });

// Render assigns PORT and health-checks it; bind 0.0.0.0, never localhost.
app.listen(config.port, "0.0.0.0", async () => {
  console.log(`Listening on :${config.port}, version ${config.appVersion}, model ${llm.model}, tts ${tts.backend}`);
  // Load the voice model in the background right after boot so the first
  // participant is not the one who waits ~10-20 s for it.
  tts.warm().catch(() => {});

  if (!store.enabled) {
    console.warn("STORE_DISABLED=1: study data is NOT being saved. Never deploy like this.");
    return;
  }
  // Fail loudly at boot if the database is paused or the key is wrong, instead
  // of finding out from a participant (the Religion-framing lesson).
  const first = await store.ping();
  console.log(first.ok ? "Supabase reachable." : `SUPABASE NOT REACHABLE: ${first.error}`);
  if (config.store.keepAliveHours > 0) {
    setInterval(async () => {
      const r = await store.ping();
      if (!r.ok) console.error(`Supabase keep-alive failed: ${r.error}`);
    }, config.store.keepAliveHours * 3600_000).unref();
  }
});
