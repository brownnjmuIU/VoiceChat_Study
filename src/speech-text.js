// -----------------------------------------------------------------------------
// Pure text helpers shared by the server AND the browser (served at
// /speech-text.js). No Node or DOM imports allowed in this file.
//
// Why chunk at all: Kokoro on a 1-CPU Render box synthesises at roughly
// real time. Speaking a 20-second reply in one request means 20 seconds of
// silence first. Splitting into sentences lets the browser play sentence 1
// while the server is still making sentence 2.
// -----------------------------------------------------------------------------

/**
 * Remove formatting that sounds wrong read aloud. The system prompt already
 * asks for plain prose; this is the safety net for when the model ignores it.
 * Only the AUDIO uses this. The text condition shows the model's reply as-is.
 */
export function toSpeakable(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ") // fenced code: unspeakable, drop it
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/https?:\/\/\S+/g, "a link") // bare URLs
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*+]\s+/gm, "") // bullets
    .replace(/^\s*(\d+)[.)]\s+/gm, "$1. ") // "1) foo" -> "1. foo"
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/\|/g, " ") // table pipes
    .replace(/(\*\*|__|\*|_|~~)(\S(?:[\s\S]*?\S)?)\1/g, "$2") // bold/italic/strike
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // emoji
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Split speakable text into chunks of at most maxChars, preferring sentence
 * boundaries, then commas, then spaces. Never returns an empty chunk.
 */
export function splitForSpeech(text, maxChars = 300) {
  const clean = String(text ?? "").trim();
  if (!clean) return [];

  // Sentence ends: . ! ? (optionally followed by quotes/brackets) then space,
  // or a line break. Lookbehind keeps the punctuation with its sentence.
  const sentences = clean
    .split(/(?<=[.!?]["')\]]?)\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    // Long sentence: break at commas/semicolons, then hard-wrap on spaces.
    let current = "";
    for (const part of sentence.split(/(?<=[,;:])\s+/)) {
      for (const piece of hardWrap(part, maxChars)) {
        if (!current) current = piece;
        else if (current.length + 1 + piece.length <= maxChars) current += " " + piece;
        else {
          chunks.push(current);
          current = piece;
        }
      }
    }
    if (current) chunks.push(current);
  }

  // Merge very short neighbours ("Yes." "Sure.") so we do not pay a request
  // and an audible gap for two words.
  const merged = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.length < 25 && last.length + 1 + c.length <= maxChars) {
      merged[merged.length - 1] = last + " " + c;
    } else merged.push(c);
  }
  return merged;
}

function hardWrap(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word.length > maxChars) {
      if (line) out.push(line), (line = "");
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += " " + word;
    else out.push(line), (line = word);
  }
  if (line) out.push(line);
  return out;
}
