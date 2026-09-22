# Agent-agnosztikus átalakítás — haladásnapló

Terv: `C:\Users\bkisc\Projects\Marveen_agent_agnostic\PLAN.md` (Windows) / a `~/.claude/plans/` alatti példány.
Klón: `/home/balint/marveen-agnostic`, branch `feat/agent-agnostic`. Az éles `~/marveen` érintetlen.

## Alapállapot (2026-09-22, klón az éles `f88760f` commitról)

- `npm run typecheck`: tiszta.
- `npm test`: 4431 zöld, 1 skip, **2 fájl előre meglévő piros** (nem a mi változásunk):
  - `memory-performance.test.ts` (2 teszt): 5 s timeout, Ollama-hívás nem elérhető a tesztkörnyezetben.
  - `hook-registration-completeness.test.ts`: `agent-forgalom-kapu.py` (2026-09-20-i új hook) nincs regisztrálva és nincs EXEMPT bejegyzése. Éles-oldali teendő, itt nem nyúlunk hozzá.
- 5 további piros CSAK akkor, ha a `.env`-ben `WEB_PORT=3421` áll (egress-gate, bridge-enroll, prompt-injection tesztek a 3420-as alapértelmezést várják). Ezért a dev `.env` NEM tartalmaz portot; a dev dashboard indítása: `WEB_PORT=3421 npm run dev`.

## Phase 0 — klón + runtime-váz + `claude-tmux` adapter (viselkedés-változás nélkül)

Új modulok (`src/runtime/`):
- `types.ts` — `AgentRuntime` interfész, `RuntimeKind`/`ProviderKind`/`AuthMode`, `AgentSpec`, `AgentHandle`, `RunResult`, `UsageRecord`.
- `resolve-spec.ts` — `inferProvider(model)` (az EGYETLEN prefix-heurisztika), `normalizeAuthMode` (a régi `shared|own_team|api` értékeket is érti), `defaultRuntimeFor` (Phase 0: minden Claude-CLI-vel elérhető provider `claude-tmux`-on marad; openai→codex-cli/native-api, google→gemini-cli/native-api), `resolveRuntimeSpec` (config > env `MARVEEN_DEFAULT_RUNTIME` > default; ismeretlen érték = warning, sosem csendes váltás).
- `model-catalog.ts` — provider + context-window + futtatható runtime-ok, csak ellenőrzött ablakokkal; `context-guard.ts contextLimitForModel` először ezt nézi, a régi regex-ek fallbackként maradnak.
- `secret-ids.ts` — `provider:<p>:api-key` / `agent:<id>:api-key` névséma, a régi vault-idk (`DEEPSEEK_API_KEY`, `openrouter-fleet-key`, `agent-<n>-api-key`, …) alias-ként ELSŐ helyen, így nincs vault-migráció.
- `anthropic-compat-env.ts` — a `resolveProviderEnv` áthelyezve az `agent-process.ts`-ből (ott re-export), + Moonshot (`kimi-*`) és Zhipu (`glm-*`) endpoint; openai/google → `unsupported`, üres lánc.
- `shell-quote.ts` — `shSingleQuote` áthelyezve (re-export marad).
- `registry.ts` — `getRuntime(kind)` lusta betöltéssel, `RuntimeNotAvailableError` fázis-megnevezéssel, `defaultRuntimeKind()`.
- `claude-tmux.ts` — a meglévő `startAgentProcess`/`sendPromptToSession`/`agentRunState`/`capturePane`/`runAgent` becsomagolva; `classifyPane` a pane → `idle|busy|blocked|auth|unknown` leképezés.

Módosított meglévő fájlok:
- `src/web/agent-process.ts` — `shSingleQuote`, `ProviderKind`, `resolveProviderEnv` re-export a `runtime/`-ból (a hívók és a tesztek változatlanok).
- `src/web/agent-config.ts` — `readAgentRuntimeConfig`, `resolveAgentRuntimeSpec`, `writeAgentRuntime`, `writeAgentProvider` (opcionális `runtime`/`provider`/`authMode` mezők az `agent-config.json`-ban).
- `src/context-guard.ts` — katalógus-lookup a `contextLimitForModel` elején.

Tesztek: `src/__tests__/runtime-*.test.ts` (resolve-spec, secret-ids, model-catalog, anthropic-compat-env, registry, claude-tmux).

Döntések/feltételezések:
- A Phase 0 defaultja MINDEN meglévő agentnél `claude-tmux` marad (viselkedés-semleges); a worker/háttér `claude-headless` default a Phase 1 flagjei mögé kerül.
- `usageSince` a `claude-tmux` adapterben egyelőre üres listát ad: a transcript-bányászat továbbra is a flotta-szintű `collectTokenUsage` sweep; per-handle olvasás a 7. szakasz usage-refaktorjával jön.

Nyitott owner-teendők (eddig): —

## Phase 1 — `claude-headless` adapter + egylövetű fogyasztók az interfészen

Élő próbák (2026-09-22, Claude Code 2.1.278, `claude -p --output-format stream-json --verbose`): sima szöveg, tool-használat (Read), `--resume` folytatás azonos session-id-vel, kétkörös `--input-format stream-json`, és a `rate_limit_event` (5h/7d kihasználtság). A rögzített kimenetek: `src/__tests__/fixtures/claude-headless/*.jsonl` (köztük az „auth failed” eset is).

Fontos tanulság: a host `~/.claude` **nincs bejelentkezve** ebben a shell-kontextusban; a flotta a `CLAUDE_CODE_OAUTH_TOKEN`-t az éles `.env`-ből kapja. A dev `.env`-be átmásoltam ugyanazt a sort. A headless futás **izolált** `CLAUDE_CONFIG_DIR`-t használ (`~/.<MAIN_AGENT_ID>-headless/.claude-config`, a worker `ensureWorkerCwd`-jével építve: csatorna-pluginok kikapcsolva, `--strict-mcp-config`), mert a host-konfigból indított `-p` futás **betöltötte a Telegram plugint** (409-veszély az éles bottal).

Új modulok:
- `src/runtime/stream-json.ts` — parser + akkumulátor + `summaryToRunResult` (a `classifyAgentResult` újrahasznosításával), `usageFromResult`, `streamShowsAuthFailure`.
- `src/runtime/claude-headless.ts` — az adapter: `run()` child_process + stdin-prompt + JSONL; `spawn/send/state/stop` headless „session” = resume-lánc; `healthProbe` = valós haiku-hívás; `buildHeadlessArgs`/`buildHeadlessEnv`/`resolveFleetOauthToken` tiszta, tesztelt.
- `src/runtime/flags.ts` — `MARVEEN_WORKER_RUNTIME` (`claude-tmux` default | `claude-headless`), `MARVEEN_BG_RUNTIME` (`legacy-tmux` default | bármely runtime).
- `src/runtime/usage-sink.ts` — `token_usage` insert `runtime/provider/cost_usd` oszlopokkal (db.ts migráció).
- `src/runtime/agent-spec.ts` — `buildAgentSpec(agentId, role)`.
- `anthropic-compat-env.ts` — `resolveProviderEnvVars` (strukturált változat a spawn-env-hez).

Módosított: `src/agent.ts` (headless ág a flag mögött, a `runAgent` szerződése változatlan), `src/web/routes/background-tasks.ts` (runtime-alapú futtatás `rt:<kind>:<id>` jelölővel, élő kimenet `onProgress`-ből), `src/web.ts` (nincs tmux-worker előindítás headless módban), `src/db.ts`, `src/runtime/registry.ts`, `types.ts` (`onProgress`).

Döntések:
- A háttérfeladat runtime-módban az **agent saját könyvtárában** fut (a régi út a dashboard cwd-jében futott, agenttől függetlenül).
- `killSession` runtime-módban no-op: a futást a saját timeoutja határolja; explicit megszakítás a Phase 5 handle-kezelésével jön.
- A `MARVEEN_WORKER_RUNTIME=claude-headless` mód nem indít tmux-workert; a `runViaWorker` auth-önjavító ciklusa helyett a headless `blocked+reason` jelzi az auth-hibát (a hívók `if (!text) throw` őre változatlanul működik).

## Phase 2 — `codex-cli` adapter (OpenAI Codex CLI, ChatGPT-előfizetés vagy API-kulcs)

Telepítve a WSL-ben felhasználói prefixbe (`npm i -g --prefix ~/.local`): **codex-cli 0.155.1**, **gemini-cli 0.60.0** (a globális `/usr` prefix nem írható). Mindkettő a `~/.local/bin`-ben, ami a flotta PATH-ján van.

Tényellenőrzés (hivatalos doksi + `codex exec --help`, 2026-09-22): `codex exec --json` JSONL (`thread.started`, `turn.started`, `item.*` {agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error}, `turn.completed{usage}`, `turn.failed`, `error`), prompt stdin-ről (`-`), `resume <thread_id>`, `-m`, `-C`, `-s read-only|workspace-write|danger-full-access`, `-c approval_policy="never"`, `--dangerously-bypass-hook-trust`, `CODEX_HOME`. Hookok: `.codex/hooks.json` (`{"hooks":{Event:[{matcher,hooks:[{type,command,timeout}]}]}}`), stdin-payload lényegében a Claude-hookéval azonos (`session_id, cwd, hook_event_name, tool_name, tool_input`), block = exit 2 vagy `hookSpecificOutput.permissionDecision=deny`; `[features] hooks = true`. **Mérve:** auth nélkül a folyamat `turn.failed`-del zárul, de **exit 0** — a sikert az eseményekből kell olvasni.

Új: `src/runtime/codex-events.ts` (parser, fixture-tesztekkel), `src/runtime/codex-cli.ts` (adapter: `buildCodexArgs`, `buildCodexEnv`, `prepareCodexBundle`, session/resume-lánc, `healthProbe` = `codex login status`), `src/runtime/bundle-render.ts` (AGENTS.md/GEMINI.md a CLAUDE.md+SOUL.md-ből; `config.toml` modell/sandbox/MCP/hooks/trust; `.codex/hooks.json` a `.claude/settings.json` hookjaiból), `scripts/hooks/shim/codex-hook.mjs` (tool-név alias + payload-továbbítás + exit-kód, fail-closed), fixture-ök `src/__tests__/fixtures/codex-cli/` (auth-failed: valós; text-ok: doksiból).

**Nem tesztelt élőben (owner-teendő):** nincs ChatGPT-bejelentkezés és nincs `OPENAI_API_KEY` a vaultban (csak ELEVENLABS_API_KEY, FAL_KEY van). Teendő: `codex login --device-auth` a WSL-ben (a `~/.codex/auth.json`-t az adapter belinkeli minden agent `.codex/`-ába), VAGY `OPENAI_API_KEY` a vaultba (`api` authMode). Utána: `MARVEEN_BG_RUNTIME=codex-cli` háttérfeladat, és `scripts/record-runtime-fixture.sh codex` a valós fixture rögzítéséhez; a `resume` argumentum-sorrend (`exec --json … resume <id> -`) ekkor ellenőrzendő.

## Phase 3 — `gemini-cli` adapter (Google Gemini CLI, Google-login vagy GEMINI_API_KEY)

Tényforrás: gemini-cli 0.60.0 `--help` + a telepített bundle forrása (a doksi csak az esemény-neveket adja). `stream-json` események: `init{session_id,model}`, `message{role,content,delta}`, `tool_use{tool_name,tool_id,parameters}`, `tool_result{tool_id,status,output,error}`, `error{severity,message}`, `result{status,stats{input_tokens,output_tokens,cached,models}}`; exit 0/1/42/53. Hook-payload (hookEventHandler.createBaseInput): `session_id, transcript_path, cwd, hook_event_name, timestamp` + `tool_name/tool_input/tool_response/prompt`; válasz: exit 2 = system block, vagy stdout JSON `decision: deny|block` + `reason`, `hookSpecificOutput.additionalContext`. Auth nélkül: üres stdout, exit 0, stderr „Please set an Auth method…”.

Új: `src/runtime/gemini-events.ts`, `src/runtime/gemini-cli.ts` (`-p <prompt> --output-format stream-json --approval-mode yolo|auto_edit|plan -m … --skip-trust [-r latest]`; resume csak `latest`-tel, mert a Gemini CLI nem tud id-alapú folytatást), `renderGeminiSettings` a `bundle-render.ts`-ben (`.gemini/settings.json`: mcpServers command/args/env | httpUrl/url+headers; hooks BeforeTool/AfterTool/BeforeAgent/AfterAgent/SessionStart/PreCompress, timeout ms-ben), `scripts/hooks/shim/gemini-hook.mjs` (esemény- és tool-név fordítás oda, `permissionDecision=deny` → `decision=deny` és sima stdout → `additionalContext` vissza), GEMINI.md render, fixture (forrásból), tesztek.

**Nem tesztelt élőben (owner-teendő):** nincs Google-bejelentkezés (`~/.gemini/oauth_creds.json`) és nincs `GEMINI_API_KEY` a vaultban. Teendő: `NO_BROWSER=true gemini` a WSL-ben (auth-kód beillesztése), VAGY `GEMINI_API_KEY` a vaultba. Utána `npx tsx scripts/smoke-gemini-cli.ts` + fixture-rögzítés `MARVEEN_RUNTIME_DUMP_DIR`-rel.

## Phase 4 — `native-api` runtime (saját tool-loop a Vercel AI SDK-n, bármely API-kulcsos vendor + lokális Ollama)

Függőségek (verziók `npm view`-ból, 2026-09-22): `ai@7.0.109`, `@ai-sdk/anthropic@4.0.59`, `@ai-sdk/openai@4.0.72`, `@ai-sdk/google@4.0.76`, `@ai-sdk/deepseek@3.0.50`, `@ai-sdk/openai-compatible@3.0.53`, `@openrouter/ai-sdk-provider@3.1.0`, `ollama-ai-provider-v2@4.0.1`, `@modelcontextprotocol/sdk@1.30.0`, `zod@4.6.5`.

Új modulok:
- `src/runtime/permissions.ts` — a Claude Code engedély-szintaxis (`Read(glob)`, `Bash(prefix:*)`, `WebFetch(*)`, `mcp__x__*`, csupasz tool-név) in-process kiértékelése; deny > allow; `strict` profilnál csak az allow-listás megy át, `permissive`-nél csak a deny számít.
- `src/runtime/policy/engine.ts` — **PolicyEngine**: a 29 governance-hook-script futtatása VÁLTOZATLANUL a Claude-hook-protokollal (stdin JSON: `session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input…`; exit 2 = block; stdout JSON `permissionDecision/decision/continue:false` = block, `updatedInput` átírás, `additionalContext`/sima szöveg = kontextus; timeout = fail-open, nem-nulla exit = warning). PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart.
- `src/runtime/native-api/provider.ts` — `modelFor(spec)`: anthropic/openai/google/deepseek natív csomag; MiniMax az Anthropic-protokollon (`…/anthropic/v1`), Moonshot/Zhipu OpenAI-kompatibilisen, OpenRouter, Ollama (`$OLLAMA_URL/api`). Hiányzó kulcs → `MissingApiKeyError` a keresett vault-idkkal (érték soha).
- `src/runtime/native-api/tools.ts` — beépített toolok Claude-névvel (`Read/Write/Edit/Bash/ListDir/WebFetch`), mind kettős kapun (permissions + PolicyEngine); a tiltás `ERROR: … blocked` szövegként megy vissza a modellnek (mint Claude Code-ban), nem dönti a futást.
- `src/runtime/native-api/mcp-client.ts` — az agent `.mcp.json`-jának szerverei (stdio + streamable HTTP) `dynamicTool`-ként, `mcp__<server>__<tool>` néven (a hook-matcherek változatlanok).
- `src/runtime/native-api/history.ts` — `runtime_sessions` tábla (provider-független resume), JSONL transcript-tükör a `transcript_path`-ot olvasó hookoknak, `trimHistory`.
- `src/runtime/native-api/index.ts` — az adapter: system prompt = CLAUDE.md+SOUL.md+skill-index, `generateText` + `stopWhen: stepCountIs(40)`, timeout AbortController-rel, usage → `token_usage`, `Stop`-hook eredménye a `reason`-ben (a Phase 5 bridge kezeli a reply-guard nudge-ot).

Élő ellenőrzés kulcs nélkül: lokális **Ollama `qwen2.5:1.5b`** (letöltve) — `npx tsx scripts/smoke-native-api.ts`: healthProbe, Read-tool hívás strict engedélylistával + valós PreToolUse-hookkal, resume a `runtime_sessions`-ből, `token_usage` sorok. (Egy 1.5B-s modell tool-hívása nem mindig sikerül; a smoke ettől függetlenül a kapukat és a session-kezelést bizonyítja.)

## Phase 5 — saját Telegram-bridge, fő-agent bármely runtime-on

Új `src/channel/`:
- `envelope.ts` — a `<channel source="plugin:telegram:marveen-bridge" chat_id message_id user ts …>` boríték, **bit-kompatibilis** a plugin formátumával (a `ledger-capture.py` CHANNEL_RX-e ellen tesztelve), forgott `</channel>` ellen védve.
- `ledger.ts` — a `conversation_log` TS-ikre (logInbound/logOutbound/openQuestion/recent), azonos idempotencia.
- `access.ts` — `store/channel-access.json` (dmPolicy allowlist|pairing|disabled, allowFrom, groups, pending), egyszeri migráció a plugin `~/.claude/channels/telegram/access.json`-jából; párosítási kód a csatornán, jóváhagyás CSAK owner-oldalon (`approvePending`).
- `reply-guard.ts` — a `telegram-reply-guard.py` szabályai (ack-lexikon, stale, max nudge) külső őrként a Stop-hook nélküli runtime-okhoz.
- `telegram-bridge.ts` — grammY 1.46 long polling; `handleInbound` injektált függőségekkel (tesztelhető), mellékletek letöltése `store/channel-bridge/inbox/`-ba, `image_path`/`attachment_*` attribútumok.
- `mcp-server.ts` — `plugin_telegram_bridge` stdio MCP-szerver: `reply` (→ „sent (id: N)”, a `ledger-outbound.py` ezt parszolja), `send_file`, `edit_message`, `react`, `typing`, `download_attachment`; a tool-id `mcp__plugin_telegram_bridge__reply` illik a hookok `^mcp__plugin_[A-Za-z0-9_]+__reply$` matcherére; a ledger-be közvetlen sqlite-tal ír (INSERT OR IGNORE, nem duplikál a hookkal).
- `service.ts` — `CHANNEL_BRIDGE=marveen|plugin` (default plugin); a fő-agent spec `runtime` mezője szerint fut (`claude-tmux` → bridge-módban `claude-headless`, mert a TUI a `channels.sh` területe); `extraMcpServers`-ként kapja a bridge MCP-t; typing-indikátor busy alatt; reply-guard nudge; halott handle respawn.
- `src/channel-service.ts` — önálló ExecStart (`node dist/channel-service.js`) a `<service>-channels.service`-hez; `scripts/morning-briefing-runtime.ts` — a reggeli briefing bármely runtime-on (fallback: közvetlen küldés, ha az agent nem hívta a reply-t).

Kereszt-vágás: `AgentSpec.extraMcpServers` — minden adapter beolvasztja (claude-headless: generált mcp-fájl `--mcp-config`-gal; codex: config.toml; gemini: settings.json; native-api: közvetlen kapcsolat; claude-tmux: `MARVEEN_EXTRA_MCP_CONFIG` env → `--mcp-config` flag a launcherben). `src/index.ts`: bridge indítás/leállítás a flag mögött.

**Nem tesztelt élőben:** nincs dev Telegram-bot-token (az éles token nem használható, getUpdates-ütközés). A bridge logikája egységtesztelt (boríték-paritás, access, reply-guard, ledger, inbound-kezelés), az MCP-szerver valós stdio-folyamatként tesztelt (tool-lista + hibaút). Owner-teendő: dev-bot a @BotFather-nél, `TELEGRAM_BOT_TOKEN`+`ALLOWED_CHAT_ID` a dev `.env`-be, `CHANNEL_BRIDGE=marveen WEB_PORT=3421 npm run dev`, majd egy üzenet → válasz a headless fő-agenttől.

## Phase 4b — Jev modellrouter runtime-tudatos B1 (háttérfeladatok)

- `src/model-profiles.ts`: a `store/model-profile-map.json` értéke lehet sima modell-id (régi) vagy `{ model, runtime?, provider? }` objektum; `map.profiles` (modell) a régi fogyasztóknak, `map.targets` a teljes hármasnak; `resolveProfileTarget`.
- `src/model-router.ts`: `MODEL_ROUTING=off|shadow|background` (`all` → `background`, amíg az inter-agent respawn-út nincs bekötve); `pickTarget` (tiszta): csak actionable, nem-needs_review döntésre; ha a javasolt cél nem elérhető, **felfelé** (erősebb tier) lép, sosem gyengébbre.
- `src/web/model-routing.ts`: `routeForRun` — a B0 shadow-sort változatlanul beírja, `background` módban a kiválasztott célt alkalmazza és a sorra rástampolja: `applied`, `applied_runtime`, `applied_model`, `fallback_reason` (db.ts ALTER). `targetAvailability`: runtime szállítva-e, provider/runtime pár érvényes-e, kulcs/login (vault; Anthropic+claude-runtime → fleet OAuth; ollama → semmi; codex/gemini → az adapter healthProbe-jára bízva). A kvóta-ablakok (7. szakasz) bekötése a `targetAvailability`-ba a következő lépés.
- `src/web/routes/background-tasks.ts`: runtime-módban (`MARVEEN_BG_RUNTIME`) a spec `runtime/provider/model` hármasát a Jev-cél írja felül; a legacy tmux-út a shadow-logot írja tovább.
- Kill-switch: `MODEL_ROUTING=off`. Mérés: a `shadow_marveen_routing.py` riport a `runtime`/`applied_*` oszlopokkal bővítendő (a Jev-repóban, `~/Projects/Jev/scripts/`).

## Phase 6 — dokumentáció, konfig, paritás-teszt

- `docs/runtime.md` (operátori leírás: tengelyek, auth runtime-onként, flagek, governance, profil-map, bridge), `docs/runtime-parity.md` (paritás-mátrix + automatikus teszt), `.env.example` (új flagek), `config-examples/model-profile-map.example.json` (objektum-forma), README-mutató.
- `src/__tests__/runtime-governance-parity.test.ts`: a VALÓDI `egress-gate.mjs` ugyanazt dönti a PolicyEngine-en, a Codex-shimen és a Gemini-shimen át (tiltott host → deny; allowlistált dashboard-URL → allow).
- `scripts/record-runtime-fixture.sh claude|codex|gemini`: fixture-újrarögzítés `MARVEEN_RUNTIME_DUMP_DIR`-rel, titok-szűréssel.

**Nem került be (szándékosan, owner-döntés kell):** a plugin-út (`channels.sh`, `channel-poller-reap`, `channel-plugin-unlock`, `channel-mcp-reconnect`) törlése/legacy-be mozgatása — a bridge élő tesztje előtt ez korai; a `MODEL_ROUTING=all` (inter-agent/kanban respawn) bekötése — a doksi szerint ≥100 címkézett shadow-sor után; kvóta-ablakok bekötése a `targetAvailability`-ba (a claude-headless `rate_limit_event`-je már elérhető a streamből, a codex `collect_codex()` a `usage-collect.py`-ban).

---

## ÖSSZEFOGLALÓ (2026-09-22)

Branch: `feat/agent-agnostic` a `/home/balint/marveen-agnostic` klónban. Az éles `~/marveen` érintetlen, semmi nem lett merge-elve.

Kész fázisok: 0 (interfész + registry + claude-tmux), 1 (claude-headless + worker/háttérfeladat flagek, **élőben ellenőrizve**), 2 (codex-cli + bundle-render + natív hook-shim; hibaút élőben), 3 (gemini-cli + settings-render + shim; hibaút élőben), 4 (native-api AI SDK tool-loop + PolicyEngine + permissions, **élőben ellenőrizve lokális Ollamán**), 4b (Jev B1 háttérfeladatokra), 5 (saját Telegram-bridge + reply MCP-szerver + fő-agent bármely runtime-on; MCP-szerver valós folyamatként tesztelve), 6 (doksi, konfig, paritás-teszt).

Teszt-állapot: `npm run typecheck` tiszta; `npm test` ≈4660 zöld, 1 előre meglévő piros (`hook-registration-completeness`: az éles `agent-forgalom-kapu.py` nincs regisztrálva — éles-oldali teendő), a `memory-performance` Ollama-időzítéstől függően villog.

### Owner-teendők (ezek nélkül nem megy tovább)
1. **Codex CLI login** a WSL-ben: `codex login --device-auth` (ChatGPT-előfizetés) VAGY `OPENAI_API_KEY` a vaultba; utána `npx tsx scripts/smoke-codex-cli.ts`, majd `scripts/record-runtime-fixture.sh codex`, és a `resume` argumentum-sorrend ellenőrzése.
2. **Gemini CLI login**: `NO_BROWSER=true gemini` (auth-kód) VAGY `GEMINI_API_KEY` a vaultba; `npx tsx scripts/smoke-gemini-cli.ts`; fixture-rögzítés.
3. **Dev Telegram-bot** a @BotFather-nél; a dev `.env`-be `TELEGRAM_BOT_TOKEN` + `ALLOWED_CHAT_ID`; `CHANNEL_BRIDGE=marveen WEB_PORT=3421 npm run dev` → egy üzenet → válasz a headless fő-agenttől; utána `codex-cli`/`gemini-cli` fő-agent ugyanígy.
4. **Vault-kulcsok** a natív loophoz (DeepSeek/MiniMax/OpenRouter…): a vaultban ma csak ELEVENLABS_API_KEY és FAL_KEY van.
5. **Merge-döntés**: a flagek alapértelmezése a régi viselkedés (`claude-tmux`, `legacy-tmux`, `CHANNEL_BRIDGE=plugin`, `MODEL_ROUTING=off`), így a merge önmagában nem változtat az élesen; az átkapcsolás flagenként történhet.

## Phase 7 — `minimax-cli` runtime (MiniMax Code `mcode`, előfizetéssel)

Tények (`@minimax-ai/code` 0.5.1, `mcode exec --help` + bundle, 2026-09-22): `mcode exec --input - --output-format stream-json --permission full|smart|off --model minimax/<Model> --cwd <dir> [--session <id> | --continue] [--config <yaml>] [--timeout] [--max-steps] [-o <file>]`; stream-json = borítékolt események (`exec.started` → `session.started|resumed` → `turn.started` → `item.started|updated|completed{item:{reasoning|agent_message|tool_call}}` → `turn.completed{model,usage,durationMs}`|`turn.failed` → `exec.completed{result}`); `--output-format json` = `exec.result` dokumentum; exit 3 = nincs bejelentkezve. Auth: `mcode login --region global --no-browser` (eszköz-kód, csak az owner tudja), tároló `$MINIMAX_DATA_DIR` (`~/.minimax`), API-kulcs alternatíva `MINIMAX_API_KEY`. Projekt `.mcp.json` és `AGENTS.md`/`CLAUDE.md` natívan betöltve. **Hookok:** az `mcode` Claude-formátumú plugint fogad (`.claude-plugin/plugin.json` + `hooks/hooks.json`) Claude-payloaddal és Claude-válaszdialektussal, a helyi marketplace a `~/.minimax/plugins` könyvtár → a 29 governance-hook shim NÉLKÜL, natívan fut (`marveen-hooks-<agent>` plugin a `~/.minimax/plugins` alatt: a könyvtár puszta jelenléte = telepítve+engedélyezve; a `plugin add` a helyi marketplace-re `LOCAL_PLUGIN_INSTALL_UNSUPPORTED`).

Új: `src/runtime/minimax-events.ts`, `src/runtime/minimax-cli.ts` (`mcodeModelId`: `minimax-m3` → `minimax/MiniMax-M3`; per-agent `.minimax/runtime-config.yaml`; extra MCP a workspace `.mcp.json`-ba olvasztva; plugin-render + idempotens install; `healthProbe` = `mcode provider list`), `scripts/smoke-minimax-cli.ts`, fixture (forrásból), tesztek; `resolve-spec`: `minimax` + `subscription` → `minimax-cli`, `api` (a mai default) → változatlanul `claude-tmux`.

A Windows-oldali `~/.minimax` login másolása a WSL-be **nem** működött (a CLI továbbra is bejelentkezést kért), ezért a WSL-ben `mcode login` kell: a folyamat háttérben várt az owner jóváhagyására (URL + kód a chatben).

**Élőben ellenőrizve (2026-09-22, MiniMax-előfizetés, `mcode login` eszköz-kóddal):** health-probe OK; Read-tool futás → `marveen-probe-42`; a natív PreToolUse hook **Claude-payloaddal** hívódott (`tool_name: "Read"`, `tool_input.file_path`, `tool_use_id`, `session_id`, `transcript_path`); `--session` folytatás ugyanabban a sessionben („42”); `token_usage` sor `runtime='minimax-cli'`. A valódi folyamból javított séma: `usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`, `toolCall.input` + numerikus státusz (2 = kész). Fixture-ök: `src/__tests__/fixtures/minimax-cli/recorded-*.jsonl`.
