import { test } from "node:test";
import assert from "node:assert/strict";
import { toSpeakable, splitForSpeech } from "../src/speech-text.js";

test("toSpeakable strips markdown the model was told not to use", () => {
  const md = "## Risks\n- **Location** is _sensitive_\n- See [policy](https://x.y)\n\n```js\nx=1\n```\nDone 🎉";
  assert.equal(toSpeakable(md), "Risks\nLocation is sensitive\nSee policy\nDone");
});

test("toSpeakable leaves plain prose alone", () => {
  const s = "Sharing your data helps personalise results. It can also be misused.";
  assert.equal(toSpeakable(s), s);
});

test("bare URLs become 'a link'", () => {
  assert.equal(toSpeakable("Go to https://iu.edu/privacy now."), "Go to a link now.");
});

test("splitForSpeech splits on sentences and keeps punctuation", () => {
  const out = splitForSpeech("First sentence is here and long enough. Second one follows right after it! Third? Yes.", 300);
  assert.deepEqual(out, ["First sentence is here and long enough.", "Second one follows right after it!", "Third? Yes."]);
});

test("no chunk exceeds maxChars, nothing is lost", () => {
  const long = ("word ".repeat(50) + ", clause " + "x".repeat(120) + ". ").repeat(4);
  const out = splitForSpeech(long, 100);
  assert.ok(out.length > 4);
  for (const c of out) assert.ok(c.length <= 100 && c.length > 0, c);
  assert.equal(out.join(" ").replace(/\s+/g, ""), long.replace(/\s+/g, ""));
});

test("empty input gives no chunks", () => {
  assert.deepEqual(splitForSpeech("   "), []);
  assert.deepEqual(splitForSpeech(undefined), []);
});
