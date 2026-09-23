# Design system: Clear Channel

The look and feel of every OpenGlass surface (web app, emails, docs, record viewer) follows **Clear Channel, Refined**. The source of truth is the brand sheet [`docs/brand/clear-channel.html`](brand/clear-channel.html). The implementation lives in [`apps/web/app/tokens.css`](../apps/web/app/tokens.css) and [`apps/web/components/TwinPane.tsx`](../apps/web/components/TwinPane.tsx).

> Radical restraint: the interface gets out of the way so the record underneath reads as plainly as possible. Nothing to distrust because there's almost nothing there.

## Rules

1. **Use tokens, never raw hex.** Components read `var(--bg)`, `var(--ink)`, `var(--accent-text)` and so on. The only raw colours outside `tokens.css` are the Signal Green overlap in the logo and the favicon.
2. **Restraint.** One accent, thin rules (`1px var(--rule)`), 3–4px radii, no shadows, no gradients, no decorative imagery. When in doubt, remove it.
3. **Both themes.** Every surface works in light and dark (`prefers-color-scheme`, overridable with `data-theme="light|dark"` on `<html>`). Brand swatches are fixed, but product surfaces follow the theme.
4. **Contrast.** Text meets WCAG AA (4.5:1). `apps/web/test/tokens.test.ts` enforces this for every text/background token pair.
5. **No third-party requests.** Fonts are self-hosted with `@fontsource`. A neutral witness doesn't leak its visitors to anyone.

## Palette

| Name | Hex | Use |
| ---- | --- | --- |
| Glass White | `#F6F8F7` | Light background |
| Near Black | `#12181B` | Ink (light), "for agents" surfaces |
| Signal Green | `#3FD9A4` | The overlap in the mark, accent in dark mode, accent on Near Black |
| Sage Steel | `#94A3A0` | Decorative only in light mode (2.5:1 on Glass White): icons, dividers, never text |
| Deep Green | `#1F8F6C` | Accent in light mode: marks, borders, large text |

Semantic tokens (from the sheet):

| Token | Light | Dark |
| ----- | ----- | ---- |
| `--bg` | `#F6F8F7` | `#0F1412` |
| `--bg-panel` | `#FFFFFF` | `#161C1A` |
| `--bg-subtle` / `--bg-inset` | `#F1F4F3` / `#EAF0EE` | `#161C1A` |
| `--ink` | `#12181B` | `#EAF3F0` |
| `--ink-soft` | `#5B6A67` | `#93A19D` |
| `--rule` | `#DCE3E1` | `#283330` |
| `--accent` | `#1F8F6C` | `#3FD9A4` |
| `--accent-text` | `#1A7A5C` | `#3FD9A4` |
| `--inverse-bg` / `--inverse-ink` / `--inverse-accent` | `#12181B` / `#CFEFE1` / `#3FD9A4` | same |

## Type

| Role | Family | Weights | Token |
| ---- | ------ | ------- | ----- |
| Display and body | Manrope | 400 / 600 / 800 | `--font-display`, `--font-body` |
| Machine / data: hashes, IDs, requests, payloads | Fragment Mono | 400 | `--font-data` |
| UI chrome and labels: kickers, tags, section labels | IBM Plex Mono | 400 / 500 | `--font-ui` |

- Headlines are Manrope 800 with tight leading (1.06–1.12) and `text-wrap: balance`.
- Labels are IBM Plex Mono, 10.5–12px, uppercase, letter-spaced 0.12–0.14em.
- Anything a machine produced (a hash, a signature, an HTTP line) is set in Fragment Mono, so readers can tell recorded data from interface text.

## Logo: Twin Pane

Two thin-stroke squares, one per agent, offset so they overlap. The overlap is Signal Green glass: the place where two agents meet and OpenGlass is watching. Use `<TwinPane size={…} />`:

| Size | Stroke | Overlap opacity |
| ---- | ------ | --------------- |
| ≥ 96px | 2.5 | 0.6 |
| 40–95px | 3.5 | 0.6 |
| < 40px (favicon geometry, squares 54 units) | 5 | 0.7 |

Strokes use `currentColor`, so the mark is Near Black on light and light ink on dark. The favicon (`apps/web/app/icon.svg`) switches its stroke colour with `prefers-color-scheme`. Pass `title` when the mark stands alone; next to the "OpenGlass" wordmark it's decorative.

## Voice

Plain, short, literal. Say what the system does ("watch, record, and never look away"), not what it aspires to be. Example lines in the UI must describe real behaviour and real routes.

## Where this implementation departs from the sheet

- **Body font.** The sheet page sets its own body text in IBM Plex Sans, but its type spec says "Display / body: Manrope". The product follows the spec.
- **`--accent-text` (`#1A7A5C`).** The sheet uses `#1F8F6C` for small text, which is 3.5–4.0:1 on the light surfaces. The product uses the same hue a little darker (≥ 4.57:1) for text under 18px, and keeps `#1F8F6C` for marks and large type.
- **Theme-aware surfaces.** The sheet's cards have fixed colours. In the product, the "for humans" surface follows the theme, and the "for agents" surface stays Near Black with a `--rule` border so it still reads in dark mode.
- **Hero copy.** The sheet's `GET /trace/8841` isn't a real route. The home page uses `GET /v1/records/{id}` (SPEC §8).
