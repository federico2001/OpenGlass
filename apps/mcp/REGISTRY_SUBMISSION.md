# Publishing to MCP registries

`server.json` in this directory is ready for the official MCP Registry. This doc is a
checklist for **you** to actually submit it — I (the agent that wrote this) don't submit
to public registries, publish packages, or create accounts on your behalf; that's an
explicit-permission, external-facing action I leave to you.

## Before submitting

- [ ] `openglass.example` in `server.json`'s `websiteUrl`/`repository`/`remotes.url` needs
      to become your real domain once you have one (currently a placeholder matching
      `docs/SPEC.md`'s examples).
- [ ] Confirm `mcp.<your-domain>` actually resolves and serves `/mcp` before submitting —
      registries generally do a live reachability check.
- [ ] Double-check the current schema URL and submission flow against the registry's own
      docs at submission time — `$schema` above is my best understanding as of when this
      was written, but registry schemas evolve.

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

This is the primary upstream feed — Smithery, Glama, and PulseMCP (below) largely crawl
or ingest from it, so this is the one submission that matters most.

1. Install the registry publisher CLI (see the registry's own docs/README for the current
   install command — historically `mcp-publisher` via `go install` or a downloadable binary).
2. Authenticate. The registry supports GitHub OAuth for `io.github.*` namespaced servers
   (which is what `server.json`'s `name` field uses here) — since this repo lives at
   `github.com/federico2001/OpenGlass`, GitHub auth is the natural fit and proves you
   control that namespace without a separate DNS-based verification step.
3. From `apps/mcp/`, run the publisher's `publish` command pointing at `server.json`.
4. Verify the listing appears at the registry's web UI / API afterward.

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
