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
- **Recorder**: `⏺ Record` launches **headless** Chromium on the server, streams via CDP to the modal (viewport 1280×720). User clicks/types on the stream — captured as steps. Works on VPS with no X display. URL bar for in-recording navigation. Special keys (Enter/Tab/Backspace/arrows/Esc/Home/End/PageUp/PageDown) forward via `keyboard.press`; printable chars via `keyboard.type`.
- **Session capture**: same streamed-headless pattern as Recorder. Log in through the streamed browser, hit "I'm logged in — save" → `storageState()` written to `data/sessions/`.
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

## Productivity features
- **Command palette (Cmd/Ctrl+K)** — fuzzy search across flows + actions (Run/Save/Duplicate/Delete/Close current, Create/Record/AI/Import/Session capture, Analytics, Settings). Grouped, ↑↓/Enter/Esc navigation, hover to select. Sidebar has a "Quick actions" trigger button showing the shortcut.
- **Global keyboard shortcuts**: `⌘K` command palette · `⌘S` save flow · `⌘Enter` run flow · `⌘D` duplicate flow · `Esc` close top modal · `/` focus flow search.
- **Duplicate flow** button in editor header + via ⌘D + via command palette.
- **Folders** — flows grouped by `flow.folder` in sidebar with collapsible headers (state persisted in localStorage). Datalist autocomplete from existing folders.
- **Create-flow modal** — pressing "+ New flow" opens a modal (name + Cancel/Create) instead of immediately creating. Enter submits.
- **Delete flow** button on flow editor (with confirmation).
- **Close-flow X** in topbar breadcrumb — return to empty state without deleting.
- **After delete → empty state** (no auto-select of another flow). Auto-select only on first page load.

## Modal UX
- **All modals** auto-inject a top-right `×` close button on boot (`injectModalCloseButtons` in app.js).
- **Click backdrop** (outside `.modal-content`) closes the modal — invokes the Cancel button if present (for cleanup: session/picker cancel API calls), otherwise just hides.
- **Cmdk modal** is excluded from the auto-X (already shows the `ESC` hint at bottom, avoids overlap).
- **Toast** notifications instead of `alert()` (window.alert is monkey-patched to `toast(..., 'error')`).

## Self-deploy from dashboard
- **Deploy button** in sidebar footer: `git pull --ff-only origin main` then detached `nohup pm2 restart playwright-dashboard`.
- Server sends response, then in `res.on('finish')` schedules restart after 1.2s → ensures HTTP response is fully flushed through Cloudflare tunnel before origin dies.
- Detached with `nohup ... > /dev/null 2>&1 &` — outlives parent process cleanly.
- Client shows full-screen **deploy overlay** with spinner + elapsed time + attempts counter.
- Polls `/api/status` (1.5s timeout per attempt, 90s hard timeout, validates JSON body to avoid CF error pages) then `location.reload()`.
- Recovers if the initial `POST /api/deploy` returns 502 / times out mid-flight (assumes server restarted, jumps to waiting loop).
- Endpoint `GET /api/deploy/status` fetches origin every 60s from client → sidebar button shows badge "**N new**" when local is behind remote.

## Layout / design
- **Sidebar header** with custom SVG logo (play button + cursor dot, red gradient matching destructive color).
- **Topbar** with breadcrumb `workflow › flow-name` + status badge + close-flow X.
- **Flow header** — three rows with `.fld` classes for consistent column widths (fld-80/150/160/170/180/grow/trigger). Buttons + inline checkbox use `align-self: flex-end` + fixed 32px height to align with input bottoms.
- **Data rows** field removed from UI (server code still supports `flow.dataRows` for programmatic use).
- **Logo color** = red (matches destructive/danger buttons).

## WebSocket detail
- Client picks protocol automatically: `wss://` when page is HTTPS, `ws://` when HTTP. **Critical for VPS deploy** — without this, mixed-content blocks all WS features (live preview, picker frames, log stream, recorded step preview) when accessed via Cloudflare tunnel.

## Analytics
- 8 stat cards: Total runs, Success rate (color-coded), Failed, Stopped, Avg duration, Screenshots, Data extracted, Runs today (+ this week).
- 14-day stacked bar chart with fixed unit coordinates (not percentages) and legend. Success bars green, fail bars red.
- Per-flow table: runs, success rate (color-coded), avg duration.
- Recent failures section: last 5 with flow name, timestamp, first error log line.

## Picker fixes / notes
- **Headless + streamed** via CDP screencast (works on VPS without display).
- Auto-recovers from 409 "already recording" by canceling then retrying.
- Scroll fixed with `page.evaluate(() => window.scrollBy(dx, dy))` (was `mouse.wheel` which needed mouse position).
- Bootstrap `page.screenshot` sent immediately after screencast starts so user sees the page before first CDP frame.

## Known issues / TODO
- **Deferred features**: proxy rotation, video recording of runs, sub-flows visual graph, PWA install, AI-powered self-healing selectors, parallel runs / worker pool, flow templates gallery, extracted data table across runs, drag-drop reorder for step nested arrays (currently top-level only).
- **Multi-user was implemented then reverted** — user preferred single-user mode. Use `settings.password` for basic protection.

## Where we left off (2026-08-07 evening)
Complete productivity boost pass done: command palette + shortcuts + duplicate + folders. Robust self-deploy (git pull + pm2 restart) from dashboard with overlay + 90s tolerant polling. Modal UX polished (auto-injected X + click-outside close). Flow header layout stabilized (`.fld` grid). WSS fix for mixed content on HTTPS. Custom red SVG logo. Analytics fully rebuilt with 8 stats + fixed chart + per-flow table + recent failures.

Live at https://farm.bonusmania.top (Contabo VPS via Cloudflare Tunnel). Deployment workflow: local `git push` → dashboard "Deploy update" button (sidebar footer, shows badge when behind).

Fresh laptop setup:
```
git clone https://github.com/Scroti/playwright-dashboard
cd playwright-dashboard
npm install
npx playwright install chromium
npm start
```
