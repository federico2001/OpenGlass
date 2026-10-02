"use client";

import { type ReactNode, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, apiFetch, type Owner } from "../../lib/dashboard";
import { OwnerContext } from "../../lib/ownerContext";
import { TwinPane } from "../TwinPane";
import styles from "./AppShell.module.css";

export const APP_NAV = [
  { href: "/dashboard", label: "Overview", match: ["/dashboard", "/dashboard/agents"] },
  { href: "/dashboard/activity", label: "Activity", match: ["/dashboard/activity", "/dashboard/sessions", "/dashboard/attestations"] },
  { href: "/dashboard/counterparties", label: "Counterparties", match: ["/dashboard/counterparties"] },
  { href: "/dashboard/guide", label: "How it works", match: ["/dashboard/guide"] },
  { href: "/dashboard/settings", label: "Settings", match: ["/dashboard/settings"] },
] as const;

/** Which nav item a path belongs to: the longest matching prefix wins, so
 * /dashboard/sessions/x is Activity, not Overview. */
export function activeNavHref(pathname: string): string | null {
  let best: { href: string; length: number } | null = null;
  for (const item of APP_NAV) {
    for (const prefix of item.match) {
      const matches = prefix === "/dashboard" ? pathname === "/dashboard" : pathname === prefix || pathname.startsWith(`${prefix}/`);
      if (matches && (!best || prefix.length > best.length)) best = { href: item.href, length: prefix.length };
    }
  }
  return best?.href ?? null;
}

/** The signed-in owner area: its own header, navigation and account controls, separate
 * from the public site. Loads the owner once; a signed-out visitor goes to /login and
 * comes back to the page they asked for. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/dashboard";
  const router = useRouter();
  const [owner, setOwner] = useState<Owner | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ owner: Owner }>("/v1/owner/me")
      .then((r) => {
        if (!cancelled) setOwner(r.owner);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          const back = `${window.location.pathname}${window.location.search}`;
          router.replace(`/login?redirectTo=${encodeURIComponent(back)}`);
        } else {
          setFailed(err instanceof Error ? err.message : "Could not load your account.");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setMenuOpen(false), [pathname]);

  async function signOut() {
    await fetch("/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    router.push("/");
  }

  const active = activeNavHref(pathname);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <a className={styles.brand} href="/dashboard">
            <TwinPane size={26} />
            <span>OpenGlass</span>
            <span className={styles.area}>Owner dashboard</span>
          </a>
          {owner && (
            <div className={styles.account}>
              <button
                type="button"
                className={styles.accountButton}
                aria-expanded={menuOpen}
                aria-controls="account-menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span className={styles.avatar} aria-hidden="true">
                  {owner.email.slice(0, 1).toUpperCase()}
                </span>
                <span className={styles.email}>{owner.email}</span>
              </button>
              {menuOpen && (
                <div id="account-menu" className={styles.menu} role="menu">
                  <p className={styles.menuEmail}>{owner.email}</p>
                  <a role="menuitem" href="/dashboard/settings">
                    Settings
                  </a>
                  <a role="menuitem" href="/">
                    Public site
                  </a>
                  <button role="menuitem" type="button" onClick={signOut}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <nav className={styles.nav} aria-label="Dashboard">
          <div className={styles.navInner}>
            {APP_NAV.map((item) => (
              <a key={item.href} href={item.href} className={item.href === active ? styles.navActive : undefined} aria-current={item.href === active ? "page" : undefined}>
                {item.label}
              </a>
            ))}
          </div>
        </nav>
      </header>

      {owner ? (
        <OwnerContext.Provider value={{ owner, setOwner }}>{children}</OwnerContext.Provider>
      ) : (
        <main className={`wrap ${styles.loading}`}>
          <p className="label">{failed ?? "Loading your dashboard…"}</p>
        </main>
      )}

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <p>
            OpenGlass is a neutral witness: both sides of an interaction get the same signed record, and anyone can check
            it without trusting OpenGlass.
          </p>
          <nav>
            <a href="/dashboard/guide">How it works</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
