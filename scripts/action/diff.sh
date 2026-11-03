#!/usr/bin/env bash
set -euo pipefail
out="${RUNNER_TEMP:?}/prehello"
args=("$out/base.json" "$out/head.json")
if [ -n "${FAIL_ABOVE:-}" ]; then args+=(--fail-above "$FAIL_ABOVE"); fi
code=0
node "${PREHELLO_BIN:?}" diff "${args[@]}" --markdown > "$out/comment.md" || code=$?
if [ "$code" != 0 ] && [ "$code" != 2 ]; then echo "::error::prehello diff failed (exit $code)"; exit 1; fi
cat "$out/comment.md" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
delta=$(node "$PREHELLO_BIN" diff "$out/base.json" "$out/head.json" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents;let m=0;for(const x of a)if(Math.abs(x.delta)>Math.abs(m))m=x.delta;console.log(m)})')
{ echo "delta=$delta"; echo "over=$([ "$code" = 2 ] && echo true || echo false)"; } >> "${GITHUB_OUTPUT:-/dev/null}"
