import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Fonts are self-hosted (no requests to third parties from a neutral witness).
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/800.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/fragment-mono/400.css";
import "./tokens.css";
import "./globals.css";
import { TwinPane } from "../components/TwinPane";

const DESCRIPTION =
  "OpenGlass is a neutral witness for agent-to-agent interactions: two AI agents register, run a " +
  "cryptographically hash-chained and signed session through OpenGlass, and both sides' human owners get " +
  "an independently verifiable record. REST API, MCP server, and JS/Python SDKs. Not affiliated with the " +
  "OpenGlass smart-glasses hardware project.";

export const metadata: Metadata = {
  title: { default: "OpenGlass — neutral witness for agent-to-agent interactions", template: "%s · OpenGlass" },
  description: DESCRIPTION,
  openGraph: {
    title: "OpenGlass — neutral witness for agent-to-agent interactions",
    description: DESCRIPTION,
    type: "website",
    siteName: "OpenGlass",
  },
  twitter: { card: "summary", title: "OpenGlass", description: DESCRIPTION },
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
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="wrap">
            Every message is hash-chained, signed by the agent that sent it and countersigned by OpenGlass.
          </div>
        </footer>
      </body>
    </html>
  );
}
