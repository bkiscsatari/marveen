# Governance-paritás a runtime-ok között

A kérdés: ugyanaz a kapu ugyanazt dönti-e, bármelyik runtime hívja. A válasz kétrétegű.

## 1. Automatikus paritás-teszt (vitest)

`src/__tests__/runtime-governance-parity.test.ts` a **valódi** `scripts/hooks/egress-gate.mjs`-t futtatja három úton, ugyanazzal a tool-hívással:

| Út | Runtime | Mechanizmus | Elvárt |
|---|---|---|---|
| PolicyEngine | native-api | in-process `preToolUse('WebFetch', {url})` | tiltott host → `allowed=false`, allowlistált → `allowed=true` |
| codex-hook.mjs | codex-cli | Codex-payload (tool_name `web_fetch`) → shim → script | tiltott → exit 2 vagy `permissionDecision=deny`; engedett → exit 0 |
| gemini-hook.mjs | gemini-cli | Gemini-payload (`BeforeTool`, `web_fetch`) → shim → script | tiltott → `decision=deny`; engedett → nincs deny |

A Claude Code (claude-tmux / claude-headless) út a referencia: ott a script natívan fut, a payload-alakot a shimek pontosan azt állítják elő.

Futtatás: `npx vitest run src/__tests__/runtime-governance-parity.test.ts`

## 2. Kézi parity-mátrix (élő futtatáshoz, fázis-végi checklist)

| Eset | Kapu | claude-tmux | claude-headless | codex-cli | gemini-cli | native-api |
|---|---|---|---|---|---|---|
| WebFetch nem-allowlistált hostra | `egress-gate.mjs` (PreToolUse) | natív | natív | shim | shim | PolicyEngine |
| Email-küldés | `email-send-gate.mjs` (PreToolUse `Bash|.*send_email.*`) | natív | natív | shim | shim | PolicyEngine + MCP-tool `mcp__*__send_email` |
| Boríték nélküli „restart” prompt | `provenance-gate.py` (UserPromptSubmit → flag) | natív | natív | shim (UserPromptSubmit) | shim (BeforeAgent) | PolicyEngine (`userPromptSubmit`) |
| Nyitott kérdés válasz nélkül | `telegram-reply-guard.py` (Stop) | natív | natív | shim (Stop) | shim (AfterAgent) | PolicyEngine `stop()` + bridge reply-guard nudge |
| Kimenő másolat-szűrés | `outgoing-copy-gate.py` | natív | natív | shim | shim | PolicyEngine |
| Ütemező/self-pace | `self-pace-gate.mjs` | natív | natív | shim (`Bash|apply_patch|…`) | shim (`run_shell_command|write_file|replace`) | PolicyEngine |

Ismert korlátok:
- Codex/Gemini alatt a nyers `bash` a CLI **saját sandboxában** fut (`sandbox_mode=workspace-write` / `approval-mode`), a hook a Marveen-oldali döntés; a kettő együtt adja a védelmet.
- A `PreCompact` `type: "agent"` hook (memória-mentés) csak Claude Code-ban létezik; a többi runtime-on a kontextus-őr explicit „mentsd a memóriát” promptot küld.
- A `capabilities().supportsHooks` értéke a dashboardon látszik (`native` / `policy-engine`), így a gyengébb réteg sosem csendes.
