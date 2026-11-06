# voice-chat

Text-in, voice-out chatbot for the **text vs voice privacy-disclosure study** (Week 10). Users type; the assistant answers either in text or out loud. Same model, same prompt, same words in both conditions. Only the reply channel changes.

```
Browser ──typed message──▶ /api/chat ──▶ IU REALLMS (gpt-oss-120b)
   │                           │ reply + sentence chunks
   ▼                           ▼
 speaks each sentence with the device's own voice (default: TTS_BACKEND=browser)

 or, TTS_BACKEND=kokoro:  WAV per sentence ◀── /api/speak ──▶ Kokoro-82M (inside this server)
```

## Conditions

| URL | What the participant gets |
|---|---|
| `/?mode=text` | Reply shown as words (the Week 2 chatbot) |
| `/?mode=voice` | Reply spoken aloud, words hidden; play/stop/replay button |
| `/?mode=voice&transcript=1` | Spoken **and** shown as words |

`DEFAULT_MODE` and `SHOW_TRANSCRIPT` set the defaults when the URL says nothing.

## Run locally

```bash
npm install
cp .env.example .env      # add your REALLMS key to LLM_API_KEY
npm start                 # http://localhost:3000/?mode=voice
```

The default voice is the browser's own, so there is no model to download. For Kokoro, set `TTS_BACKEND=kokoro` and run `npm run prefetch-model` once (~90 MB).

No key handy? `LLM_MOCK=1 npm start` runs the whole UI with a canned reply.

## Voice backends

| `TTS_BACKEND` | Where the audio comes from | Notes |
|---|---|---|
| `browser` (default) | The participant's device (`speechSynthesis`) | Instant, free, no server load. **Voice differs per device and browser**, a study confound. Pin one with `TTS_BROWSER_VOICE`; the page logs the voice used as a `voice_used` event. Some voices (Edge "Online/Natural", Chrome "Google") are cloud voices, so text may leave the device. |
| `kokoro` | Kokoro-82M inside this server | Same voice for everyone, text stays on our server. Measured ~1.3-4x slower than real time on a laptop CPU, so it pauses between sentences; needs more CPU (or a GPU host). Run `npm run prefetch-model` first. |
| `openai` | Any OpenAI-compatible `/v1/audio/speech` server | OpenAI itself, or Kokoro-FastAPI on IU hardware. |
| `mock` | A beep | Tests and UI work. |

Switching is one env var (plus the build command on Render, see `render.yaml`).

`npm test` runs 23 offline tests (no network, no model).

## Deploy on Render

1. Push this folder to its own GitHub repo.
2. Render: **New > Blueprint**, pick the repo. `render.yaml` sets the build (`npm ci`), start, health check and env. For Kokoro, also change the build to `npm ci && npm run prefetch-model` (comment in the file).
3. Set `LLM_API_KEY` in the dashboard (it is marked `sync: false`, never in git).
4. Check `https://<service>.onrender.com/healthz`: `tts.backend` shows which voice is active (with Kokoro, `tts.ready` flips to `true` once it has loaded).

**Kokoro only, memory:** the boot log prints `Kokoro q8 loaded in N ms, rss N MB`. Free and Starter both have 512 MB. If the service restarts with an out-of-memory error, move to Standard (2 GB) or set `KOKORO_DTYPE=q4`.

## Moving the voice to IU later

`TTS_BACKEND=openai` + `TTS_BASE_URL` points at any OpenAI-compatible `/v1/audio/speech` server. [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) serves the same Kokoro model that way from a Docker image, so if UITS hosts it next to REALLMS the switch is an env change, and participants hear the same voice.

## Files

| Path | Role |
|---|---|
| `server.js` | Boot: config, LLM, TTS, start listening, warm the model |
| `src/config.js` | All env vars, validated at boot |
| `src/llm.js` | REALLMS client (OpenAI-compatible) + mock |
| `src/tts.js` | browser (no-op) / kokoro / openai / mock backends, one-at-a-time queue, LRU cache |
| `src/speech-text.js` | Strip markdown, split reply into sentence chunks |
| `src/app.js` | Routes: `/api/chat`, `/api/speak`, `/api/config`, `/healthz` |
| `public/` | Chat page; `window.voiceChat.events` records send/reply/play/replay/stop |
| `scripts/prefetch-model.js` | Downloads the model at build time |
