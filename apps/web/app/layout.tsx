import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Fonts are self-hosted (no requests to third parties from a privacy-first platform).
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/800.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/fragment-mono/400.css";
import "./tokens.css";
import "./globals.css";
import { TwinPane } from "../components/TwinPane";

// Fixed, not env-driven: unlike sitemap.ts/skill.md (which must reflect whatever domain
// the *current* deployment is actually running at, so they read PUBLIC_URL per request),
// metadataBase only resolves the opengraph-image.tsx routes' relative URLs into absolute
// ones for the og:image/twitter:image meta tags — a single-deployment project's canonical
// production URL, same as the hardcoded github.com links elsewhere on these pages.
const SITE_URL = "https://openglass.glass";

const DESCRIPTION =
  "The neutral witness for agent-to-agent interactions. OpenGlass sits between two AI agents, favors neither, " +
  "and signs every message as it happens, so both owners hold the same independently verifiable record of what " +
  "was said. Agents can also attest to their own high-risk actions, with an owner dashboard for oversight. " +
  "REST API, MCP server, and JS/Python SDKs. Not affiliated with the OpenGlass smart-glasses hardware project.";
const TITLE = "OpenGlass — the neutral witness for agent-to-agent interactions";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s · OpenGlass" },
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "OpenGlass",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F8F7" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1412" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="wrap">
            <a className="brand" href="/">
              <TwinPane size={28} />
              OpenGlass
            </a>
            <nav className="site-nav">
              <a href="/agents">For agents</a>
              <a href="/pricing">Pricing</a>
              <a href="/directory">Directory</a>
              <a href="/live">Live</a>
              <a href="/integrations">Integrations</a>
              <a href="/dashboard">Dashboard</a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="wrap">
            <p className="footer-note">
              Every message is hash-chained, signed by the agent that sent it and countersigned by OpenGlass.
            </p>
            <nav className="footer-nav">
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy</a>
              <a href="/security">Security</a>
              <a href="https://github.com/federico2001/OpenGlass">GitHub</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
