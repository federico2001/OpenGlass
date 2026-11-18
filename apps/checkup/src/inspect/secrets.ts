/**
 * Best-effort credential detection for the MCP config check. It never claims to catch
 * everything: names that read like credentials, a short list of well-known token shapes, and
 * long high-entropy strings. Anything it flags is redacted before a report leaves the
 * process, and every string in the report goes through `redactDeep` regardless.
 */

export const REDACTED = "[redacted]";

/** Obvious placeholders: these are what the form asks people to paste instead of real values. */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^<[^<>]{0,200}>$/, // <your-token>
  /^\$\{[^{}]{1,200}\}$/, // ${GITHUB_TOKEN}, ${env:X}, ${input:x}
  /^\$[A-Za-z_][A-Za-z0-9_]{0,100}$/, // $GITHUB_TOKEN
  /^%[A-Za-z_][A-Za-z0-9_]{0,100}%$/, // %GITHUB_TOKEN%
  /^\{\{[^{}]{1,200}\}\}$/, // {{token}}
  /^\[[^[\]]{0,200}\]$/, // [token]
  /^(?:your|my|insert|enter|replace|put|add|paste)[-_ .]/i, // your-api-key, YOUR_TOKEN_HERE
  /(?:^|[-_ .])(?:here|placeholder|changeme|change[-_]?me|replace[-_]?me|todo|tbd|redacted|example|dummy|fake|sample|test[-_]?token|none|null|undefined)(?:[-_ .]|$)/i,
  /^[x*•.\-_#0]{1,200}$/i, // xxxxx, ****, ...
  /^[A-Za-z]{2,12}[-_][x*.]{3,}$/i, // sk-xxxx, ghp_****
  /^[A-Za-z]{2,12}[-_]\.{3}$/, // sk-...
];

export function isPlaceholder(raw: string): boolean {
  const value = raw.trim().replace(/^(?:bearer|basic|token)\s+/i, "");
  if (value === "") return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

/** Well-known token shapes. Global regexes so the redactor can also scrub them anywhere. */
export const TOKEN_SHAPES: { id: string; label: string; regex: RegExp }[] = [
  { id: "anthropic", label: "an Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { id: "openai", label: "an OpenAI-style secret key", regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g },
  { id: "github", label: "a GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { id: "gitlab", label: "a GitLab token", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: "aws-key-id", label: "an AWS access key id", regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { id: "slack", label: "a Slack token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: "google", label: "a Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe", label: "a Stripe key", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: "jwt", label: "a JSON Web Token", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: "private-key", label: "a private key block", regex: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g },
  { id: "bearer", label: "a bearer credential", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
];

const SECRET_NAME = /(?:TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CLIENT[-_]?KEY|SIGNING[-_]?KEY|(?:^|[-_])KEY$|^KEY[-_]|(?:^|[-_])AUTH(?:ORIZATION)?(?:$|[-_])|CREDENTIAL|COOKIE|SESSION[-_]?ID|(?:^|[-_])PAT$|(?:^|[-_])PWD$|DSN$|CONNECTION[-_]?STRING)/i;
const NOT_SECRET_NAME = /(?:_URL$|_HOST$|_PORT$|_PATH$|_DIR$|_FILE$|_ID$|_NAME$|_USER(?:NAME)?$|_REGION$|_MODE$|_LEVEL$|_TIMEOUT$|_ENABLED$|^PATH$|^HOME$)/i;

export function looksLikeSecretName(name: string): boolean {
  if (!SECRET_NAME.test(name)) return false;
  // TOKEN_URL, KEY_FILE, AUTH_MODE... describe a credential, they aren't one.
  return !NOT_SECRET_NAME.test(name) || /(?:TOKEN|SECRET|PASSWORD)$/i.test(name);
}

export function shapeOf(value: string): string | null {
  for (const s of TOKEN_SHAPES) {
    s.regex.lastIndex = 0;
    if (s.regex.test(value)) {
      s.regex.lastIndex = 0;
      return s.label;
    }
  }
  return null;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A long, mixed, high-entropy token with no spaces (no URLs or paths). */
export function isHighEntropy(value: string): boolean {
  const v = value.trim();
  if (v.length < 24 || v.length > 4096 || /\s/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[./~\\]|^[A-Za-z]:[\\/]/.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  const hexOnly = /^[0-9a-f]{32,}$/i.test(v);
  return (classes >= 3 && entropy(v) >= 4.0) || (hexOnly && v.length >= 32);
}

export type SecretReason = { kind: "shape"; label: string } | { kind: "name" } | { kind: "entropy" };

/** Why `value` (stored under `name`) looks like a credential, or null if it doesn't or is an
 * obvious placeholder. */
export function secretReason(name: string, value: string): SecretReason | null {
  if (isPlaceholder(value)) return null;
  const label = shapeOf(value);
  if (label) return { kind: "shape", label };
  if (name && looksLikeSecretName(name)) return { kind: "name" };
  if (isHighEntropy(value)) return { kind: "entropy" };
  return null;
}

export function reasonText(reason: SecretReason): string {
  if (reason.kind === "shape") return `the value looks like ${reason.label}`;
  if (reason.kind === "name") return "the setting's name reads like a credential";
  return "the value is a long high-entropy string";
}

/** Replaces every known secret value, and anything matching a known token shape, in every
 * string inside `value` (keys included). Returns a new value; the input isn't changed. */
export class Redactor {
  private readonly known = new Set<string>();
  remember(secret: string): void {
    const s = secret.trim();
    if (s.length >= 4) this.known.add(s);
    if (secret.length >= 4) this.known.add(secret);
    // Also the part after a scheme word (Authorization: Bearer xyz → xyz).
    const bare = s.replace(/^(?:bearer|basic|token)\s+/i, "");
    if (bare.length >= 4) this.known.add(bare);
  }
  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is replaced whole.
    for (const secret of [...this.known].sort((a, b) => b.length - a.length)) out = out.split(secret).join(REDACTED);
    for (const s of TOKEN_SHAPES) out = out.replace(s.regex, REDACTED);
    return out;
  }
  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.redact(k), this.redactDeep(v)])) as T;
    }
    return value;
  }
}
