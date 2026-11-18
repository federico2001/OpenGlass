import { InspectError } from "./common.js";

/**
 * In-memory limits for the inspection fetch: at most `perTargetPerMinute` fetches of the
 * same host per rolling minute, and at most `maxConcurrent` fetches in flight at once.
 * Kept in memory on purpose: it holds hostnames for a minute and nothing else, so no URL or
 * content is ever written to the database. A restart resets it, which only loosens it.
 */
export class FetchLimiter {
  private readonly hits = new Map<string, number[]>();
  private active = 0;
  constructor(
    readonly perTargetPerMinute: number,
    readonly maxConcurrent: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reserves a slot for `host` or throws a 429/503 InspectError. Call the returned release
   * function when the fetch ends, however it ends. */
  acquire(host: string): () => void {
    const key = host.toLowerCase();
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < 60_000);
    if (recent.length >= this.perTargetPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (t - recent[0]!)) / 1000));
      throw Object.assign(new InspectError("rate_limited", "That host has been fetched too often in the last minute. Try again shortly.", 429), { retryAfter });
    }
    if (this.active >= this.maxConcurrent) {
      throw Object.assign(new InspectError("busy", "Too many fetches are running right now. Try again in a few seconds.", 503), { retryAfter: 5 });
    }
    recent.push(t);
    this.hits.set(key, recent);
    this.active += 1;
    if (this.hits.size > 10_000) this.prune(t);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  private prune(t: number): void {
    for (const [key, times] of this.hits) if (times.every((at) => t - at >= 60_000)) this.hits.delete(key);
  }
}
