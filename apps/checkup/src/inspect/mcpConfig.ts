import { type CheckInfo, InspectError, quote, RuleCollector, type RuleFindings, summaryLine } from "./common.js";
import { isPlaceholder, looksLikeSecretName, reasonText, Redactor, secretReason, shapeOf } from "./secrets.js";

/**
 * Tool 2, "Check this MCP setup before I install it": a static reading of a pasted MCP
 * client config. No registry lookups, no downloads, nothing is run. Every finding quotes the
 * exact setting it is about (with credentials redacted) and points at it by JSON path.
 */

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_SERVERS = 200;
export const DEFAULT_PER_RULE_CAP = 50;

export const STANDING_NOTE =
  "Static reading of settings. Cannot tell whether a server is malicious; no findings is not a safety guarantee. Nothing here was run.";
export const SECRETS_NOTE =
  "Credential detection is best-effort detection: it looks at setting names, a short list of known token shapes and long high-entropy strings, and it will miss some. Values it flags are redacted in this report. Replace real values with placeholders before pasting.";

const check = (rule: string, title: string): CheckInfo => ({ rule, title, label: "deterministic" });
export const CHECKS = {
  unpinned: check("mcp.unpinned-package", "Install-and-run without an exact version"),
  downloadExec: check("mcp.download-and-execute", "Download-and-execute chain"),
  httpLoopback: check("mcp.http-loopback", "Plain http:// to a loopback host"),
  httpRemote: check("mcp.http-non-loopback", "Plain http:// to a non-loopback host"),
  broadFs: check("mcp.broad-filesystem-scope", "Broad filesystem scope"),
  privileged: check("mcp.entrypoint-privileged", "Privilege-raising command"),
  container: check("mcp.entrypoint-container", "Container runtime as the server command"),
  shell: check("mcp.entrypoint-shell", "Shell as the server command"),
  autoApprove: check("mcp.auto-approve", "Tools approved without asking"),
  credEnv: check("mcp.credential-in-env", "Credential in env"),
  credHeaders: check("mcp.credential-in-headers", "Credential in headers"),
  credArgs: check("mcp.credential-in-args", "Credential in args or URL"),
} as const;

export interface ConfigReport {
  tool: "mcp-config";
  version: 1;
  input: { bytes: number; shape: "mcpServers" | "servers" | "server-map" | "single-server"; servers: number; analyzedServers: number; truncated: boolean; skipped: string[] };
  summary: string;
  checksRun: CheckInfo[];
  findings: RuleFindings[];
  limits: { maxInputBytes: number; maxServers: number; perRuleCap: number; notes: string[] };
  note: string;
  secretsNote: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Builds a JSON path like mcpServers["my server"].args[2]. */
function path(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$-]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

export function parseConfigText(text: string): Json {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CONFIG_BYTES) throw new InspectError("too_large", `The config is ${bytes} bytes; the limit is ${MAX_CONFIG_BYTES}.`, 413);
  if (!text.trim()) throw new InspectError("empty", "Paste an MCP client config (JSON).");
  try {
    return JSON.parse(text) as Json;
  } catch (err) {
    // JSON.parse's message quotes the input; only the position is passed on.
    const pos = /position (\d+)/.exec((err as Error).message)?.[1];
    let where = "";
    if (pos !== undefined) {
      const before = text.slice(0, Number(pos));
      const line = before.split("\n").length;
      where = ` near line ${line}, column ${Number(pos) - before.lastIndexOf("\n")}`;
    }
    throw new InspectError("bad_json", `That isn't valid JSON${where}. Comments and trailing commas aren't accepted.`);
  }
}

const SERVER_KEYS = ["command", "url", "serverUrl", "httpUrl", "endpoint"];
const looksLikeServer = (o: Obj) => SERVER_KEYS.some((k) => typeof o[k] === "string") || (typeof o.type === "string" && /^(stdio|sse|http|streamable-?http)$/i.test(o.type));

export function locateServers(config: Json): { shape: ConfigReport["input"]["shape"]; base: string; servers: [string, Json][] } {
  if (!isObj(config)) throw new InspectError("bad_shape", 'Expected a JSON object: {"mcpServers": {...}}, a map of server names to server blocks, or one server block.');
  if (isObj(config.mcpServers)) return { shape: "mcpServers", base: "mcpServers", servers: Object.entries(config.mcpServers) };
  if (isObj(config.servers) && Object.values(config.servers).every(isObj)) return { shape: "servers", base: "servers", servers: Object.entries(config.servers) };
  if (looksLikeServer(config)) return { shape: "single-server", base: "$", servers: [["(single server)", config]] };
  const entries = Object.entries(config);
  if (entries.length > 0 && entries.some(([, v]) => isObj(v))) return { shape: "server-map", base: "$", servers: entries };
  throw new InspectError("bad_shape", 'No MCP servers found. Expected {"mcpServers": {...}}, a map of server names to server blocks, or one server block.');
}

export function inspectMcpConfig(text: string, opts: { perRuleCap?: number } = {}): ConfigReport {
  const config = parseConfigText(text);
  const { shape, base, servers } = locateServers(config);
  const cap = opts.perRuleCap ?? DEFAULT_PER_RULE_CAP;
  const c = Object.fromEntries(Object.entries(CHECKS).map(([k, info]) => [k, new RuleCollector(info, cap)])) as Record<keyof typeof CHECKS, RuleCollector>;
  const redactor = new Redactor();
  const skipped: string[] = [];
  const analyzed = servers.slice(0, MAX_SERVERS);

  // Pass 1: find credentials first, so every later quote can be redacted.
  for (const [name, server] of analyzed) if (isObj(server)) findCredentials(name, server, shape === "single-server" ? "$" : path(base, name), c, redactor);
  // Pass 2: everything else.
  for (const [name, server] of analyzed) {
    const at = shape === "single-server" ? "$" : path(base, name);
    if (!isObj(server)) {
      skipped.push(quote(name, 80));
      continue;
    }
    analyzeServer(name, server, at, c);
  }

  const findings = Object.values(c)
    .map((r) => r.result())
    .filter((f): f is RuleFindings => f !== null);
  const notes = [
    "Only the pasted JSON was read. No package registry, repository or URL was contacted and nothing was downloaded or run.",
    "Inputs and reports are processed in memory for this response only and are not stored.",
  ];
  if (servers.length > MAX_SERVERS) notes.push(`The config has ${servers.length} servers; only the first ${MAX_SERVERS} were checked.`);
  if (skipped.length) notes.push(`${skipped.length} entr${skipped.length === 1 ? "y is" : "ies are"} not server blocks (not JSON objects) and were skipped.`);
  const checksRun = Object.values(CHECKS);
  const report: ConfigReport = {
    tool: "mcp-config",
    version: 1,
    input: { bytes: Buffer.byteLength(text, "utf8"), shape, servers: servers.length, analyzedServers: analyzed.length, truncated: servers.length > MAX_SERVERS, skipped: skipped.slice(0, 20) },
    summary: summaryLine(findings, checksRun.length),
    checksRun,
    findings,
    limits: { maxInputBytes: MAX_CONFIG_BYTES, maxServers: MAX_SERVERS, perRuleCap: cap, notes },
    note: STANDING_NOTE,
    secretsNote: SECRETS_NOTE,
  };
  // Every string in the report, keys included, goes through the redactor one last time.
  return redactor.redactDeep(report);
}

// ------------------------------------------------------------------ credentials

const SECRET_FLAG = /^--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|password|passwd|pass|pat|key|bearer|auth|credentials?)$/i;
const SECRET_QUERY = /^(?:api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|password|sig|signature|code)$/i;

function findCredentials(name: string, server: Obj, at: string, c: Record<keyof typeof CHECKS, RuleCollector>, redactor: Redactor): void {
  const flag = (rule: RuleCollector, where: string, settingName: string, value: string, reason: ReturnType<typeof secretReason>) => {
    if (!reason) return;
    redactor.remember(value);
    rule.add({
      quote: `${quote(settingName, 120)} = ${"[redacted]"} (${value.trim().length} characters)`,
      location: { path: where },
      explanation: `Best-effort detection: ${reasonText(reason)}. A config file is easy to share or commit by accident; reference the credential from your environment or a secret store instead (for example "\${VAR}") and rotate it if this file has been shared.`,
      details: { server: quote(name, 120), setting: quote(settingName, 120) },
    });
  };

  for (const key of ["env", "environment"]) {
    const env = server[key];
    if (!isObj(env)) continue;
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") flag(c.credEnv, path(path(at, key), k), k, v, secretReason(k, v));
  }
  for (const key of ["headers", "requestInit"]) {
    let headers = server[key];
    if (key === "requestInit" && isObj(headers)) headers = headers.headers ?? null;
    if (!isObj(headers)) continue;
    const where = key === "requestInit" ? path(path(at, key), "headers") : path(at, key);
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string") continue;
      const credentialHeader = /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i.test(k) || looksLikeSecretName(k);
      flag(c.credHeaders, path(where, k), k, v, credentialHeader && !isPlaceholder(v) ? (shapeOf(v) ? secretReason("", v) : { kind: "name" }) : secretReason("", v));
    }
  }
  const args = Array.isArray(server.args) ? server.args : [];
  args.forEach((arg, i) => {
    if (typeof arg !== "string") return;
    const prev = i > 0 && typeof args[i - 1] === "string" ? (args[i - 1] as string) : "";
    const eq = /^(--?[A-Za-z][\w-]*)=(.*)$/s.exec(arg);
    if (eq && SECRET_FLAG.test(eq[1]!)) return flag(c.credArgs, path(path(at, "args"), i), eq[1]!, eq[2]!, secretReason("TOKEN", eq[2]!));
    if (SECRET_FLAG.test(prev) && !arg.startsWith("-")) return flag(c.credArgs, path(path(at, "args"), i), prev, arg, secretReason("TOKEN", arg));
    const shape = shapeOf(arg);
    if (shape) return flag(c.credArgs, path(path(at, "args"), i), `args[${i}]`, arg, { kind: "shape", label: shape });
    urlCredentials(arg, path(path(at, "args"), i), flag, c.credArgs);
  });
  for (const key of ["url", "serverUrl", "httpUrl", "endpoint", "command"]) {
    const v = server[key];
    if (typeof v !== "string") continue;
    const shape = shapeOf(v);
    if (shape) flag(c.credArgs, path(at, key), key, v, { kind: "shape", label: shape });
    else urlCredentials(v, path(at, key), flag, c.credArgs);
  }
}

function urlCredentials(
  text: string,
  where: string,
  flag: (rule: RuleCollector, where: string, settingName: string, value: string, reason: ReturnType<typeof secretReason>) => void,
  rule: RuleCollector,
): void {
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)) {
    let url: URL;
    try {
      url = new URL(m[0]);
    } catch {
      continue;
    }
    if (url.password && !isPlaceholder(decodeURIComponent(url.password))) flag(rule, where, "URL password", decodeURIComponent(url.password), { kind: "name" });
    for (const [k, v] of url.searchParams) {
      if (SECRET_QUERY.test(k) || shapeOf(v)) {
        const reason = shapeOf(v) ? { kind: "shape" as const, label: shapeOf(v)! } : isPlaceholder(v) ? null : ({ kind: "name" } as const);
        if (reason) flag(rule, where, `URL query parameter ${k}`, v, reason);
      }
    }
  }
}

// ------------------------------------------------------------------ everything else

const commandBase = (cmd: string) =>
  cmd
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");

/** The server's argv: command plus args, with a command like "npx -y pkg" split into words
 * (a Windows path such as C:\Program Files\nodejs\npx.cmd is kept whole). */
function argvOf(server: Obj): string[] | null {
  if (typeof server.command !== "string" || !server.command.trim()) return null;
  const args = (Array.isArray(server.args) ? server.args : []).map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
  const cmd = server.command.trim();
  const keepWhole = /^[A-Za-z]:[\\/]|\.(?:exe|cmd|bat|com|ps1)$/i.test(cmd) || /^["']/.test(cmd);
  return [...(keepWhole ? [cmd] : splitWords(cmd)), ...args];
}

/** Plain whitespace split that keeps simple quoted words together. Never evaluated. */
function splitWords(line: string): string[] {
  const words: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]!);
  return words;
}

const WRAPPERS = new Set(["sudo", "doas", "gsudo", "pkexec", "env", "nice", "nohup", "time", "exec"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const WIN_SHELLS = new Set(["cmd", "powershell", "pwsh"]);

/** Every command line the config would start, looking through sudo/env wrappers,
 * `cmd /c ...` and `sh -c "..."`, for the package-runner and download checks. */
function commandLines(argv: string[], depth = 0): string[][] {
  if (depth > 3 || argv.length === 0) return [];
  const base = commandBase(argv[0]!);
  const rest = argv.slice(1);
  if (WRAPPERS.has(base)) {
    let i = 0;
    while (i < rest.length && (rest[i]!.startsWith("-") || (base === "env" && /^[A-Za-z_][\w]*=/.test(rest[i]!)))) i++;
    return [argv, ...commandLines(rest.slice(i), depth + 1)];
  }
  if (SHELLS.has(base)) {
    const ci = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (ci !== -1 && rest[ci + 1]) return [argv, ...rest[ci + 1]!.split(/&&|\|\||;|\n/).flatMap((part) => commandLines(splitWords(part.split("|")[0]!), depth + 1))];
    return [argv];
  }
  if (WIN_SHELLS.has(base)) {
    const ci = rest.findIndex((a) => /^(?:\/c|\/k|-c|-command|-commandwithargs)$/i.test(a));
    if (ci !== -1) {
      const tail = rest.slice(ci + 1);
      return [argv, ...(tail.length === 1 ? tail[0]!.split(/&&|;/).flatMap((p) => commandLines(splitWords(p), depth + 1)) : commandLines(tail, depth + 1))];
    }
    return [argv];
  }
  return [argv];
}

interface Runner {
  ecosystem: "npm" | "python";
  /** Index of the first argument after the runner (and its subcommand). */
  start: number;
  valueFlags: Set<string>;
  packageFlags: Set<string>;
  extraFlags: Set<string>;
}

const NPM_VALUE_FLAGS = new Set(["-p", "--package", "--registry", "--cache", "--userconfig", "--prefix", "-w", "--workspace", "--node-options", "--loglevel"]);
const UV_VALUE_FLAGS = new Set([
  "--from", "--with", "--with-editable", "--with-requirements", "-p", "--python", "--index", "--index-url", "--extra-index-url", "--default-index",
  "-i", "--find-links", "-f", "-c", "--constraint", "--override", "--build-constraint", "--directory", "--project", "--cache-dir", "--config-file", "--env-file",
]);
const PIPX_VALUE_FLAGS = new Set(["--spec", "--python", "--pip-args", "--index-url", "--backend"]);

function runnerOf(argv: string[]): Runner | null {
  const base = commandBase(argv[0]!);
  const sub = argv[1]?.toLowerCase();
  const npm = (start: number): Runner => ({ ecosystem: "npm", start, valueFlags: NPM_VALUE_FLAGS, packageFlags: new Set(["-p", "--package"]), extraFlags: new Set() });
  if (base === "npx" || base === "pnpx" || base === "bunx") return npm(1);
  if ((base === "npm" && (sub === "exec" || sub === "x")) || ((base === "pnpm" || base === "yarn") && sub === "dlx") || (base === "bun" && sub === "x")) return npm(2);
  if (base === "uvx") return { ecosystem: "python", start: 1, valueFlags: UV_VALUE_FLAGS, packageFlags: new Set(["--from"]), extraFlags: new Set(["--with"]) };
  if (base === "uv" && sub === "tool" && argv[2]?.toLowerCase() === "run") return { ecosystem: "python", start: 3, valueFlags: UV_VALUE_FLAGS, packageFlags: new Set(["--from"]), extraFlags: new Set(["--with"]) };
  if (base === "pipx" && sub === "run") return { ecosystem: "python", start: 2, valueFlags: PIPX_VALUE_FLAGS, packageFlags: new Set(["--spec"]), extraFlags: new Set() };
  return null;
}

/** The package specs a runner invocation installs: flag values, else the first positional. */
function packageSpecs(argv: string[], r: Runner): { spec: string; index: number }[] {
  const fromFlags: { spec: string; index: number }[] = [];
  const extras: { spec: string; index: number }[] = [];
  let positional: { spec: string; index: number } | null = null;
  for (let i = r.start; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      if (!positional && argv[i + 1]) positional = { spec: argv[i + 1]!, index: i + 1 };
      break;
    }
    const eq = /^(--?[\w-]+)=(.*)$/s.exec(a);
    const flagName = eq ? eq[1]! : a;
    if (a.startsWith("-")) {
      const value = eq ? eq[2]! : r.valueFlags.has(a) ? argv[i + 1] : undefined;
      const valueIndex = eq ? i : i + 1;
      if (value !== undefined) {
        if (r.packageFlags.has(flagName)) fromFlags.push({ spec: value, index: valueIndex });
        if (r.extraFlags.has(flagName)) for (const part of value.split(",")) if (part.trim()) extras.push({ spec: part.trim(), index: valueIndex });
        if (!eq) i++;
      }
      continue;
    }
    positional = { spec: a, index: i };
    break; // everything after the package is the tool's own arguments
  }
  const primary = fromFlags.length ? fromFlags : positional ? [positional] : [];
  return [...primary, ...extras];
}

type PinState = { pinned: true } | { pinned: false; why: string; name: string } | null;

const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT = /#[0-9a-f]{7,40}$/i;
const LOCAL_PATH = /^(?:\.{1,2}[\\/]|[\\/~]|[A-Za-z]:[\\/]|file:)/;

export function npmPinState(raw: string): PinState {
  let spec = raw.trim();
  if (!spec || LOCAL_PATH.test(spec)) return null; // a local path isn't fetched from a registry
  if (/^(?:git\+|git:|https?:|github:|gitlab:|bitbucket:|gist:)/i.test(spec) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec)) {
    return COMMIT.test(spec) ? { pinned: true } : { pinned: false, why: "a git or URL reference without a commit hash", name: spec.replace(/#.*$/, "") };
  }
  if (spec.startsWith("npm:")) spec = spec.slice(4);
  const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
  if (at <= 0) return { pinned: false, why: "no version", name: spec };
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (EXACT_SEMVER.test(version)) return { pinned: true };
  if (version === "") return { pinned: false, why: 'a trailing "@" and no version', name };
  if (version.toLowerCase() === "latest") return { pinned: false, why: '"@latest", which follows whatever is newest', name };
  return { pinned: false, why: `"@${version}", a range or tag rather than an exact version`, name };
}

export function pythonPinState(raw: string): PinState {
  const spec = raw.trim();
  if (!spec || LOCAL_PATH.test(spec)) return null;
  if (/^(?:git\+|https?:)/i.test(spec)) {
    return /@[0-9a-f]{7,40}(?:#.*)?$/i.test(spec) ? { pinned: true } : { pinned: false, why: "a git or URL reference without a commit hash", name: spec.replace(/@[^/@]*$/, "") };
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(spec);
  if (!m) return { pinned: false, why: "no version", name: spec };
  const [, name, , rest] = m;
  if (!rest) return { pinned: false, why: "no version", name: name! };
  if (/^(?:===?|@)\s*v?\d+(?:\.\d+)*(?:[a-z]+\d*)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[\w.]+)?$/i.test(rest)) return { pinned: true };
  if (/^@\s*latest$/i.test(rest)) return { pinned: false, why: '"@latest", which follows whatever is newest', name: name! };
  return { pinned: false, why: `"${rest.slice(0, 40)}", a range rather than an exact version`, name: name! };
}

const DOWNLOAD_EXEC: RegExp[] = [
  /\b(?:curl|wget|fetch)\b[^|;&\n]{0,500}\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+)?(?:ba|z|da|k|fi|a)?sh\b/i,
  /\b(?:curl|wget)\b[^|;&\n]{0,500}\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby|php|bun|deno)\b/i,
  /\b(?:iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^|;\n]{0,500}\|\s*(?:iex|Invoke-Expression)\b/i,
  /\b(?:iex|Invoke-Expression)\b\s*[(\s]\s*\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+(?:System\.)?Net\.WebClient)\b/i,
  /\bDownloadString\s*\(/i,
  /\$\(\s*(?:curl|wget)\b/i,
  /`\s*(?:curl|wget)\b/i,
  /<\(\s*(?:curl|wget)\b/i,
];

const BROAD_POSIX = /^(?:\/|~|~\/|\$HOME|\$\{HOME\}|\/home|\/Users|\/root|\/home\/[^/]+|\/Users\/[^/]+|\/mnt\/[a-z]|\/Volumes|\$HOME\/?|\$\{HOME\}\/?)$/;
const BROAD_WINDOWS = /^(?:[A-Za-z]:[\\/]?|\\|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:USERPROFILE|\$env:HOME|[A-Za-z]:[\\/]Users(?:[\\/][^\\/]+)?|\\\\\?\\[A-Za-z]:\\?)$/i;

export function isBroadPath(raw: string): boolean {
  let p = raw.trim().replace(/^["']|["']$/g, "");
  if (p.length > 1) p = p.replace(/[\\/]+$/, "") || "/";
  if (/^[A-Za-z]:$/.test(p)) return true;
  return BROAD_POSIX.test(p) || BROAD_WINDOWS.test(p);
}

const isFilesystemName = (s: string) => /file[-_]?system|(?:^|[^a-z0-9])fs(?:$|[^a-z0-9])|mcp-fs|fs-mcp/i.test(s);
const LOOPBACK_HOST = /^(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\]|0\.0\.0\.0|\[::\])$/i;

function analyzeServer(name: string, server: Obj, at: string, c: Record<keyof typeof CHECKS, RuleCollector>): void {
  const detail = { server: quote(name, 120) };
  const argv = argvOf(server);
  const commandWords = argv ? argv.length - (Array.isArray(server.args) ? server.args.length : 0) : 0;
  const argsPath = (i: number) => (i < commandWords ? path(at, "command") : path(path(at, "args"), i - commandWords));

  if (argv) {
    const lines = commandLines(argv);
    const joined = argv.join(" ");

    // 1. Unpinned install-and-run.
    const seen = new Set<string>();
    for (const line of lines) {
      const runner = runnerOf(line);
      if (!runner) continue;
      for (const { spec } of packageSpecs(line, runner)) {
        const state = runner.ecosystem === "npm" ? npmPinState(spec) : pythonPinState(spec);
        if (!state || state.pinned || seen.has(spec)) continue;
        seen.add(spec);
        const runnerName = commandBase(line[0]!) + (runner.start > 1 ? ` ${line.slice(1, runner.start).join(" ")}` : "");
        const suggestion = runner.ecosystem === "npm" ? `${state.name}@<version you reviewed>` : `${state.name}==<version you reviewed>`;
        c.unpinned.add({
          quote: quote(`${runnerName} … ${spec}`, 200),
          location: { path: locateArg(server, at, spec) },
          explanation: `"${runnerName}" downloads and runs ${quote(spec, 80)} with ${state.why}, so each launch can run a different release than the one you reviewed (a new version, or one published from a compromised account); pin it to an exact version you reviewed, e.g. ${quote(suggestion, 120)}.`,
          details: { ...detail, package: quote(spec, 120), ecosystem: runner.ecosystem },
        });
      }
    }

    // 2. Download-and-execute chains.
    for (const re of DOWNLOAD_EXEC) {
      const m = re.exec(joined);
      if (!m) continue;
      c.downloadExec.add({
        quote: quote(m[0], 200),
        location: { path: Array.isArray(server.args) && server.args.length ? path(at, "args") : path(at, "command") },
        explanation: "This command line fetches a script from the network and hands it straight to an interpreter, so what runs is whatever that URL serves at launch and nothing in this config shows it; download the script once, review it, and run the reviewed copy instead.",
        details: detail,
      });
      break;
    }

    // 4. Broad filesystem scope on filesystem-style servers.
    if (isFilesystemName(name) || argv.some(isFilesystemName)) {
      argv.forEach((arg, i) => {
        if (i === 0) return;
        const value = /^--?[\w-]+=(.*)$/s.exec(arg)?.[1] ?? arg;
        if (!isBroadPath(value)) return;
        c.broadFs.add({
          quote: quote(arg, 120),
          location: { path: argsPath(i) },
          explanation: "This gives a filesystem server a filesystem root or a whole home directory, so every file there that your user can read (and maybe write) is in its reach; list only the project directories it needs.",
          details: detail,
        });
      });
    }

    // 5. Privileged or shell entrypoints (the server's own command).
    const base = commandBase(argv[0]!);
    if (["sudo", "doas", "su", "runas", "pkexec", "gsudo"].includes(base)) {
      c.privileged.add({
        quote: quote(joined, 200),
        location: { path: path(at, "command") },
        explanation: `The server starts through "${base}", so it runs with raised (often root or administrator) privileges; run it as your normal user unless it truly needs more.`,
        details: detail,
      });
    } else if (["docker", "podman", "nerdctl"].includes(base)) {
      const flags = argv.filter((a) => /^--privileged$|^--network=?host$|^--pid=?host$|^-v$|^--volume|^--mount|^--cap-add/.test(a));
      c.container.add({
        quote: quote(joined, 200),
        location: { path: path(at, "command") },
        explanation: `The server is started by "${base}"; containers isolate only as far as their flags allow, and mounts, host networking or --privileged reach into this machine, so read those flags before installing.`,
        details: { ...detail, notableFlags: flags.slice(0, 10).map((f) => quote(f, 60)) },
      });
    } else if (SHELLS.has(base) || WIN_SHELLS.has(base)) {
      c.shell.add({
        quote: quote(joined, 200),
        location: { path: path(at, "command") },
        explanation: `The server's command is the shell "${base}", so the program that actually runs is whatever the arguments tell the shell to do; read the full command line, or call the program directly instead of through a shell.`,
        details: detail,
      });
    }
  }

  // 3. Plain http:// endpoints (url-style keys and any argument).
  const endpoints: { value: string; where: string }[] = [];
  for (const key of ["url", "serverUrl", "httpUrl", "endpoint", "baseUrl", "uri"]) {
    const v = server[key];
    if (typeof v === "string") endpoints.push({ value: v, where: path(at, key) });
  }
  (Array.isArray(server.args) ? server.args : []).forEach((a, i) => {
    if (typeof a === "string") endpoints.push({ value: a, where: path(path(at, "args"), i) });
  });
  for (const { value, where } of endpoints) {
    for (const m of value.matchAll(/\bhttp:\/\/[^\s"'<>]+/gi)) {
      let host: string;
      try {
        host = new URL(m[0]).hostname.toLowerCase();
      } catch {
        continue;
      }
      const loopback = LOOPBACK_HOST.test(host) || LOOPBACK_HOST.test(`[${host.replace(/^\[|\]$/g, "")}]`);
      (loopback ? c.httpLoopback : c.httpRemote).add({
        quote: quote(m[0], 200),
        location: { path: where },
        explanation: loopback
          ? "Plain http:// to a loopback address is common for a server running on this machine; traffic stays local, but any other local program can reach the same port."
          : "Plain http:// to a host that isn't this machine sends requests, responses and any credentials unencrypted, so anyone on the network path can read or change them; use https://.",
        details: { ...detail, host: quote(host, 120) },
      });
    }
  }

  // 6. Auto-approve / always-allow.
  for (const [key, v] of Object.entries(server)) {
    if (!/^(?:auto[-_]?approve|always[-_]?allow|auto[-_]?allow|trust)$/i.test(key)) continue;
    const listed = Array.isArray(v) ? v.filter((t) => t !== null && t !== "") : null;
    if ((listed && listed.length > 0) || v === true) {
      c.autoApprove.add({
        quote: quote(`${key}: ${JSON.stringify(v)}`, 240),
        location: { path: path(at, key) },
        explanation:
          v === true
            ? "Every tool call from this server runs without asking you first; turn this off, or approve only specific read-only tools."
            : `${listed!.length} tool${listed!.length === 1 ? "" : "s"} from this server run without asking you first; keep this list to tools you've read and that can't change or send anything.`,
        details: { ...detail, tools: (listed ?? []).slice(0, 50).map((t) => quote(String(t), 80)) },
      });
    }
  }
}

/** JSON path of the argument holding `spec` (command, or args[i]), for locating findings. */
function locateArg(server: Obj, at: string, spec: string): string {
  const args = Array.isArray(server.args) ? server.args : [];
  const i = args.findIndex((a) => typeof a === "string" && (a === spec || a.endsWith(`=${spec}`) || a.includes(spec)));
  if (i !== -1) return path(path(at, "args"), i);
  return path(at, "command");
}
