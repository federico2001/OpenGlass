"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { TwinPane } from "./TwinPane";

export const SITE_NAV_LINKS: { href: string; label: string; signin?: boolean }[] = [
  { href: "/agents", label: "For agents" },
  { href: "/pricing", label: "Pricing" },
  { href: "/directory", label: "Directory" },
  { href: "/live", label: "Live" },
  { href: "/integrations", label: "Integrations" },
  { href: "/login", label: "Sign in", signin: true },
];

/**
 * Public site header. Wide screens show the links in a row. Narrow screens keep the logo on
 * its own and put the links behind a "Menu" button (aria-expanded / aria-controls), which
 * Escape, a link click, a route change or a click outside closes.
 */
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (header.current && !header.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <header className="site-header" ref={header}>
      <div className="wrap">
        <a className="brand" href="/">
          <TwinPane size={28} />
          OpenGlass
        </a>
        <button
          ref={toggle}
          type="button"
          className="site-nav-toggle"
          aria-expanded={open}
          aria-controls="site-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="site-nav-toggle-icon" aria-hidden="true" data-open={open} />
          <span aria-hidden="true">{open ? "Close" : "Menu"}</span>
        </button>
        <nav id="site-nav" className="site-nav" aria-label="Main" data-open={open}>
          {SITE_NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className={l.signin ? "site-nav-signin" : undefined} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
