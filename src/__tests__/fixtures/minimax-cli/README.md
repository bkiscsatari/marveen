# minimax-cli fixtures

- `text-ok.jsonl` — **source-derived** (NOT recorded): event envelope and item/result shapes taken from the installed `@minimax-ai/code` 0.5.1 bundle (`chunks/run-exec-command-*.js`, the Exec event projector and `exec.result` builder). Re-record with a live login: `MARVEEN_RUNTIME_DUMP_DIR=/tmp/d npx tsx scripts/smoke-minimax-cli.ts` or `scripts/record-runtime-fixture.sh minimax`.
- Auth-less run (recorded 2026-09-22): empty stdout, **exit 3**, stderr `mcode exec failed: Sign in to MiniMax to use Agent features. Run \`mcode login\`, then retry.` — covered by a unit test.
- `recorded-*.jsonl` — live captures, if present (see the file header comment inside).
