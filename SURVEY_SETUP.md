# Qualtrics setup: Voice vs Text privacy-policy study

Nick's requested flow: (1) privacy policies, (2) instructions, (3) the voice or text chatbot. Each participant gets one chatbot. Nick adds his own questions afterwards.

## Survey Flow

```
Embedded Data   Condition (blank), __js_chat_session, __js_chat_turns, __js_chat_replays,
                __js_chat_stops, __js_chat_unsaved, __js_chat_seconds, __js_chat_condition_error
Block           1. Privacy policies
Block           2. Instructions
Randomizer      Randomly present 1 of 2, [x] Evenly Present Elements
  ├ Embedded Data   Condition = voice
  └ Embedded Data   Condition = text
Block           3. Chatbot
(Nick's blocks)
```

- Declare the `__js_` fields in the first Embedded Data element. Qualtrics only exports fields that are declared in the flow.
- The Randomizer must come **before** the Chatbot block. If it's missing, the question script falls back to `text` and sets `__js_chat_condition_error = 1`, so a broken flow shows up in the data.
- `Condition` is also in the export, so every response carries its assigned condition even if the participant never sent a message.

## Block 1: Privacy policies

- One Text/Graphic question per policy (OpenAI, then Anthropic). Paste the policy text, or a scrollable box containing it.
- Use the **same text** that is in `policies/openai.md` and `policies/anthropic.md` in the app, so the chatbot answers from exactly what the participant read. Record the date you copied each policy.
- Optional: a Timing question to measure reading time.

## Block 2: Instructions

Suggested wording (Nick to finalize):

> On the next page you will have access to an AI assistant. Please use it to help you understand the privacy policies you just read: for example, what information is collected, how it is used or shared, and what choices you have. Ask it anything you like. When you are finished, click Next.

For the voice condition, consider adding: "Turn your sound on. The assistant will answer out loud." Because the Randomizer runs after this block, that line would have to go into the Chatbot block or use display logic on `Condition = voice`.

## Block 3: Chatbot

1. Add a **Text / Graphic** question. Text: a short line such as "Ask the assistant about the privacy policies."
2. Click the question's **JavaScript (</>)** icon, delete everything in it, and paste in `qualtrics/question.js`.
3. Set `APP_URL` at the top to the Render URL, and `STUDY_TOKEN` to the **same value** as `STUDY_TOKEN` on Render. If the token is missing or wrong, the chatbot shows "This study link is not valid" and the participant cannot chat.
4. Optional: set `MIN_SECONDS = 600` to hide Next for 10 minutes. That forces a full 10-minute interaction. Nick should decide whether to require it or just measure it (`__js_chat_seconds` is recorded either way).
5. Put this question on its **own page**.

## Check before sending the link

Do two runs with **Preview**: one forced to voice and one forced to text. To force a condition temporarily, set `Condition` directly in the top Embedded Data element and disable the Randomizer. Then undo that. In each run:

1. Send two or three messages and confirm you get replies (if you see "This study link is not valid", the `STUDY_TOKEN` values don't match). In voice, confirm you hear the reply, then press Replay once.
2. Finish the survey.
3. **Qualtrics > Data & Analysis:** open the response. `Condition` should match what you saw, `__js_chat_turns` should match the number of messages you sent, and `__js_chat_unsaved` should be 0.
4. **Supabase > Table Editor > participant_summary:** find the same `response_id`. The condition, `user_messages` and `replays` should match.
5. Open `https://<app>/healthz` and confirm `store.ok: true` and `queued: 0`.

