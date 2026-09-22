#!/bin/bash
# Re-record the raw JSONL event streams the runtime parsers are tested against.
#   scripts/record-runtime-fixture.sh claude   -> src/__tests__/fixtures/claude-headless/
#   scripts/record-runtime-fixture.sh codex    -> src/__tests__/fixtures/codex-cli/
#   scripts/record-runtime-fixture.sh gemini   -> src/__tests__/fixtures/gemini-cli/
# Needs the corresponding login/key on this host. Runs the smoke script with
# MARVEEN_RUNTIME_DUMP_DIR set, then copies the newest dump next to the
# existing fixtures with a timestamp so nothing is overwritten silently.
set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INSTALL_DIR"
KIND="${1:-}"
case "$KIND" in
  claude) SMOKE=scripts/smoke-claude-headless.ts; DIR=src/__tests__/fixtures/claude-headless; PREFIX=claude-headless;;
  codex)  SMOKE=scripts/smoke-codex-cli.ts;       DIR=src/__tests__/fixtures/codex-cli;       PREFIX=codex-cli;;
  gemini) SMOKE=scripts/smoke-gemini-cli.ts;      DIR=src/__tests__/fixtures/gemini-cli;      PREFIX=gemini-cli;;
  *) echo "usage: $0 claude|codex|gemini" >&2; exit 2;;
esac
DUMP="$(mktemp -d)"
trap 'rm -rf "$DUMP"' EXIT
MARVEEN_RUNTIME_DUMP_DIR="$DUMP" npx tsx "$SMOKE" || true
STAMP="$(date +%Y%m%d-%H%M%S)"
n=0
for f in "$DUMP"/"$PREFIX"-*.jsonl; do
  [ -f "$f" ] || continue
  n=$((n+1))
  if grep -qE 'sk-ant-|oat01|CODEX_API_KEY|GEMINI_API_KEY' "$f"; then echo "!!! secret-like string in $f -- not copied" >&2; continue; fi
  cp "$f" "$DIR/recorded-$STAMP-$n.jsonl"
  echo "recorded -> $DIR/recorded-$STAMP-$n.jsonl"
done
[ "$n" -gt 0 ] || { echo "no dump produced (login/key missing?)" >&2; exit 1; }
echo "Now review the new files, rename them to replace the fixtures the tests read, and update the fixture README."
