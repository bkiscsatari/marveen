# Agent-runtime réteg (agent-agnosztikus Marveen)

> A Marveen ügynökei nem csak Claude Code-on futnak: egy közös `AgentRuntime` interfész mögött öt futtató él, és az ügynök-definíció (CLAUDE.md, SOUL.md, skillek, `.mcp.json`, `.claude/settings.json` hookok és engedélyek) mindegyikre ugyanaz.

## Három tengely

| Tengely | Értékek | Hol állítod |
|---|---|---|
| **runtime** (ki futtatja az ügynök-loopot) | `claude-tmux` (a régi interaktív TUI tmux-ban), `claude-headless` (`claude -p` stream-json), `codex-cli` (OpenAI Codex CLI), `gemini-cli` (Google Gemini CLI), `native-api` (saját tool-loop az AI SDK-n), `minimax-cli` (MiniMax Code `mcode`, előfizetéssel) | `agents/<id>/agent-config.json` → `"runtime"`; hiányában `MARVEEN_DEFAULT_RUNTIME`, majd a provider szerinti alapértelmezés |
| **provider** (kié a modell) | `anthropic`, `openai`, `google`, `deepseek`, `minimax`, `openrouter`, `ollama`, `moonshot`, `zhipu` | `"provider"`; hiányában a modell-id prefixéből (`claude-`, `gpt-`, `gemini-`, `deepseek-`, `minimax-`, `kimi-`, `glm-`, `x/y` → openrouter, `x:tag` → ollama) |
| **authMode** | `subscription` (CLI-login) / `api` (kulcs a vaultból) | `"authMode"`; a régi `shared`/`own_team` = subscription |

Alapértelmezett runtime provider szerint (viselkedés-semleges): minden vendor, amit a Claude CLI Anthropic-kompatibilis endpointon elér (anthropic, deepseek, minimax, moonshot, zhipu, openrouter, ollama) → `claude-tmux`; `openai` → `codex-cli` (subscription) / `native-api` (api); `google` → `gemini-cli` / `native-api`; `minimax` → `minimax-cli` (subscription) / `claude-tmux` (api, a mai Anthropic-kompatibilis út).

Példa `agent-config.json`:

```json
{ "model": "gpt-5.6-sol", "runtime": "codex-cli", "provider": "openai", "authMode": "subscription",
  "securityProfile": "researcher", "displayName": "Scout" }
```

## Auth runtime-onként

| runtime | subscription | api |
|---|---|---|
| claude-tmux / claude-headless | fleet OAuth token (`CLAUDE_CODE_OAUTH_TOKEN` a `.env`-ben, vagy `store/.claude-oauth-token`) | `ANTHROPIC_API_KEY` vault-id, per-agent: `agent-<id>-api-key` |
| codex-cli | `codex login --device-auth` → `~/.codex/auth.json` (az adapter belinkeli minden agent `.codex/`-ába) | `OPENAI_API_KEY` vault-id → `CODEX_API_KEY` env a futásnak |
| gemini-cli | `NO_BROWSER=true gemini` → `~/.gemini/oauth_creds.json` | `GEMINI_API_KEY` vault-id |
| minimax-cli | `mcode login --region global --no-browser` (eszköz-kódos flow) → `~/.minimax` | `MINIMAX_API_KEY` vault-id (vagy `mcode provider set-minimax-key`) |
| native-api | — | providerenként: `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY`, `openrouter-fleet-key`, `MOONSHOT_API_KEY`, `ZHIPU_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`; Ollama-hoz semmi |

Kanonikus új vault-idk: `provider:<provider>:api-key`, `agent:<id>:api-key` — a régi idk aliasként ELSŐ helyen maradnak, nincs migráció.

## Feature flagek

| Változó | Értékek | Mit tesz |
|---|---|---|
| `MARVEEN_DEFAULT_RUNTIME` | runtime-név | Flotta-szintű default, ha az agent-config nem ad runtime-ot |
| `MARVEEN_WORKER_RUNTIME` | `claude-tmux` (default) / `claude-headless` | A `runAgent()` egylövetű generálásai (scaffold, memória-digest, heartbeat) tmux-worker helyett headless child_process-ben |
| `MARVEEN_BG_RUNTIME` | `legacy-tmux` (default) / runtime-név | Háttérfeladatok a runtime-adapteren (nincs `bg-*` tmux-session, élő kimenet az eseményfolyamból) |
| `CHANNEL_BRIDGE` | `plugin` (default) / `marveen` | A fő-agent Telegram-hídja: Claude channels plugin vs. Marveen saját bridge |
| `MODEL_ROUTING` | `off` (default) / `shadow` / `background` | Jev-router: csak naplóz / a háttérfeladat runtime+modelljét is választja |
| `MARVEEN_RUNTIME_DUMP_DIR` | könyvtár | Nyers JSONL-eseményfolyam mentése fixture-rögzítéshez |
| `MARVEEN_EXTRA_MCP_CONFIG` | fájl | Extra `--mcp-config` a `claude-tmux` indításhoz (a bridge MCP-szervere) |

## Governance minden runtime-on

A 29 hook-script (`scripts/hooks/`) változatlan. Ki futtatja:

- **claude-***: natívan (`.claude/settings.json`).
- **codex-cli**: natívan, `.codex/hooks.json` (a `bundle-render` generálja) + `scripts/hooks/shim/codex-hook.mjs` (tool-név alias, exit-kód/JSON továbbítás).
- **gemini-cli**: natívan, `.gemini/settings.json` `hooks` + `scripts/hooks/shim/gemini-hook.mjs` (esemény- és tool-név fordítás oda-vissza).
- **minimax-cli**: natívan, Claude-formátumú plugin (`~/.minimax/plugins/marveen-hooks-<agent>/.claude-plugin/plugin.json` + `hooks/hooks.json`, a settings.json hookjai változatlanul), `mcode plugin add … -m local`.
- **native-api**: in-process `PolicyEngine` (`src/runtime/policy/engine.ts`) minden tool-hívás előtt/után + `permissions.ts` (a Claude engedély-szintaxis kiértékelése).

A `docs/runtime-parity.md` írja le a paritás-tesztet.

## Modell-profil map több runtime-mal

`store/model-profile-map.json` értéke lehet sima modell-id vagy objektum:

```json
{ "profiles": {
  "premium_reasoning": "claude-opus-5[1m]",
  "build_strong": { "model": "gpt-5.6-sol", "runtime": "codex-cli", "provider": "openai" },
  "analysis_efficient": { "model": "deepseek-chat", "runtime": "native-api" },
  "routine_lowcost": { "model": "qwen2.5:1.5b", "runtime": "native-api", "provider": "ollama" } } }
```

`MODEL_ROUTING=background` esetén a Jev által javasolt profil célja fut a háttérfeladaton; a `model_routing_log` `applied_*`/`fallback_reason` oszlopai mutatják, mi történt.

## Telegram-bridge (CHANNEL_BRIDGE=marveen)

`src/channel/`: grammY long polling → `store/channel-access.json` (allowlist/pairing) → `conversation_log` → `<channel …>` boríték (a plugin formátumával azonos) → a fő-agent runtime-ja. Válasz: a `plugin_telegram_bridge` MCP-szerver `reply`/`send_file`/`edit_message`/`react`/`typing`/`download_attachment` tooljai (`mcp__plugin_telegram_bridge__reply`). Indítás: a dashboarddal együtt (`CHANNEL_BRIDGE=marveen npm run dev`) vagy önállóan (`npm run channel`). Bridge-módban egy `claude-tmux` fő-agent `claude-headless`-ként fut (a TUI-út a `channels.sh` területe marad).

## Hasznos parancsok

```bash
npx tsx scripts/smoke-claude-headless.ts      # valós claude -p kör + háttérfeladat
npx tsx scripts/smoke-codex-cli.ts            # Codex (login nélkül a hibaút)
npx tsx scripts/smoke-gemini-cli.ts           # Gemini (login nélkül a hibaút)
npx tsx scripts/smoke-native-api.ts           # natív loop lokális Ollamán
MARVEEN_RUNTIME_DUMP_DIR=/tmp/dump npx tsx scripts/smoke-claude-headless.ts   # fixture-rögzítés
npm run morning:runtime                       # reggeli briefing bármely runtime-on
```

```bash
npx tsx scripts/smoke-minimax-cli.ts            # MiniMax Code (login nélkül a hibaút)
```
