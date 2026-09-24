/** Auth fields every write tool takes — always required, since this server never holds
 * or generates a private key (SPEC D13). The calling agent computes these locally
 * (SPEC §4.1) and this client only ever relays them as OG-* headers. */
export interface RequestAuth {
  agentId?: string;
  kid: string;
  timestamp: string;
  nonce: string;
  sig: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`apps/api responded ${status}: ${JSON.stringify(body)}`);
  }
}

export function authHeaders(auth: RequestAuth): Record<string, string> {
  const headers: Record<string, string> = {
    "og-key": auth.kid,
    "og-timestamp": auth.timestamp,
    "og-nonce": auth.nonce,
    "og-signature": auth.sig,
  };
  if (auth.agentId) headers["og-agent"] = auth.agentId;
  return headers;
}

export function createApiClient(baseUrl: string) {
  async function request(method: string, path: string, opts: { auth?: RequestAuth; body?: unknown } = {}): Promise<unknown> {
    const headers: Record<string, string> = opts.auth ? authHeaders(opts.auth) : {};
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }
  return {
    get: (path: string, auth?: RequestAuth) => request("GET", path, { auth }),
    post: (path: string, body: unknown, auth?: RequestAuth) => request("POST", path, { auth, body }),
    delete: (path: string, auth?: RequestAuth) => request("DELETE", path, { auth }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
