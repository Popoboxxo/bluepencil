# Presentation example — `examples/presentation`

A self-contained, single-file deck-style HTML page that attaches
bluepencil in **localStorage mode** (no backend). Notes persist across
page reloads and can be exported to / imported from JSON.

## Serve it

```bash
# Build once (writes dist/attach.js and dist/bluepencil.element.min.js)
npm run build

# Serve the repo root
node scripts/serve-example.mjs

# Open
#   http://localhost:9283/examples/presentation/
```

## What the page exercises

| Area | Details |
|---|---|
| Mode | EMBED.md §1 mode b — single-file deck, no backend |
| Adapter | `localStorage` (notes survive reloads in the same browser) |
| Language | `de` |
| Gate | Always-on (`window.__bpGate = () => true`) |
| Stable anchors | Every slide has a `data-testid` hook for reliable note anchoring |
| Dark mode | `prefers-color-scheme` with `--bp-*` token overrides |

## File

| File | Purpose |
|---|---|
| `index.html` | The deck page: design tokens, slide markup, `attach.js` loader, keyboard navigation |

No framework, no bundler, no backend.

## Automated check

The deck is one of the pages `npm run smoke:embed` drives in a real browser: it opens
`examples/presentation/` served by the sidecar and asserts that the loader mounted exactly one
`<bluepencil-notes>`, injected the layer styles once and forwarded `adapter="localStorage"` and
`language="de"` — i.e. that the "no backend" mode really works from a plain script tag.

```bash
npm run build && npm run smoke:embed
```
