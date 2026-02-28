# Evensee - Auth Capture

Chrome extension that captures authentication headers from browser network requests with one click. Ready-to-paste JSON for Playwright & AI coding agents.

## The Problem

When working with AI coding agents (Claude, Cursor, Copilot) that can browse the web via Playwright, they can't access sites where you're logged in. Sharing passwords is unsafe.

**Evensee** captures your auth headers in one click and formats them as ready-to-use JSON for `page.setExtraHTTPHeaders()` or `context.addCookies()`.

## Features

- **One-click capture** — click Capture, page reloads, headers are captured
- **Multi-origin grouping** — headers grouped by actual request domain (API, CDN, etc.)
- **Smart filtering** — tracking cookies & analytics domains automatically excluded
- **Auto-stop** — stops listening after strong auth headers are captured
- **Copy as JSON** — ready to paste into Playwright scripts or AI agent prompts
- **Collapsed view** — shows max 3 headers per site, expandable with "Show more"

## Security

- **Memory only** — headers stored only in service worker memory, never persisted to disk
- **Auto-clear** — configurable timer (5m / 30m / 60m / manual)
- **Clipboard auto-clear** — clears clipboard after copy (30s / 2m / off)
- **Zero network** — extension makes zero outbound requests, ever
- **On-demand only** — no background monitoring, listeners active only during capture
- **Domain + tab scoped** — captures only for the specific tab you clicked

## Install

### From Chrome Web Store
Coming soon.

### From source
1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder

## Output Format

```json
{
  "tab": "example.com",
  "capturedAt": "2026-02-28T14:30:00.000Z",
  "origins": {
    "api.example.com": {
      "Authorization": "Bearer eyJ...",
      "Cookie": "session_id=abc123"
    },
    "cdn.example.com": {
      "Cookie": "cf_clearance=..."
    }
  }
}
```

## Permissions

| Permission | Why |
|---|---|
| `webRequest` | Read-only access to network request headers |
| `activeTab` + `tabs` | Get current tab URL |
| `clipboardWrite` | Copy headers to clipboard |
| `alarms` | Auto-clear timers |
| `offscreen` | Clipboard clear after timeout |
| `storage` | Persist settings (auto-clear time) |
| `host_permissions: <all_urls>` | Capture headers from any domain |

## Tech

- Chrome Extension Manifest V3
- Pure HTML/CSS/JS — zero dependencies, zero build step
- Service worker for background capture
- Port-based messaging between popup and service worker

## License

MIT
