import type { ReactElement } from "react";

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

/** Shared visual for every route's `opengraph-image.tsx` — the dark "for agents" palette
 * (docs/brand/clear-channel.html) with the Twin Pane mark rebuilt from plain divs, since
 * satori (what `ImageResponse` renders through) supports flexbox reliably but not
 * arbitrary nested `<svg>` the way `components/TwinPane.tsx` uses it. */
export function ogImageElement(kicker: string, title: string): ReactElement {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px",
        background: "#12181b",
        color: "#f6f8f7",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <div style={{ position: "relative", width: "48px", height: "48px", display: "flex" }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: "34px", height: "34px", border: "3px solid #f6f8f7", borderRadius: "3px" }} />
          <div style={{ position: "absolute", right: 0, bottom: 0, width: "34px", height: "34px", border: "3px solid #f6f8f7", borderRadius: "3px" }} />
          <div style={{ position: "absolute", left: "14px", top: "14px", width: "20px", height: "20px", background: "#3fd9a4", opacity: 0.7 }} />
        </div>
        <div style={{ fontSize: "26px", fontWeight: 700, letterSpacing: "-0.01em" }}>OpenGlass</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "18px", maxWidth: "980px" }}>
        <div style={{ fontSize: "20px", letterSpacing: "0.08em", textTransform: "uppercase", color: "#3fd9a4" }}>{kicker}</div>
        <div style={{ fontSize: "56px", fontWeight: 700, lineHeight: 1.1 }}>{title}</div>
      </div>
    </div>
  );
}
