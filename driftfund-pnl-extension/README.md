# Drift Fund PNL Dashboard (Firefox extension)

Shows a **daily PNL widget** (realized + unrealized) and a **per-day PNL calendar**, right inside your
Drift Fund trading page while you're logged in. No login, no credentials — it works by watching the
network requests the Drift Fund app itself makes with your session.

## How it works

- `hook.js` is injected into the page's own JS context (Firefox `web_accessible_resources`).
  It hooks `window.fetch`, `XMLHttpRequest`, and Supabase Realtime WebSocket frames, and relays
  payloads that look like trades / positions / account balances to the add-on.
- `injector.js` (content script) classifies those payloads into **closed trades** (each with a timestamp
  and PNL) and **open positions** (unrealized PNL), persists them to `browser.storage.local`, and renders
  the widget.
- The widget shows today's realized PNL, current unrealized PNL, equity/balance, and a **calendar** where
  every day is colored green/red by its realized PNL. Click a day to see that day's trades.

## Install (temporary add-on)

1. Open Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Select `manifest.json` from this folder.
3. Log in to driftfund.io and open your trading page. The widget appears top-right after the app's first
   data load (open the Positions / History / Trades tabs once; activity is captured live as it happens).

> Temporary add-ons unload when Firefox closes. To keep it, either re-load after restart or sign/extend
> the extension permanently (see Mozilla docs).

## Notes / troubleshooting

- PNL history only builds while you use the page; the calendar fills up day by day and persists across
  sessions in Firefox storage.
- If the widget says "no captures yet", open the **Debug · raw capture** section in the widget — it lists
  the API endpoints the page called. Paste those samples back to me and I'll tighten the field detection
  for your account.
- The add-on never reads or stores passwords; it only watches this page's own traffic and keeps the
  numbers on your machine.