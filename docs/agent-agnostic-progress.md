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
