# codex-cli fixtures

- `auth-failed.jsonl` — **recorded live** on 2026-09-22 from `codex exec --json --skip-git-repo-check` (codex-cli 0.155.1) with no login: transport retries, an `item.completed` error item, `turn.failed`. Note the process exit code was **0**.
- `text-ok.jsonl` — **doc-derived** (NOT recorded): assembled from the official non-interactive-mode sample (learn.chatgpt.com/docs/non-interactive-mode) plus the SDK `Usage` type fields (sdk/typescript/src/events.ts). Re-record with a real login: `scripts/record-runtime-fixture.sh codex`.
