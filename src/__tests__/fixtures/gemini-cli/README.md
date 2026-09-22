# gemini-cli fixtures

- `text-ok.jsonl` — **source-derived** (NOT recorded): event shapes taken from the installed gemini-cli 0.60.0 bundle (`streamFormatter.emitEvent` call sites in the non-interactive CLI and `StreamJsonFormatter.convertToStreamStats`). Re-record with a real login/key: `MARVEEN_RUNTIME_DUMP_DIR=... npx tsx scripts/smoke-gemini-cli.ts`.
- Auth-less run (recorded 2026-09-22): the CLI prints nothing on stdout and exits 0 with stderr `Please set an Auth method in your ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA` — covered by a unit test, no fixture file needed.
