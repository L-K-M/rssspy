# RSS Spy

RSS Spy is a Firefox WebExtension that detects RSS/Atom/JSON feeds for the currently open page.

## Features

- Scans the current page for feed candidates using:
  - metadata tags (`<link>` and `<meta>`)
  - in-page links and content signals
  - common feed-path heuristics (for example `/feed`, `/rss`, `/atom.xml`)
- Validates feed candidates in the background to reduce false positives.
- Highlights the extension icon badge when feeds are found.
- Shows a feed list in the popup when the icon is clicked.
- Copies a feed URL to the clipboard when a feed item is clicked.

## Project layout

- `manifest.json` - Firefox MV3 manifest.
- `content-script.js` - page scanning and candidate discovery.
- `background.js` - candidate validation, tab state, and badge updates.
- `popup/popup.html` - popup markup.
- `popup/popup.css` - popup styles.
- `popup/popup.js` - popup rendering and copy-to-clipboard behavior.
- `icons/rss.svg`, `icons/no-rss.svg` - toolbar icons for feed found vs. no feed found.
- `PLAN.md` - implementation plan and status notes.
- `AGENTS.md` - repository-specific contributor/agent guidance.

## Run locally in Firefox

1. Open `about:debugging` in Firefox.
2. Select **This Firefox**.
3. Click **Load Temporary Add-on**.
4. Choose the repository `manifest.json` file.

## Manual validation checklist

1. Visit sites with known feeds.
2. Confirm the action badge appears with a count when feeds exist.
3. Open the popup and verify discovered feeds are listed.
4. Click a listed feed and confirm its URL is copied.
