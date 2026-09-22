# minimax-cli fixtures

- `text-ok.jsonl` — **source-derived** (NOT recorded): event envelope and item/result shapes taken from the installed `@minimax-ai/code` 0.5.1 bundle (`chunks/run-exec-command-*.js`, the Exec event projector and `exec.result` builder). Re-record with a live login: `MARVEEN_RUNTIME_DUMP_DIR=/tmp/d npx tsx scripts/smoke-minimax-cli.ts` or `scripts/record-runtime-fixture.sh minimax`.
- Auth-less run (recorded 2026-09-22): empty stdout, **exit 3**, stderr `mcode exec failed: Sign in to MiniMax to use Agent features. Run \`mcode login\`, then retry.` — covered by a unit test.
- `recorded-probe-ok.jsonl`, `recorded-tool-read.jsonl`, `recorded-resume.jsonl` — **recorded live** on 2026-09-22 (mcode 0.5.1, MiniMax subscription, model MiniMax-M2.7-highspeed): health probe, a Read-tool run with a native PreToolUse plugin hook, and a `--session` resume.
