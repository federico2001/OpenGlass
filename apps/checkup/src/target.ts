import { isIP } from "node:net";

/** What to check: an origin (scheme + host + port) and, when the caller gave one, the exact
 * agent-card URL. A bare domain or a site root means "try both well-known card paths". */
export interface Target {
  /** `https://host[:port]`, lowercase host. */
  origin: string;
  host: string;
  cardUrl: string | null;
  /** Cache, rate-limit and metrics key: the card URL if given, otherwise the origin. */
  key: string;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/i;
const DOMAIN_IN_TEXT = /(?:^|[\s,;:(["'])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?=$|[\s,;:)\]"'.!?/])/i;

/** Pulls the target out of a caller's message. Only ever extracts a URL or hostname from
 * the text; nothing else in it is interpreted. */
export function parseTarget(input: string): Target | null {
  const text = input.trim().slice(0, 2000);
  const urlMatch = URL_IN_TEXT.exec(text);
  if (urlMatch) return fromUrl(urlMatch[0].replace(/[.,;:!?]+$/, ""));
  const domainMatch = DOMAIN_IN_TEXT.exec(text);
  if (domainMatch) return fromDomain(domainMatch[1]!);
  return null;
}

export function fromDomain(raw: string): Target | null {
  const host = raw.toLowerCase().replace(/\.$/, "");
  if (!DOMAIN.test(host)) return null;
  const origin = `https://${host}`;
  return { origin, host, cardUrl: null, key: origin };
}

export function fromUrl(raw: string): Target | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, "");
  if (!DOMAIN.test(host) && isIP(bare) === 0 && host !== "localhost") return null;
  const origin = `${url.protocol}//${url.host.toLowerCase()}`;
  const isRoot = (url.pathname === "/" || url.pathname === "") && !url.search;
  url.hash = "";
  const cardUrl = isRoot ? null : url.toString();
  return { origin, host: bare, cardUrl, key: cardUrl ?? origin };
}

/** The bare hostname when the target is a real domain (not an IP literal or localhost). */
export function domainOf(target: Target): string | null {
  return DOMAIN.test(target.host) ? target.host : null;
}
