// Strip markdown/formatting characters so the browser's speechSynthesis
// doesn't literally read them out ("asterisk asterisk bold asterisk asterisk").
// Kept intentionally small — we only handle the characters that actually
// appear in AI-generated chat and how-to-tour copy.
export function stripMarkdownForSpeech(input) {
  if (!input) return "";
  return String(input)
    // Fenced / inline code
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    // Bold / italic / strike — **x**, __x__, *x*, _x_, ~~x~~
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    // Markdown links [label](url) → label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Leading list bullets / hashes / blockquotes
    .replace(/^\s*[#>*\-+]+\s+/gm, "")
    // Stray backticks / asterisks / underscores that slipped through
    .replace(/[`*_~]+/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}
