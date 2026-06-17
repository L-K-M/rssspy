#!/usr/bin/env bash
# Cuts a release: bumps the version in manifest.json, updates the README
# <!-- version --> marker (if present), commits, tags "v<version>", and with --push
# pushes branch + tag — which triggers .github/workflows/release.yml. CI re-checks
# that the tag matches manifest.json, then packages the extension with web-ext
# (signing through Mozilla Add-ons when AMO credentials are configured, otherwise an
# unsigned .zip) and publishes the GitHub Release. CI packages the *committed* sources
# and takes the artifact's version from manifest.json — the tag only triggers the
# workflow and names the Release; it is NOT the version source. So the committed
# version and the tag must agree (the release.yml guard fails the build otherwise).
# manifest.json is the single source of truth for the version; package.json is tooling
# config and declares no version, so the engine leaves it untouched.
#
#   scripts/release.sh 1.3.0          # bump manifest.json + README, commit, tag v1.3.0
#   scripts/release.sh 1.3.0 --push   # …also push the commit + tag (CI then publishes)
#   scripts/release.sh                # tag the current version as-is
#
# Usage: scripts/release.sh [X.Y.Z] [--push]
# Shared engine: https://github.com/L-K-M/release-tool (this stub only sets config).
set -euo pipefail

export RELEASE_APP_NAME="RSS Spy"
export RELEASE_KIND="webext"
export RELEASE_CI_NOTE="CI (release.yml) will verify the tag, package the extension with web-ext, and publish the GitHub Release for <tag>."
export RELEASE_INVOKED_AS="scripts/release.sh"

BIN="${LKM_RELEASE_BIN:-lkm-release}"
command -v "$BIN" >/dev/null 2>&1 || {
  echo "error: lkm-release not found — clone https://github.com/L-K-M/release-tool and run ./install.sh" >&2
  exit 1
}
exec "$BIN" "$@"
