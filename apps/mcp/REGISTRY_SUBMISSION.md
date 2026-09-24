# Publishing to MCP registries

`server.json` in this directory is ready for the official MCP Registry. This doc is a
checklist for **you** to actually submit it — I (the agent that wrote this) don't submit
to public registries, publish packages, or create accounts on your behalf; that's an
explicit-permission, external-facing action I leave to you.

## Before submitting

- [x] `server.json`'s `websiteUrl`/`remotes.url` point at the real domain
      (`openglass.glass`, `mcp.openglass.glass`).
- [x] `https://mcp.openglass.glass/mcp` is live and healthy in production.
- [x] `server.json` validated clean against the live registry schema (`2025-12-11`) with
      `mcp-publisher validate` — this also caught and fixed a `description` over the
      registry's 100-character limit.
- [x] No package-ownership verification needed: this server only has a `remotes` entry (no
      `packages`), so the registry's only requirement is that the URL be publicly
      reachable, which it already is.

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

This is the primary upstream feed — Smithery, Glama, and PulseMCP (below) largely crawl
or ingest from it, so this is the one submission that matters most.

1. Install the CLI: `curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher`
   (or `brew install mcp-publisher`).
2. Authenticate: `mcp-publisher login github`. This prints a `https://github.com/login/device`
   URL and a one-time code — open the URL, enter the code, and approve. GitHub OAuth is the
   right method here since `server.json`'s name (`io.github.federico2001/openglass-mcp`) is
   in the `io.github.*` namespace tied to this repo's owner; no separate DNS verification
   needed.
3. From `apps/mcp/`, run `mcp-publisher publish server.json`.
4. Verify: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.federico2001/openglass-mcp"`.

## 2. Smithery (smithery.ai)

Smithery has its own registration flow (connect your GitHub account, point it at this
repo). Since it also crawls the official registry, submitting there first (§1) may get
you listed on Smithery automatically — check before doing a separate manual submission.

## 3. Glama (glama.ai/mcp/servers)

Similarly crawls the official registry and also accepts direct submissions via their
site. Check their current submission form for what's still needed manually.

## 4. PulseMCP (pulsemcp.com)

Same pattern — primarily an aggregator/directory over the official registry and other
sources, with its own manual submission form as a fallback.

## After submitting

- [ ] Once listed, smoke-test that an MCP-aware client (e.g. Claude, or the registry's own
      test-connect feature if it has one) can actually connect to
      `https://mcp.<your-domain>/mcp` and list all 8 tools.
- [ ] Consider whether `apps/mcp/server.json`'s `version` should track `apps/mcp/package.json`'s
      version going forward, and re-submit on meaningful tool-surface changes.
