import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

// -----------------------------------------------------------------------------
// Grounding: the participant reads specific versions of the OpenAI and
// Anthropic privacy policies in Qualtrics. Put the SAME text in policies/*.md
// (or .txt) and it is appended to the system prompt, so the chatbot answers
// from what the participant actually read instead of from model memory.
// Both conditions get the identical prompt.
// -----------------------------------------------------------------------------

const MAX_CHARS = 200_000; // ~50k tokens; gpt-oss-120b has room, but keep it sane

export function loadPolicies(dir, { log = console } = {}) {
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => [".md", ".txt"].includes(extname(f).toLowerCase()) && !f.startsWith("_") && f.toLowerCase() !== "readme.md")
    .sort();
  const docs = files
    .map((f) => ({ name: basename(f, extname(f)), text: readFileSync(join(dir, f), "utf8").trim() }))
    .filter((d) => d.text);
  const total = docs.reduce((n, d) => n + d.text.length, 0);
  if (total > MAX_CHARS) {
    throw new Error(`Policy text in ${dir} is ${total} characters; the limit is ${MAX_CHARS}. Trim it.`);
  }
  for (const d of docs) log.log?.(`Policy loaded: ${d.name} (${d.text.length} chars)`);
  return docs;
}

export function buildSystemPrompt(basePrompt, docs) {
  if (!docs.length) return basePrompt;
  const blocks = docs.map((d) => `<policy name="${d.name}">\n${d.text}\n</policy>`).join("\n\n");
  return `${basePrompt}\n\nThe privacy policies the participant read:\n\n${blocks}`;
}
