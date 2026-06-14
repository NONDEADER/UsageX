# UsageX v2

**[🌐 Website](https://usagex.carrd.co/)** &nbsp;·&nbsp; **[🦊 Install on Firefox](https://addons.mozilla.org/en-US/firefox/addon/usagex/)**

> A Firefox (Manifest V3) extension that tracks your **Claude.ai** usage and renders a live stats sidebar directly on the page — no popup, no external server, no third-party libraries.

---

## Features

- **Session & Weekly usage bars** — real-time percentage consumed from Claude's 5-hour and 7-day token windows, read straight from the API response.
- **Usage rate indicator** — a colour-coded pulse dot that shows whether you are on pace (`~20%/h`), burning fast (`≥30%/h`), or well under budget.
- **Peak-hours clock** — a 24-hour timeline strip that highlights the high-traffic window (6:30 PM – 12:30 AM IST) so you know when limits deplete faster.
- **Effort breakdown** — tracks how many messages were sent at each thinking level (Low / Medium / High / Max) and estimates token cost accordingly.
- **Session & daily stats** — messages sent, conversations started, and active time on Claude today.
- **Messages-remaining estimate** — derived from your average token cost per message in the current 5-hour session.
- **Reset countdowns** — live display of time remaining until session and weekly limits reset.
- **Minimise / float / resize** — dock the panel in the Claude sidebar (left or right), detach it as a floating widget, or resize it freely.
- **Keyboard shortcut** — `Alt+U` toggles the panel open/closed from anywhere on the page.
- **Debug viewer** — built-in log viewer (`debug-viewer.html`) for inspecting raw event logs.
- **CSV export** — one-click export of today's stats and 30-day history.
- **Privacy-first** — all data stays in `browser.storage.local`; zero network calls are made by the extension itself.

---

## How it works

```
Claude page fetch()
        │
   inject.js (MAIN world)          ← intercepts window.fetch
        │  postMessage
        ▼
   content.js (ISOLATED world)     ← parses usage limits & messages
        │  browser.storage.local
        ▼
   background.js                   ← midnight reset alarm, storage init
```

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3, Firefox-first with Chrome compat shim) |
| `content.js` | Core logic: sidebar injection, UI updates, event binding, usage rate calc |
| `background.js` | Service worker: midnight data roll-over via `browser.alarms` |
| `inject.js` | MAIN-world fetch hook; posts usage data & message bodies to `content.js` |
| `debug-viewer.html/css/js` | Standalone page for inspecting stored debug logs |
| `icons/` | Extension icons (16 × 16, 48 × 48, 128 × 128) |

---

## Installation

### Firefox (recommended)

Install directly from the official listing — no restart required:

**[➜ Add to Firefox](https://addons.mozilla.org/en-US/firefox/addon/usagex/)**

Or load it as a temporary add-on from source:

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**
3. Select the `manifest.json` file inside this folder.
4. Open [https://claude.ai/](https://claude.ai/) — the sidebar panel appears automatically.

> **Note:** Temporary add-ons loaded from source are removed when Firefox restarts.

## Installation (Chrome / Edge — developer mode)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select this folder.
4. Open [https://claude.ai/](https://claude.ai/).

> The extension uses `var browser = chrome` as a compatibility shim when the `browser` global is absent, so it works in Chromium browsers without modification.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves today's stats, 30-day history, and settings locally |
| `alarms` | Schedules a midnight reset to roll over daily counters |
| `activeTab` | Required by MV3 for the content-script host permission |
| `host_permissions: claude.ai` | Allows the content script and fetch hook to run on Claude |

---

## Settings

Open the ⚙ panel from the sidebar header to access:

- **Debug logging** — toggle verbose event logging (stored in `browser.storage.local`).
- **Sidebar side** — dock the panel on the left or right of the Claude sidebar.
- **Floating mode** — detach the panel so it floats anywhere on screen.
- **Opacity** — control floating-widget transparency (10 – 100%).
- **Resizable** — enable drag-to-resize handles on the floating panel.
- **Timezone** — override the timezone used for reset-time display (defaults to browser locale).

---

## Notes

- Token counts are intentionally approximate and labelled `~est` in the UI. Claude does not expose exact token counts in the browser API; input length is estimated from character count (`chars ÷ 4`) and thinking tokens are estimated per effort level.
- The sidebar uses no Shadow DOM; it injects directly into the Claude nav element and is fully styled with scoped CSS custom properties (`--ux-*`) to avoid leaking into or inheriting from Claude's own styles.
- No build step is required. All code is plain JavaScript (ES2020+) and runs directly in the browser.

---

## License

MIT
