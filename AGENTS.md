# AGENTS

This repository hosts a Firefox extension that discovers RSS/Atom/JSON feeds for the current page.

## Project structure

- `manifest.json`: Firefox WebExtension manifest (MV3).
- `content-script.js`: Collects feed candidates from page metadata, links, and heuristic paths. Marks candidates the page explicitly declares (feed `<link>`/typed `<a>`) as `explicit`.
- `background.js`: Validates candidate URLs, tracks per-tab scan state, and updates action badge/title. Enforces SSRF protections (public-host only, DNS resolution checks) and re-validates every request — including redirect hops — with a blocking `webRequest` guard.
- `popup/popup.html`: Popup shell.
- `popup/popup.css`: Popup styling.
- `popup/popup.js`: Popup rendering and clipboard copy behavior.
- `icons/rss.svg`, `icons/no-rss.svg`: Toolbar icons for feed found vs. no feed found.

## Agent guidelines

- Keep the extension buildless (plain JavaScript/CSS/HTML).
- Prefer deterministic heuristics and explicit confidence scoring for feed candidates.
- Avoid destructive git operations; never discard user edits.
- If you add new detection logic, keep false positives low by validating candidates in `background.js`.
- Preserve the SSRF protections: only request public hosts, keep guessed/heuristic candidates same-site, and never let validation reach a private/internal address (the `webRequest` guard must vet every hop).
- When changing messaging contracts (e.g. the candidate object fields), update both `content-script.js` and `popup/popup.js`/`background.js` together.

## Manual validation checklist

1. Load extension in Firefox via `about:debugging` -> "This Firefox" -> "Load Temporary Add-on".
2. Visit sites with known feeds (e.g. blogs with `/feed` endpoints).
3. Confirm badge appears with feed count.
4. Open popup and verify discovered feeds are listed.
5. Click a feed and confirm the URL is copied to clipboard.
