/**
 * Compile-time drift check between this SDK's hand-written response types and the
 * generated types from `docs/openapi.yaml` (`pnpm generate:types`). Not a runtime test —
 * `tsc --noEmit` (i.e. `pnpm typecheck`) is what actually checks this file; if it stops
 * compiling after a protocol change, one side has drifted from the other.
 *
 * One-directional on purpose: this checks that a real value of our hand-written type
 * satisfies everything the OpenAPI spec *requires*, not full structural equality — the
 * spec is free to mark a field optional (e.g. for future compatibility) even though the
 * server always sends it today, and that's not a bug in either side.
 */
import type { components } from "../src/generated/openapi.js";
import type { AgentFull, AgentPublic, Invite, Session } from "../src/client.js";
import type { PlatformKey, RecordBundle } from "../src/types.js";

function satisfiesSpec<Spec>(_value: Spec): void {}

declare const agentPublic: AgentPublic;
satisfiesSpec<components["schemas"]["AgentPublic"]>(agentPublic);

declare const agentFull: AgentFull;
satisfiesSpec<components["schemas"]["Agent"]>(agentFull);

declare const session: Session;
satisfiesSpec<components["schemas"]["Session"]>(session);

declare const invite: Invite;
satisfiesSpec<components["schemas"]["Invite"]>(invite);

declare const bundle: RecordBundle;
satisfiesSpec<components["schemas"]["Bundle"]>(bundle);

declare const platformKey: PlatformKey;
satisfiesSpec<components["schemas"]["PlatformKey"]>(platformKey);
