# SatsRoadMarket — static landing

Brand-only static site for **SatsRoadMarket** (`satsroadmarket.com`).
Nostalgic early-web marketplace look; original camel logo; no functions, forms, or backend.

## Files

| Path | Role |
|------|------|
| `index.html` | Hosting entrypoint |
| `assets/style.css` | Local styles only |
| `assets/laser-camel.jpg` | Original camel + ₿ mark |
| `README.md` | This file |

No frameworks, CDNs, fonts hosts, analytics, or JS.

## Preview locally

From this directory:

```bash
cd /workspace/satsroadmarket
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/` (or `http://localhost:8765/`).

Or open `index.html` directly in a browser (file:// works; all assets are relative).

## Deploy later (manual)

When the domain is ready, point the host’s document root (or static bucket) at this folder so `index.html` is served at `/`. Upload:

- `index.html`
- `assets/style.css`
- `assets/laser-camel.jpg`

Do not enable server-side apps, forms, or redirects beyond ordinary HTTPS. This site is intentionally functionless.

## Brand notes

- Name: **SatsRoadMarket**
- Motto: *Browse openly. Trade privately.*
- Theme: Nostr-native marketplace, private vendor chat, portable reputation, Cashu-ready checkout
- Palette: parchment / dark brown / black
- Logo: original SVG camel (not a third-party mark)

## Out of scope

Live market, login, payments, chat, tracking, downloads of paid assets, and any domain/DNS/hosting changes from this repo alone.

Branding: generated laser-eye camel bitmap on parchment (assets/laser-camel.jpg).
