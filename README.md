# RSS Spy

RSS Spy is a Firefox extension that detects RSS/Atom/JSON feeds for the currently open page.

# Features

- Scans the current page for feed candidates using:
  - metadata tags (`<link>` and `<meta>`)
  - in-page links and content signals
  - common feed-path heuristics (for example `/feed`, `/rss`, `/atom.xml`)
- Validates feed candidates in the background to reduce false positives.
- Highlights the extension icon badge when feeds are found.
- Shows a feed list in the popup when the icon is clicked.
- Copies a feed URL to the clipboard when a feed item is clicked.

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

At this point, you should also open `manifest.json` and set the `applications.gecko.id` field to a unique identifier for your extension.

## 3. Build the extension:

```bash
web-ext build --overwrite-dest
web-ext sign --api-key="[JWT issuer]" --api-secret="[JWT secret]" --channel="unlisted"
```

This creates a ZIP file called `web-ext-artifacts/skip_that_noise-1.0.zip`, and the signed extension called `web-ext-artifacts/[id]-[version].xpi`.

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