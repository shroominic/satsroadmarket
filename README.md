# SatsRoadMarket — static landing

Brand-only static site for **SatsRoadMarket** (`satsroadmarket.com`).
Early-2010s utilitarian marketplace look; no functions, forms, or backend.

## Files (4)

| Path | Role |
|------|------|
| `index.html` | Hosting entrypoint |
| `assets/style.css` | Local styles only |
| `assets/satsroad-logo.jpg` | Brand logo (camel + rider, green SatsRoad) |
| `README.md` | This file |

No frameworks, CDNs, fonts hosts, analytics, or JS.

## Preview locally

```bash
cd /workspace/satsroadmarket
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/` (or `http://localhost:8765/`).

Or open `index.html` directly in a browser (file:// works; all assets are relative).

## Deploy later (manual)

Point the host document root (or static bucket) at this folder so `index.html` is `/`. Upload:

- `index.html`
- `assets/style.css`
- `assets/satsroad-logo.jpg`

HTTPS only; no server-side apps or forms. This site is intentionally functionless.

## Brand

- Name: **SatsRoadMarket**
- Motto: *Browse openly. Trade privately.*
- Logo file: `assets/satsroad-logo.jpg`
- Accent: green ≈ `#3f8b43`
