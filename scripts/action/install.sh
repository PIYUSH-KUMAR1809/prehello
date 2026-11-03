#!/usr/bin/env bash
# Install prehello for the Action: a pinned npm version, or build the copy the action was checked out from.
set -euo pipefail
dir="${RUNNER_TEMP:?}/prehello-tool"
mkdir -p "$dir"
if [ -n "${PREHELLO_VERSION:-}" ]; then
  case "$PREHELLO_VERSION" in *[!0-9A-Za-z.+-]*) echo "::error::version must look like 1.0.0"; exit 1 ;; esac
  npm install --prefix "$dir" --no-audit --no-fund --ignore-scripts "prehello@$PREHELLO_VERSION" >/dev/null
  echo "PREHELLO_BIN=$dir/node_modules/prehello/dist/cli.js" >> "$GITHUB_ENV"
else
  # The action's own source is trusted (it is the ref in `uses:`), never the PR's code.
  cp -R "${ACTION_PATH:?}/." "$dir/src-copy"
  (cd "$dir/src-copy" && npm ci --no-audit --no-fund --ignore-scripts >/dev/null && npm run build >/dev/null)
  echo "PREHELLO_BIN=$dir/src-copy/dist/cli.js" >> "$GITHUB_ENV"
fi
