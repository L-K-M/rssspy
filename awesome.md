# RSS Spy — Code Review & Ideas

A thorough review of the extension as of v1.0.3. Organized into bugs, general
issues, missing features, and improvement ideas. Items marked **[planned]**
are being implemented in companion PRs; the rest are recorded here for future
work.

## Overall impression

The code is in good shape. The SSRF protection story (policy gate →
DNS pre-check → blocking `webRequest` guard re-vetting every redirect hop) is
unusually thorough for a feed-finder extension, the candidate
normalize/dedupe/merge logic is careful, and the validation pipeline
(specific MIME fast-path, body sniffing with a byte cap, stale-scan
invalidation) is solid. The findings below are mostly edge cases and polish,
not structural problems.

## Bugs

### B1. Per-tab scan state is lost when the event page suspends **[planned]**

`background.js` keeps all per-tab state in an in-memory `Map` (`tabState`).
Firefox MV3 background scripts are *event pages*: they are terminated after
~30 seconds of inactivity and restarted on demand. When that happens the map
is wiped, but the per-tab badge (managed by the browser) survives — so the
user sees a badge saying "3", clicks it, and the popup answers "No feeds
found" because the freshly restarted background reports `status: "idle"`.

**Fix:** write-through the per-tab state to `browser.storage.session`
(in-memory, cleared on browser exit, survives event-page restarts) and
hydrate from it on demand. Requires the `storage` permission and Firefox
≥ 115, which should be encoded as `strict_min_version`.

### B2. Popup gives up while validation is still running **[planned]**

`fetchStateWithRetries(tab.id, 10, 300)` polls for at most ~3 seconds, but a
single candidate fetch is allowed 7 seconds (`FETCH_TIMEOUT_MS`) and a full
scan (provided batch + guessed batch, 24 candidates at concurrency 6) can
legitimately take ~30 seconds on a slow site. After 3 seconds the popup
shows "Reopen popup in a second", which is a dead end the user has to drive
manually. The popup should keep polling for as long as it is open (the scan
is bounded anyway).

### B3. Stale state after back/forward-cache navigation

Content scripts do not re-run when a page is restored from the BFCache, and
`tabs.onUpdated` does not reliably fire a `"loading"` status for such
restores. Navigating A → B → back-to-A can leave the badge and popup showing
B's feeds while the user looks at A. A `pageshow` listener in the content
script (re-sending the scan when `event.persisted` is true) would fix this.

### B4. Bare `*.xml` URL pattern invites sitemap noise **[planned]**

`FEED_URL_PATTERN` in `content-script.js` treats *any* URL ending in `.xml`
as feed-like. `sitemap.xml`, `wp-sitemap.xml`, `browserconfig.xml`, and
`crossdomain.xml` links are common, so they regularly become confidence-66
candidates that consume the candidate budget and trigger pointless fetches
(validation does reject them, but only after downloading up to 64 KB each).
A small denylist for the well-known non-feed XML filenames eliminates the
bulk of the noise.

### B5. "Meta feed hint" candidates can be garbage URLs **[planned]**

In `collectFromMetaTags`, a `<meta>` whose name merely matches
`\b(rss|atom|feed)\b` gets its `content` submitted as a candidate even when
the content is not a URL at all (e.g. `<meta name="feed-count"
content="12">`). The string `12` resolves as a relative URL against the page
and produces a junk same-site request. The hint-only branch should require
the content to actually look like a URL.

## General issues

### G1. DNS rebinding TOCTOU window (known limitation)

`resolvesToPublicAddresses` resolves a hostname, approves it, and then the
actual fetch resolves it *again* — a hostile DNS server can answer with a
public address for the check and a private one for the connection.
WebExtensions provide no way to pin a resolved address to a request, so this
is not really fixable at this layer; worth documenting in the README so the
threat model is explicit. (The guard still blocks literal-IP and
known-internal-suffix targets on every hop, which is the realistic bulk of
the risk.)

### G2. Body sniffing assumes UTF-8

`decodeByteChunks` always decodes with a UTF-8 `TextDecoder`. Feeds declared
as ISO-8859-1/Windows-1251/GB2312 will produce replacement characters. The
ASCII-range markup the sniffer looks for (`<rss`, `<feed`, …) survives any
ASCII-compatible encoding, so detection still works, but any text *extracted*
from the body (see F1) should be treated as best-effort. Honoring the
`charset` from the `Content-Type` header would cover most real cases.

### G3. `<feed`/`<rss` substring sniffing can false-positive

`looksLikeFeed` matches `FEED_XML_PATTERN` anywhere in the first 64 KB. An
HTML page that embeds raw (unescaped) `<rss` or `<feed` inside a code sample
and is served with a generic XML content type would validate. Exotic, and
the candidate still has to be linked as feed-like, so the risk is low — but
anchoring the match near the start of the document (after the XML prolog /
comments) would be stricter.

### G4. Utility duplication between contexts

`toHttpUrl`, `cleanTitle`, `clampConfidence`, and `stringify` are duplicated
across `content-script.js`, `background.js`, and `popup.js`. With the
buildless constraint this is hard to avoid entirely (content scripts cannot
`import` without bundling), but the duplicates have already started drifting
(the content-script `toHttpUrl` rejects `mailto:`/`javascript:` explicitly,
the background one doesn't need to). Worth a comment in each copy pointing
at its siblings.

### G5. No automated checks **[planned]**

There is no CI at all. `web-ext lint` currently passes with zero warnings —
cheap to keep it that way with a tiny GitHub Actions workflow. The pure
functions in `background.js` (IPv4/IPv6 parsing, `isPublicHostname`,
`looksLikeFeed`) are also eminently unit-testable and security-relevant;
a dependency-free node test that evaluates `background.js` with a stubbed
`browser` global would lock in the SSRF behavior.

### G6. Badge text color is left to the browser default

`setBadgeBackgroundColor` is set (`#5b7386` scanning, `#d97706` found) but
`setBadgeTextColor` is not; on some themes the default text color has poor
contrast against the amber. Explicitly setting white text is a one-liner.

## Missing features

### F1. Real feed titles **[planned]**

The popup currently shows the `<link title="…">` attribute or a slug derived
from the URL ("feed", "atom xml"). The validator already downloads up to
64 KB of the feed body — the feed's own `<title>` (RSS/Atom) or `"title"`
(JSON Feed) is sitting right there in the sample and is almost always the
best label ("Daring Fireball", not "feed"). Extract it during validation and
prefer it.

### F2. Feed format identification **[planned]**

`feed.contentType` is already sent to the popup but never displayed, and
generic types (`text/xml`) don't identify the format anyway. Detect the
actual format (RSS / Atom / JSON Feed) from the content type or body during
validation and show it as a chip in the popup.

### F3. Distinguish declared vs. guessed feeds in the popup **[planned]**

The pipeline carefully tracks `explicit` (page-declared) vs. heuristic
candidates, but the popup flattens everything into the same list. A feed the
site advertises is more trustworthy than one found by probing `/feed`; a
small "declared" chip surfaces that.

### F4. Open feed in a new tab **[planned]**

Click-to-copy is the only action. Power users often want to *look* at the
feed (or hand the URL to a reader extension that intercepts feed URLs).
Ctrl/Cmd+click and middle-click opening the feed in a new background tab
keeps the primary copy gesture intact.

### F5. Dark mode **[planned]**

The popup is light-only. A `prefers-color-scheme: dark` block over the
existing CSS custom properties is cheap and makes the popup feel native for
the (large) dark-theme crowd.

### F6. SPA navigation awareness

The content script runs once at `document_idle`. On single-page apps
(YouTube, Reddit's new UI, Twitter…) subsequent in-app navigations never
re-scan, so the badge reflects the first page visited. Options:
`webNavigation.onHistoryStateUpdated` in the background (new permission) or
a debounced `MutationObserver` / `popstate`+`pushState` hook in the content
script.

### F7. Localization

All strings are hardcoded English. WebExtensions i18n (`_locales/`,
`browser.i18n.getMessage`) is buildless-friendly.

## Novel / delightful ideas

### I1. Site recipes for famous feed-hiding sites **[planned]**

Some of the most-wanted feeds live on sites that don't advertise them:

- **YouTube**: every channel has
  `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` and every
  playlist has `…?playlist_id=…` — derivable from the page's canonical
  link / meta tags.
- **GitHub**: every repo has `/<owner>/<repo>/commits.atom`,
  `/releases.atom`, and `/tags.atom`.
- **Reddit**: any subreddit/user page has a `.rss` twin.

A small "recipe" layer in the content script turns RSS Spy into the tool
that finds feeds *nobody else finds*. (Mastodon profile `.rss` URLs and
`hnrss.org` for Hacker News are tempting too, but HN's would be cross-site
for a non-declared candidate, which the SSRF policy rightly forbids —
recipes must stay same-site.)

### I2. Feed preview on hover/expand

The validator already has a body sample. Persist the first few item titles
and show them in an expandable section per feed — instant "is this the feed
I want?" without leaving the popup.

### I3. OPML export

A "Copy all as OPML" button assembling the validated feeds into an OPML
snippet, ready to paste-import into any feed reader. All data is already on
hand; it's ~20 lines of string building.

### I4. "Subscribe with…" handoff

Optional setting holding a reader URL template (e.g.
`https://feedly.com/i/subscription/feed/%s`,
`https://www.inoreader.com/feed/%s`, or a self-hosted FreshRSS); clicking a
feed opens the template with the URL substituted. Turns copy-paste into one
click.

### I5. Item count / freshness hint

While extracting the title (F1), count `<item>`/`<entry>` occurrences and
grab the first `pubDate`/`updated` in the sample. A subtle "≈20 items ·
updated 2d ago" line tells the user whether a feed is alive — heuristic
probes often validate long-abandoned feeds.

### I6. Badge animation while scanning

The "..." badge is static. Cycling `.`, `..`, `...` during validation is a
tiny, charming touch (just keep the timer bounded so the event page can
sleep).

### I7. Per-site mute list

An options page with "never probe this site" (skips heuristic probing) for
users who notice the speculative `/feed` requests in their logs, plus a
global "explicit candidates only" privacy mode.

---

*Companion PRs implement: B1+G5 manifest/state hardening, B2+F1–F5 popup &
metadata upgrades, B4+B5+I1 content-script detection upgrades, and a
`web-ext lint` CI workflow.*
