# RSS Spy

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

# Permanent Installation

To install the extension permanently, you need to package and sign it. `web-ext` is Mozilla's official command-line tool for building and signing extensions.

## 1. Install web-ext:

```bash
npm install --global web-ext
```

## 2. Setup your Mozilla Add-ons account:

Register on [addons.mozilla.org](https://addons.mozilla.org). Then generate API credentials from [addons.mozilla.org/en-US/developers/addon/api/key/](https://addons.mozilla.org/en-US/developers/addon/api/key/).

At this point, you should also open `manifest.json` and set the `browser_specific_settings.gecko.id` field to a unique identifier for your extension.

## 3. Build the extension:

Store your AMO credentials in `../web-ext-credentials.env`:

```bash
WEB_EXT_API_KEY="your-api-key"
WEB_EXT_API_SECRET="your-api-secret"
```

Then run:

```bash
chmod +x build.sh
./build.sh
```

This creates build artifacts in `web-ext-artifacts/`, including a signed `.xpi` if signing succeeds. Running `./build.sh` without `../web-ext-credentials.env` creates only the unsigned build artifact.

## 4. Install the signed extension:

You can now go to Firefox's Extension Manager (`about:addons`), click on the gear icon, and select "Install Add-on From File..." to install the signed extension.

# Testing During Development

Run the extension in a temporary Firefox instance:

```bash
web-ext run
```

# Linting

Check for common issues:

```bash
web-ext lint
```
