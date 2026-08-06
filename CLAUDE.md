# Playwright Dashboard

Web dashboard for building, scheduling, and running Playwright automations. Node.js + Express + vanilla JS SPA with a shadcn-inspired dark UI. Non-technical users can create automations click-by-click; power users can chain conditionals, sub-flows, HTTP calls, assertions, and data-driven iterations.

**Live production:** https://farm.bonusmania.top
**GitHub:** https://github.com/Scroti/playwright-dashboard

## Tech stack
- **Backend:** Node.js (ESM), Express, Playwright (Chromium), ws (WebSockets), node-cron
- **Frontend:** vanilla JS, Lucide icons (CDN), Inter + JetBrains Mono fonts, shadcn dark palette via HSL CSS variables
- **Storage:** flat JSON files under `data/` (no DB)
- **Process manager (prod):** PM2

## Project layout
```
server.js           # Express + Playwright orchestrator + WS server (~700 lines)
public/
  index.html        # SPA layout, modals, sidebar
  app.js            # ALL client logic (rendering, WS, editor, picker, analytics)
  style.css         # shadcn design tokens + components
data/               # runtime state (gitignored)
  flows.json        # saved flows
  runs.json         # last 50 runs
  settings.json     # notifications, AI keys, public URL, password
  sessions/*.json   # captured Playwright storageState per login
  screenshots/*.png # per-run screenshots
deploy.sh           # VPS setup (Node 20, PM2, Chromium + system deps)
setup-tunnel.sh     # Cloudflare Tunnel installer
Dockerfile          # alternative container deploy
```

## Run locally
```
npm install
npx playwright install chromium
npm start
```
Dashboard: http://localhost:3000

## Deploy / update on VPS
Server: **Contabo `13.140.142.62`** (root), path `/opt/playwright`, PM2 process `playwright-dashboard`, exposed via **Cloudflare Tunnel** → https://farm.bonusmania.top.

**Push a change from local:**
```
git add -A && git commit -m "..." && git push
```

**Pull on VPS** (SSH in, or use Claude Code running on the VPS):
```
cd /opt/playwright && git pull && pm2 restart playwright-dashboard
```

If deploying from scratch on a fresh VPS: `bash deploy.sh` then `bash setup-tunnel.sh <domain>`.

## Data model

**Flow:**
```js
{
  id, name, tags: [], loops, schedule: "cron",
  sessionName,        // reuse a saved login session
  device,             // Playwright device preset (iPhone 15 Pro, etc.)
  humanLike,          // random 200–1000ms delays before each step
  dataRows,           // JSON array of rows, {{key}} substitution
  alertOnFailure,     // notify after N consecutive failures
  steps: [{ type, ...fields }]
}
```

## Step types
| type | purpose | key fields |
|---|---|---|
| `goto` | navigate | `url` |
| `click` | click selector | `selector`, `count`, `delayMs` |
| `type` | fill input | `selector`, `text` |
| `wait` | pause ms | `ms` |
| `waitFor` | wait for selector | `selector`, `timeoutMs` |
| `screenshot` | capture png | `name`, `fullPage` |
| `extract` | grab text into `ctx.extracted[name]` | `selector`, `name` |
| `expect` | assertion; throws on fail | `check`, `selector`, `text` |
| `http` | external HTTP call | `method`, `url`, `headers`, `body`, `saveAs` |
| `callFlow` | run another flow inline | `flowId` |
| `if` | branch on selector existence/text | `selector`, `text`, `then[]`, `else[]` |
| `try` | swallow errors | `steps[]` |
| `retry` | retry N times with backoff | `times`, `steps[]` |

## Advanced features
- **Multi-step flows** with nested if/try/retry
- **Loops**: whole flow re-runs N times
- **Data-driven runs**: flow.dataRows JSON array → executes once per row, `{{key}}` substitution across step string fields
- **Sub-flows** via `callFlow` step
- **Sessions**: capture login manually once, reuse via `flow.sessionName`
- **Device emulation** (Playwright presets)
- **Human-like delays**
- **Cron scheduling** per flow (server-side node-cron)
- **Public trigger URLs**: `POST /api/trigger/:flowId` (bypasses password auth for external webhooks — Zapier, GitHub Actions, Stripe, etc.)
- **Alerts on N consecutive failures** → notification
- **Notifications**: Discord, Slack, Telegram (webhook URLs / bot token+chat in settings)
- **Recorder**: `⏺ Record` opens headed browser, captures clicks + inputs as steps
- **AI Generate**: prompt → Claude Sonnet 4.6 (via Anthropic API key in settings) → returns flow JSON, saved as new flow. Uses prompt caching on the system prompt.
- **Selector picker**: `🖱 Pick` button next to any selector/url input → headless browser streamed via CDP screencast → click on stream → best-effort CSS selector auto-filled
- **Live preview during runs**: CDP screencast to the "Live preview" tab
- **Analytics** button: 14-day success/failure bar chart, success rate, top failing flows
- **Password protect**: `settings.password` → basic auth for entire dashboard (trigger URLs remain public)
- **Import/export** flows as JSON

## Design system
- shadcn dark palette in `public/style.css` `:root` (`--background`, `--foreground`, `--primary`, etc. as HSL triplets)
- Fonts: Inter (UI), JetBrains Mono (logs)
- Icons: Lucide via CDN — use `<i data-lucide="name"></i>` and call `refreshIcons()` after any DOM mutation that adds new icons
- Toasts instead of `alert()` (`toast(msg, kind)` in app.js, container in HTML)
- Resizable bottom panel (drag `#resize-handle`)
- Drag-drop step reorder (HTML5 native, `⋮⋮` grip on step head)

## Known issues / TODO
- **Picker black screen** — modal opens with loading spinner but stream frames may not arrive on the VPS. Server sends immediate bootstrap `page.screenshot` after screencast starts, but issue persists in some cases. Needs investigation (possibly headless-mode screencast compatibility). Live preview during runs works fine, so CDP+broadcast plumbing is proven.
- **Deferred features** (not yet implemented): proxy rotation, video recording of runs, sub-flows visual graph, PWA install, keyboard shortcuts / Cmd+K command palette, AI-powered self-healing selectors (retry with LLM-suggested selector on failure), parallel runs / worker pool.
- **Multi-user was implemented then reverted** — user preferred single-user mode. Use `settings.password` for basic protection.

## Where we left off (2026-08-07)
Just completed a big UI overhaul: shadcn dark palette + Lucide icons + Inter font + toasts + resizable bottom panel + drag-drop step reorder. Also added: selector picker (streaming), analytics dashboard, failure alerts, public URL setting, sub-flows, data-driven runs, AI generation, session-based login reuse, device emulation.

Live at farm.bonusmania.top via Cloudflare Tunnel. Repo autoclones — for a fresh laptop: `git clone https://github.com/Scroti/playwright-dashboard && cd playwright-dashboard && npm install && npx playwright install chromium && npm start`.
