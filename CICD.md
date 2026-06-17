# CI/CD

RSS Spy is a Manifest V3 browser extension (Firefox/Gecko, via `browser_specific_settings`) that discovers RSS, Atom, and JSON Feed URLs for the current site. This repository uses GitHub Actions to validate the extension on every change and to package a downloadable build whenever a version tag is pushed.

The whole pipeline is built on Mozilla's official [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) tool, pinned as a dev dependency and driven through `npm` scripts. `web-ext-config.cjs` is auto-discovered by every `web-ext` command and keeps lint, build, and signing scoped to the files that actually ship.

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | PRs + pushes to `main` | Lint/validate the extension |
| `.github/workflows/release.yml` | Pushing a `v*` tag | Package the extension and attach it to a GitHub Release |

## Continuous integration (`ci.yml`)

On every pull request and every push to `main`, the workflow:

1. Checks out the repository.
2. Sets up Node.js 20 with npm caching.
3. Installs the pinned tooling with `npm ci` (from the committed `package-lock.json`).
4. Runs `npm run lint` → `web-ext lint`, Mozilla's linter, which validates `manifest.json` and the packaged sources, flagging manifest errors and common add-on problems. It fails the build on **errors**; warnings do not.

A `concurrency` group cancels superseded runs when a branch is pushed again.

### Running locally

```bash
npm install
npm run lint        # web-ext lint
npm run build       # web-ext build  → web-ext-artifacts/rss_spy-<version>.zip
npm run start       # web-ext run    → launches the add-on in a temp Firefox profile
```

## Releases (`release.yml`)

Releases are cut by pushing a version tag — easiest via the shared release tool:

```bash
scripts/release.sh 1.2.3 --push     # bump manifest.json, commit, tag v1.2.3, push
```

or by hand:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The workflow then:

1. Installs the pinned tooling with `npm ci`.
2. **Verifies the tag matches `manifest.json`.** The packaged add-on takes its version from `manifest.json`; the tag only names the Release. If they disagree the build fails, so a Release named `v1.5.0` can never ship a `1.0.3` extension.
3. Packages the extension:
   - If the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` secrets are set, it **signs** through Mozilla Add-ons (`npm run sign`, unlisted channel) and produces an installable **signed `.xpi`**.
   - Otherwise it builds an **unsigned `.zip`** (`npm run build`).
   The artifact is version-stamped (e.g. `rss_spy-1.2.3.zip`) and written to `web-ext-artifacts/`.
4. Attaches the artifact to a new GitHub Release created via [`softprops/action-gh-release`](https://github.com/softprops/action-gh-release), with auto-generated release notes.

An **unsigned** package is suitable for self-distribution or temporary installation. To load it in Firefox, open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and select the `.zip` (or the unzipped `manifest.json`). In a Chromium browser, open `chrome://extensions`, enable **Developer mode**, and use **Load unpacked** on the extracted folder. A **signed** `.xpi` can be installed permanently in Firefox.

## Secrets

No secrets are required for the default (unsigned) pipeline — both workflows run with the default `GITHUB_TOKEN`; `release.yml` requests `contents: write` so it can create releases.

To enable signing, add [Mozilla Add-ons (AMO) API credentials](https://addons.mozilla.org/developers/addon/api/key/) as repository secrets:

| Secret | AMO term | web-ext flag |
| --- | --- | --- |
| `AMO_JWT_ISSUER` | JWT issuer | `--api-key` |
| `AMO_JWT_SECRET` | JWT secret | `--api-secret` |

With both present, tagged releases are signed automatically. Chrome Web Store publishing remains out of scope and would require separate Chrome Web Store API credentials.

## Supply-chain note

`.npmrc` sets `min-release-age=3`, so `npm install` / `npm update` (on npm ≥ 11.10) refuse package versions published less than three days ago — a cheap defense against compromised-release attacks. CI installs the exact, already-vetted versions from the committed lockfile via `npm ci`.
