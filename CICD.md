# CI/CD

RSS Spy is a Manifest V3 browser extension (Firefox/Gecko, via `browser_specific_settings`) that discovers RSS, Atom, and JSON Feed URLs for the current site. This repository uses GitHub Actions to validate the extension on every change and to package a downloadable build whenever a version tag is pushed.

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | PRs + pushes to `main` | Lint/validate the extension |
| `.github/workflows/release.yml` | Pushing a `v*` tag | Package the extension and attach it to a GitHub Release |

## Continuous integration (`ci.yml`)

On every pull request and every push to `main`, the workflow:

1. Checks out the repository.
2. Sets up Node.js 20.
3. Runs `npx --yes web-ext lint --source-dir .` — Mozilla's [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) linter validates `manifest.json` and the extension sources, flagging manifest errors and common add-on problems.

`manifest.json` lives at the repository root, so the source directory is `.`. There is no build tooling to install; `web-ext` is fetched on demand via `npx`. A `concurrency` group cancels superseded runs when a branch is pushed again.

### Running locally

```bash
npx web-ext lint --source-dir .
```

## Releases (`release.yml`)

Releases are cut by pushing a version tag:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The workflow runs:

```bash
npx --yes web-ext build --source-dir . --artifacts-dir web-ext-artifacts --overwrite-dest
```

This produces an **unsigned** `.zip` in `web-ext-artifacts/` (named from the extension's name and version, e.g. `rss_spy-1.0.2.zip`). That `.zip` is attached to a new GitHub Release created via [`softprops/action-gh-release`](https://github.com/softprops/action-gh-release), with auto-generated release notes.

The artifact is suitable for self-distribution or temporary installation. To load it in Firefox, open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and select the `.zip` (or the unzipped `manifest.json`). In a Chromium browser, open `chrome://extensions`, enable **Developer mode**, and use **Load unpacked** on the extracted folder.

## Secrets

No secrets are required. Both workflows run entirely with the default `GITHUB_TOKEN`; `release.yml` requests `contents: write` so it can create releases.

Store publishing is out of scope. As future options:

- A signed Firefox `.xpi` (for permanent installation / AMO listing) would require [Mozilla Add-ons (AMO) API credentials](https://addons.mozilla.org/developers/addon/api/key/) used with `web-ext sign --api-key … --api-secret …`, supplied as repository secrets.
- Chrome Web Store publishing would require Chrome Web Store API credentials.
