#!/usr/bin/env bash
# Scan the PR head (the current checkout) and its base (a git worktree). prehello only reads files; nothing from the
# repository is executed. HOME, PATH and the system root are empty folders, so only the repository's own agent files
# count (an agent installed on the runner, e.g. Cursor.app or a `cursor` binary on PATH, never changes the result).
set -euo pipefail
out="${RUNNER_TEMP:?}/prehello"
rm -rf "$out" && mkdir -p "$out/home" "$out/sysroot" "$out/nobin"
node_bin="$(command -v node)"
root="${GITHUB_WORKSPACE:-$PWD}"
rel="${SCAN_PATH:-.}"
case "$rel" in /*|*..*) echo "::error::path must be relative to the repository and must not contain .."; exit 1 ;; esac

scan() { # <folder> <snapshot>
  local code=0
  HOME="$out/home" USERPROFILE="$out/home" XDG_CONFIG_HOME="$out/home/.config" PATH="$out/nobin" \
    "$node_bin" "${PREHELLO_BIN:?}" "$1" --system-root "$out/sysroot" --quiet --no-color --ceiling "$2" --save "$3" >/dev/null || code=$?
  # 3 = finished with warnings: still a valid snapshot
  if [ "$code" != 0 ] && [ "$code" != 3 ]; then echo "::error::prehello failed on $1 (exit $code)"; exit 1; fi
}

scan "$root/$rel" "$root" "$out/head.json"

if [ -z "${BASE_SHA:-}" ]; then
  echo "::notice::no pull request base; comparing head with itself"
  cp "$out/head.json" "$out/base.json"
  exit 0
fi
git -C "$root" cat-file -e "$BASE_SHA^{commit}" 2>/dev/null || git -C "$root" fetch --no-tags --depth=1 origin "$BASE_SHA"
git -C "$root" worktree add --detach "$out/base-tree" "$BASE_SHA" >/dev/null 2>&1
trap 'git -C "$root" worktree remove --force "$out/base-tree" >/dev/null 2>&1 || true' EXIT
if [ -d "$out/base-tree/$rel" ]; then
  scan "$out/base-tree/$rel" "$out/base-tree" "$out/base.json"
else
  mkdir -p "$out/empty" && scan "$out/empty" "$out/empty" "$out/base.json"
fi
