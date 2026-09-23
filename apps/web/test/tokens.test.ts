import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/tokens.css", import.meta.url), "utf8");
const brandSheet = readFileSync(new URL("../../../docs/brand/clear-channel.html", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const open = css.indexOf("{", start);
  const body = css.slice(open + 1, css.indexOf("}", open));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

const light = block(":root {");
const darkMedia = block(':root:not([data-theme="light"])');
const darkForced = block(':root[data-theme="dark"]');
const dark = { ...light, ...darkMedia };

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("design tokens", () => {
  it("keep the forced dark theme identical to the system dark theme", () => {
    expect(darkForced).toEqual(darkMedia);
  });

  it("use the brand sheet palette", () => {
    for (const hex of ["#f6f8f7", "#12181b", "#3fd9a4", "#94a3a0", "#1f8f6c"]) {
      expect(brandSheet.toLowerCase()).toContain(hex);
      expect(Object.values(light)).toContain(hex);
    }
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("meet WCAG AA (4.5:1) for text in the %s theme", (_name, t) => {
    for (const fg of ["ink", "ink-soft", "accent-text"]) {
      for (const bg of ["bg", "bg-panel", "bg-subtle", "bg-inset"]) {
        expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const fg of ["inverse-ink", "inverse-accent"]) {
      expect(contrast(t[fg]!, t["inverse-bg"]!), `${fg} on inverse-bg`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
