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

Smithery also crawls the official registry, so submitting there first (§1) may already
get this listed — check `https://smithery.ai/servers?q=openglass` before doing anything
manual. If it isn't there:

1. `npm install -g @smithery/cli`, then `smithery login` (GitHub OAuth device flow, same
   shape as `mcp-publisher login github` above).
2. `smithery mcp publish https://mcp.openglass.glass/mcp -n federico2001/openglass-mcp`
   registers the already-running remote endpoint directly — Smithery doesn't need to
   build or host it. (There's a separate `smithery.yaml` convention for servers Smithery
   itself builds from source via a Dockerfile; that doesn't apply here since this server
   is self-hosted with a `remotes` entry, not a `packages` one, so no such file was added
   to this repo — adding one on a guess risked telling Smithery to try to build this
   monorepo as if it needed hosting, which would be wrong.)
3. Confirm the CLI's exact flags before running — this doc's research hit the network
   policy for this environment (smithery.ai fetches were blocked), so the command above is
   reconstructed from secondary sources, not verified against Smithery's own current docs.

## 3. Glama (glama.ai/mcp/servers)

Crawls the official registry too, but also needs a claim step to actually attribute the
listing to you:

1. `/glama.json` is now in this repo's root (`{"$schema": "https://glama.ai/mcp/schemas/server.json", "maintainers": ["federico2001"]}`)
   — that's the only thing Glama's own schema requires (one property, a maintainers array
   of GitHub usernames), and it's a static file, so it's committed here rather than left
   as a checklist item.
2. Once this file is live on `main`, sign in to glama.ai with GitHub OAuth and claim the
   `OpenGlass` listing — Glama verifies you have write/admin access to the repo before
   letting the claim go through, which `glama.json` alone doesn't do.
3. Claiming unlocks editing the description and — per Glama's docs — configuring Docker
   build instructions so their crawler can introspect the server's tools directly. Whether
   that's required for a `remotes`-only server (vs. one Glama builds from source) wasn't
   confirmed here (same network-policy block as Smithery); check what the claimed listing
   actually asks for.

## 4. PulseMCP (pulsemcp.com)

As of this research (September 2026), PulseMCP has **new submissions and listing changes
paused** while they rework how they ingest and manage listings — there's nothing to
submit right now. It also aggregates from the official registry and other sources, so
this may show up on its own once that reopens; otherwise submit via `pulsemcp.com/submit`
(name, description, repo URL, install command, icon) when it's back.

## After submitting

- [ ] Once listed, smoke-test that an MCP-aware client (e.g. Claude, or the registry's own
      test-connect feature if it has one) can actually connect to
      `https://mcp.<your-domain>/mcp` and list all 8 tools.
- [ ] Consider whether `apps/mcp/server.json`'s `version` should track `apps/mcp/package.json`'s
      version going forward, and re-submit on meaningful tool-surface changes.
