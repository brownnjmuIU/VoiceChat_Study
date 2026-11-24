/* =============================================================================
 * Voice vs Text study: Qualtrics question JavaScript.
 *
 * Paste into the chatbot question: question > JavaScript (</> icon) > replace
 * everything with this file. Use a "Text / Graphic" question.
 *
 * Needs STUDY_TOKEN below set to the same value as STUDY_TOKEN on Render;
 * without it every chat request is rejected ("This study link is not valid").
 *
 * Needs, in Survey Flow ABOVE the chatbot block:
 *   Randomizer (1 element, evenly present) with two Embedded Data elements:
 *     Condition = voice      and      Condition = text
 *   Embedded Data (anywhere above): __js_chat_turns, __js_chat_replays,
 *     __js_chat_stops, __js_chat_unsaved, __js_chat_session, __js_chat_seconds
 *     (leave values blank; Qualtrics only exports fields declared in the flow)
 *
 * What it does:
 *   - Embeds the chatbot (a separate app on Render) in an iframe, passing the
 *     ResponseID and the randomized Condition, so every saved row in Supabase
 *     joins back to this response.
 *   - Receives usage counts from the app and writes them to embedded data, so
 *     the normal Qualtrics export has them next to Nick's survey questions.
 *   - Optional: hides Next until the participant has spent MIN_SECONDS here.
 * ========================================================================== */

Qualtrics.SurveyEngine.addOnload(function () {
  // ---- Settings -------------------------------------------------------------
  var APP_URL = "https://YOUR-SERVICE.onrender.com"; // no trailing slash
  var STUDY_TOKEN = ""; // REQUIRED: same value as STUDY_TOKEN on Render
  var MIN_SECONDS = 0; // e.g. 600 to keep Next hidden for 10 minutes
  var HEIGHT = "620px";
  // ---------------------------------------------------------------------------

  var q = this;
  var rid = "${e://Field/ResponseID}";
  var condition = "${e://Field/Condition}";
  if (condition !== "voice" && condition !== "text") {
    // Randomizer missing or Preview started mid-survey. Fail visibly, not silently.
    console.error("[voice-text-study] Condition embedded data is missing:", condition);
    condition = "text";
    Qualtrics.SurveyEngine.setJSEmbeddedData("chat_condition_error", "1");
  }
  if (!STUDY_TOKEN) {
    // The server requires the token; without it the chatbot cannot reply.
    console.error("[voice-text-study] STUDY_TOKEN is empty in the question JavaScript; chat requests will be rejected.");
  }
  // Unresolved piped text arrives as the literal "${e://...}"; the app treats it as no-rid.
  if (rid.indexOf("${") === 0) rid = "";

  var appOrigin = new URL(APP_URL).origin;
  var src =
    APP_URL +
    "/?mode=" + encodeURIComponent(condition) +
    "&rid=" + encodeURIComponent(rid) +
    "&po=" + encodeURIComponent(window.location.origin) +
    (STUDY_TOKEN ? "&k=" + encodeURIComponent(STUDY_TOKEN) : "");

  var frame = document.createElement("iframe");
  frame.src = src;
  frame.title = "Assistant";
  frame.setAttribute("allow", "autoplay");
  frame.style.width = "100%";
  frame.style.height = HEIGHT;
  frame.style.border = "1px solid #d1d5db";
  frame.style.borderRadius = "12px";
  frame.style.display = "block";

  var container = q.getQuestionContainer();
  container.appendChild(frame);

  // Slow-start safety net: if the app has not reported in after 20 s, say so.
  var loaded = false;
  var note = document.createElement("div");
  note.style.cssText = "font-size:13px;color:#6b7280;margin-top:6px";
  container.appendChild(note);
  setTimeout(function () {
    if (!loaded) note.textContent = "The assistant is still loading. Please wait a moment.";
  }, 20000);

  var started = Date.now();
  Qualtrics.SurveyEngine.setJSEmbeddedData("chat_seconds", "0");

  window.addEventListener("message", function (e) {
    if (e.origin !== appOrigin || !e.data || e.data.source !== "voice-text-study") return;
    loaded = true;
    note.textContent = "";
    var d = e.data;
    Qualtrics.SurveyEngine.setJSEmbeddedData("chat_session", String(d.sessionId || ""));
    Qualtrics.SurveyEngine.setJSEmbeddedData("chat_turns", String(d.turns || 0));
    Qualtrics.SurveyEngine.setJSEmbeddedData("chat_replays", String(d.replays || 0));
    Qualtrics.SurveyEngine.setJSEmbeddedData("chat_stops", String(d.stops || 0));
    Qualtrics.SurveyEngine.setJSEmbeddedData("chat_unsaved", String(d.unsaved || 0));
  });

  if (MIN_SECONDS > 0) {
    q.hideNextButton();
    setTimeout(function () {
      q.showNextButton();
    }, MIN_SECONDS * 1000);
  }

  // Time on the chatbot page, recorded when they leave it.
  Qualtrics.SurveyEngine.addOnPageSubmit(function () {
    Qualtrics.SurveyEngine.setJSEmbeddedData("chat_seconds", String(Math.round((Date.now() - started) / 1000)));
  });
});
