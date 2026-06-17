#!/usr/bin/env bash
# Cuts a release: bumps the version, commits, tags "v<version>", and with --push
# pushes branch + tag — which triggers .github/workflows/release.yml to build the
# unsigned .zip (web-ext build) and publish the GitHub Release. web-ext builds the
# .zip from the *committed* sources and takes the artifact's version (and filename,
# e.g. rss_spy-1.0.2.zip) from manifest.json — the tag only triggers the workflow and
# names the Release; CI does NOT derive the extension version from the tag. So the
# committed version and the tag must agree, or you'd ship a release named "v1.5.0"
# containing a 1.0.2 extension. manifest.json is the only place the version is
# declared (there is no package.json).
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
export RELEASE_CI_NOTE="CI (release.yml) will now build the web-ext .zip and publish the GitHub Release for <tag>."
export RELEASE_INVOKED_AS="scripts/release.sh"

BIN="${LKM_RELEASE_BIN:-lkm-release}"
command -v "$BIN" >/dev/null 2>&1 || {
  echo "error: lkm-release not found — clone https://github.com/L-K-M/release-tool and run ./install.sh" >&2
  exit 1
}
exec "$BIN" "$@"
