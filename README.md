# voice-text-study

Voice vs text chatbot for Nick Brown's **privacy-policy study** (Weeks 11–12). Participants read the OpenAI and Anthropic privacy policies in Qualtrics, then ask a chatbot to help them interpret them. Qualtrics randomly assigns each participant to one condition:

| Condition | What the participant gets |
|---|---|
| `text` | The reply is shown as words |
| `voice` | The same reply is spoken aloud with the words hidden, plus a play/stop/replay button |

The model, the prompt and the words are the same in both conditions. Only the reply channel changes. The hypothesis is that voice calms risk perceptions more than text.

Built on the Week 10 `voice-chat` app. This round adds **reliable data storage**: every turn and UI event is saved to Supabase and keyed by the Qualtrics ResponseID.

```
Qualtrics question (qualtrics/question.js)
   │ iframe: ?mode=<Condition>&rid=<ResponseID>&k=<STUDY_TOKEN>
   ▼
This app (Render) ──▶ IU REALLMS (gpt-oss-120b)          text replies
   │                  browser speechSynthesis            voice (default)
   ├──▶ Supabase: participants, chat_turns, client_events  (study data)
   └──▶ postMessage counts ──▶ Qualtrics embedded data    (export columns)
```

## What gets stored

| Table | One row per | Key columns |
|---|---|---|
| `participants` | page load (reloads show as extra rows) | response_id, session_id, condition, in_qualtrics, user_agent, app_version |
| `chat_turns` | message: `user`, `assistant`, or `error` (model failed; what they typed is still kept) | response_id, turn_index, role, content, latency_ms |
| `client_events` | UI event: voice_used, audio_start/replay/stop/end, send, reply, retry, slow_reply, tab hidden | response_id, seq, type, detail |

Views for analysis: `transcript_export` gives the readable transcript in order. `participant_summary` gives one row per participant with message counts, chat duration, replays, tab-hides and the voice used. Join both to the Qualtrics export on `response_id`.


Known limit: the retry queue lives in memory. Rows still queued when the server restarts are lost. Healthy is `queued: 0`.

If Supabase rejects a row permanently (a 4xx other than 408/429), the row is dropped and the server log records only the HTTP status, table and row count. **Participant messages never go to the logs.**

## Access and abuse limits

The app URL is public, and every `/api/chat` call spends the IU REALLMS key, so:

- **`STUDY_TOKEN` is required.** With a real LLM, the server refuses to boot without it. `/api/chat` and `/api/speak` reject any request without the token (401, "This study link is not valid"). The Qualtrics question passes it to the app as `?k=<token>`, so **set the same value on Render and in `qualtrics/question.js`.** Only `LLM_MOCK=1` runs without a token.
- **What the model sees.** The browser sends the conversation history with each message. The server keeps only `role` and `content` from each message (the request cannot set the system prompt or model settings). It sends the most recent 40 messages (`LLM_CONTEXT_MESSAGES`), and drops the oldest of those until they total no more than 40,000 characters. The newest message is always sent.
- **What gets stored.** Each request stores the newest user message and the reply. The earlier history the browser sends is not stored again, because those turns were already saved when they happened.
- **Rate limits.** 60 chat requests per session and 1,500 per IP per 10 minutes. The per-IP limit is generous because a campus lab puts many participants behind one address. Replies are capped at `LLM_MAX_TOKENS` (1024).

## Setup

1. **Supabase:** create a new project for this study only. In the SQL Editor, run `sql/schema.sql`. Under Settings > API, copy the Project URL and the `service_role` (secret) key.
2. **Policies:** put the exact policy text participants read into `policies/openai.md` and `policies/anthropic.md` (see `policies/README.md`).
3. **Local:**
   ```bash
   npm install
   cp .env.example .env    # fill LLM_API_KEY, STUDY_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
   npm start               # http://localhost:3000/?mode=voice&rid=R_localtest01&k=<STUDY_TOKEN>
   ```
   With no keys: `LLM_MOCK=1 npm start` (canned replies, nothing saved, no token needed).
4. **Render:** use **New > Blueprint** on the repo. Set `LLM_API_KEY`, `STUDY_TOKEN`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the dashboard. For `STUDY_TOKEN`, use a long random string, e.g. `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`. Check `/healthz` (`store.ok: true`) and `/healthz/db` (200).
5. **Qualtrics:** see `SURVEY_SETUP.md`. Put the same `STUDY_TOKEN` value in `qualtrics/question.js`.

`npm test` runs 50 offline tests (no network, no database).

## Voice backends

Unchanged from Week 10. `TTS_BACKEND=browser` (default) uses the participant's device voice. It is instant, but the **voice differs per device**, so each session logs a `voice_used` event and the voice name appears in `participant_summary`. `kokoro` gives everyone the same voice but runs slower than real time on Render CPUs. `openai` works with any OpenAI-compatible `/v1/audio/speech` server, for example Kokoro-FastAPI on IU hardware.

## Files

| Path | Role |
|---|---|
| `server.js` | Boot: config, policies to prompt, LLM, TTS, store, database ping and keep-alive |
| `src/config.js` | All env vars, validated at boot; the default (neutral) system prompt |
| `src/app.js` | Routes: `/api/session`, `/api/chat`, `/api/events`, `/api/speak`, `/api/config`, `/healthz`, `/healthz/db` |
| `src/store.js` | Supabase writer: idempotent inserts, retry queue, status |
| `src/ids.js` | ResponseID / session / condition validation |
| `src/policy.js` | Loads `policies/*.md` into the system prompt |
| `src/llm.js`, `src/tts.js`, `src/speech-text.js` | REALLMS client, voice backends, speech chunking |
| `public/` | Chat page: identity, event batching, retry, slow notice, counts to Qualtrics |
| `qualtrics/question.js` | Paste into the Qualtrics chatbot question |
| `sql/schema.sql` | Tables, RLS, export views |
