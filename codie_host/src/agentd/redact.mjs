// What Codie says is heard by whoever is in the room and kept in the device
// chat, so credentials an agent quotes (a command, its own reply) are cut
// out first. Only well-known shapes: a false hit hides a word, a miss reads a
// secret aloud.
const HIDDEN = '…';

const TOKENS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  // A PEM private key, to its END line or, cut short, to the end of the text.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
// Keeps the scheme or the name, hides the value.
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const ASSIGNED = /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"']{6,}\3/gi;
// scheme://user:password@host keeps the user.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi;

export function redactSecrets(text) {
  let s = String(text);
  for (const re of TOKENS) s = s.replace(re, HIDDEN);
  return s.replace(URL_PASSWORD, `$1${HIDDEN}@`).replace(BEARER, `$1${HIDDEN}`).replace(ASSIGNED, `$1$2$3${HIDDEN}$3`);
}
