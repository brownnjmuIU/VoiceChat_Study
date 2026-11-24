// -----------------------------------------------------------------------------
// Who is this request from? Every stored row is keyed by:
//   response_id  Qualtrics ResponseID (R_xxxx), piped in by qualtrics/question.js.
//                Outside Qualtrics (local dev, a direct link) the page sends
//                "no-rid" and the rows are still saved, just easy to filter out.
//   session_id   Random id made by the page on every load. A reload inside the
//                survey = same response_id, new session_id, so reloads are visible.
//   client_msg_id / seq  Per-message / per-event ids that make retries idempotent.
// -----------------------------------------------------------------------------

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export const NO_RID = "no-rid";
export const CONDITIONS = ["text", "voice"];

/** Returns a cleaned id, or null when the value is missing or unsafe. */
export function cleanId(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return SAFE.test(v) ? v : null;
}

/**
 * Qualtrics pipes "${e://Field/ResponseID}" as literal text when it cannot
 * resolve it, and an empty string in some previews. Treat both as "no rid".
 */
export function cleanResponseId(value) {
  const v = cleanId(value);
  return v ?? NO_RID;
}

export function cleanCondition(value) {
  return CONDITIONS.includes(value) ? value : null;
}

/** Pull and validate the identity fields every study request carries. */
export function readIdentity(body) {
  const sessionId = cleanId(body?.sessionId);
  const condition = cleanCondition(body?.condition);
  if (!sessionId) return { error: 'Missing or invalid "sessionId".' };
  if (!condition) return { error: 'Missing or invalid "condition" (text or voice).' };
  return { responseId: cleanResponseId(body?.rid), sessionId, condition };
}
