# RSS Spy

**Version:** [<!-- version -->1.0.3<!-- /version -->](https://github.com/L-K-M/rssspy/releases/latest)

RSS Spy is a Firefox extension that detects RSS/Atom/JSON feeds for the currently open page.

> [!IMPORTANT]
> LLM Disclosure: Much of this code base was written with the help of large language models — AI coding agents working from the [`AGENTS.md`](AGENTS.md) brief in this repo.

# Features

- Scans the current page for feed candidates using:
  - metadata tags (`<link>` and `<meta>`)
  - in-page links and content signals
  - common feed-path heuristics (for example `/feed`, `/rss`, `/atom.xml`)
- Validates feed candidates in the background to reduce false positives.
- Highlights the extension icon badge when feeds are found.
- Shows a feed list in the popup when the icon is clicked.
- Copies a feed URL to the clipboard when a feed item is clicked.

# Permissions

RSS Spy requests the following permissions:

- `tabs`: identify the active tab so the popup can show feeds for the page you are viewing.
- `clipboardWrite`: copy a feed URL when you click it in the popup.
- `dns`: resolve candidate feed hostnames so requests to private/internal addresses can be blocked before they are sent.
- `webRequest` / `webRequestBlocking`: re-check every validation request the extension makes — including each redirect hop — and cancel any that target a non-public address. This is what lets the extension safely follow redirects while still avoiding requests to internal hosts.
- `<all_urls>` (host permission): read the current page and fetch its candidate feed URLs for validation.

The extension only fetches feed candidates that belong to the site you are visiting; feeds hosted on another domain are fetched only when the page explicitly declares them (for example via `<link rel="alternate" type="application/rss+xml">`).

# Temporary Installation

1. Open `about:debugging` in Firefox.
2. Select **This Firefox**.
3. Click **Load Temporary Add-on**.
4. Choose the repository `manifest.json` file.

# Development

The tooling is [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/), Mozilla's official command-line tool, driven through `npm` scripts. Install it once:

```bash
npm install
```

Then:

```bash
npm run lint     # validate the manifest and sources (web-ext lint)
npm run build    # package an unsigned .zip into web-ext-artifacts/
npm run start    # run the add-on in a temporary Firefox profile (web-ext run)
```

`npm run build` writes a version-stamped archive, e.g. `web-ext-artifacts/rss_spy-1.0.3.zip`, containing only the runtime files.

# Permanent Installation

To install the extension permanently in Firefox, it must be signed by Mozilla. Set `browser_specific_settings.gecko.id` in `manifest.json` to a unique id you control, generate [Mozilla Add-ons API credentials](https://addons.mozilla.org/en-US/developers/addon/api/key/), then:

```bash
export WEB_EXT_API_KEY="your-jwt-issuer"
export WEB_EXT_API_SECRET="your-jwt-secret"
npm run sign
```

This writes a signed `.xpi` to `web-ext-artifacts/`. Install it via Firefox's Extension Manager (`about:addons`) → gear icon → "Install Add-on From File…".

# Releases

Releases are cut by pushing a version tag. The shared [release tool](https://github.com/L-K-M/release-tool) does it in one step:

```bash
scripts/release.sh 1.2.3 --push     # bump manifest.json, commit, tag v1.2.3, and push
```

Pushing the `v*` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies the tag matches `manifest.json`, packages the extension with `web-ext` (signing through Mozilla Add-ons when the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` secrets are set, otherwise an unsigned `.zip`), and publishes a GitHub Release with auto-generated notes. Every pull request and push to `main` is linted by [`.github/workflows/ci.yml`](.github/workflows/ci.yml). The `<!-- version -->` marker near the top of this file is kept in step by the release tool. See [CICD.md](CICD.md) for the full pipeline.
