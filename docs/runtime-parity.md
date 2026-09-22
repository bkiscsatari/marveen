# Governance-paritás a runtime-ok között

A kérdés: ugyanaz a kapu ugyanazt dönti-e, bármelyik runtime hívja.

## 1. Automatikus paritás-mátrix (vitest)

`src/__tests__/runtime-governance-parity-matrix.test.ts` a hat kritikus esetet a **valódi** hook-scriptekkel futtatja
mind az öt végrehajtási úton, azzal a payload-alakkal, amit az adott runtime ténylegesen küld:

| Út | Runtime | Mechanizmus |
|---|---|---|
| claude | claude-tmux, claude-headless | a script maga, Claude-payload (referencia) |
| native | native-api | `PolicyEngine` in-process |
| codex | codex-cli | `scripts/hooks/shim/codex-hook.mjs`; Bash = `shell` argv-tömbbel (`["bash","-lc",…]`) |
| gemini | gemini-cli | `scripts/hooks/shim/gemini-hook.mjs`; Gemini eseménynevek (`BeforeTool`, `BeforeAgent`, `AfterAgent`), `web_fetch` = `{prompt}` a URL-lel a szövegben |
| minimax | minimax-cli | `scripts/hooks/shim/scope-hook.mjs` (az mcode natívan a Claude-formátumot futtatja; a wrapper agentre szűkít) |

| # | Eset | Kapu | Elvárt minden úton |
|---|---|---|---|
| 1 | WebFetch nem-allowlistált hostra / a dashboardra | `egress-gate.mjs` | deny / allow |
| 2 | Email-küldés shellből (`sendmail`) és MCP `send_email`-lel / sima parancs | `email-send-gate.mjs` | deny / allow |
| 3 | Boríték nélküli „mehet a restart” / ugyanez bridge-borítékban | `provenance-gate.py` (UserPromptSubmit) | flag (PROVENANCE-KAPU kontextus) / csend |
| 4 | Megválaszolatlan Telegram-kérdés a turn végén | `telegram-reply-guard.py` (Stop) | block |
| 5 | Tiltott név kimenő Telegram-válaszban — a plugin ÉS a bridge reply-tooljával / tiszta szöveg | `outgoing-copy-gate.py` | deny / allow |
| 6 | `ScheduleWakeup`, `tmux send-keys` önbeinjektálás / `echo` | `self-pace-gate.mjs` | deny / allow |

Futtatás: `npx vitest run src/__tests__/runtime-governance-parity-matrix.test.ts`

Kiegészítő tesztek:
- `runtime-governance-parity.test.ts` — egress több URL-lel egy Gemini-promptban, URL nélküli prompt (deny), Codex argv-shell, összeomló kapu mindkét shimen (fail-closed).
- `runtime-governance-hardening.test.ts` — PolicyEngine matcher/fail-closed/SessionStart, Bash-szabályok összetett parancsokon, útvonal-korlát, hook-átírás, history-költségvetés.

## 2. Mit NEM bizonyít a mátrix (élő ellenőrzés kell)

- **Codex és Gemini élőben**: a shimek a CLI-k dokumentált/forrásból kiolvasott payload-alakját kapják; valódi bejelentkezett futás még nem volt (owner-teendő: login, majd `scripts/record-runtime-fixture.sh`).
- **A Stop-blokk hatása**: a mátrix azt bizonyítja, hogy a kapu *dönt*; hogy a Codex `Stop` / Gemini `AfterAgent` blokk után a CLI valóban folytatja-e a turnt, élőben mérendő. A native-api egy folytató kört futtat a blokk okával (Claude-szemantika); a bridge ezen felül utólagos nudge-ot küld.
- **MiniMax payload `cwd`**: a `scope-hook.mjs` csak akkor hagy ki egy hívást, ha a payloadban van `cwd` és az az agent könyvtárán kívül esik; `cwd` nélkül a hook fut (szigorúbb irány). A `scripts/smoke-minimax-cli.ts` kiírja a valódi payload kulcsait.

## 3. Ismert korlátok

- Codex/Gemini/MiniMax alatt a nyers shell a CLI **saját sandboxában** fut (`workspace-write` / `approval-mode` / `permission`), a hook a Marveen-oldali döntés; a kettő együtt adja a védelmet. A native-api Bash-toolja allowlistes env-vel, saját process-groupban fut, de nem sandboxolt.
- A Bash-szabályok (deny-lista) nem shell-parszer: heredoc, függvény, `eval`, változóba rejtett URL továbbra is átmehet — ezért deny-lista, nem sandbox (ld. `docs/security-hardening.md`).
- A `PreCompact` `type: "agent"` hook (memória-mentés) csak Claude Code-ban létezik.
- A `capabilities().supportsHooks` értéke a dashboardon látszik (`native` / `policy-engine`), így a gyengébb réteg sosem csendes.
