# bkiscsatari/marveen — a fork rendszerleírása

> Állapot: 2026-10-26 (a fork `main`-je: `8e24afe`, 2026-09-23). Ez a lap azt írja le, **miben tér el
> ez a fork** az eredeti [Szotasz/marveen](https://github.com/Szotasz/marveen) repótól, hogyan épül fel
> a hozzáadott réteg, hol fut, és hogyan követjük az upstreamet. A Marveen alapfunkcióinak
> (memória, kanban, heartbeat, flotta, csatornák…) leírása a [README](../README.md)-ben és a
> [docs/](README.md) lapjain van, ezek az upstreamből jönnek.

## 1. Viszony az upstreamhez

| | |
|---|---|
| Upstream | `Szotasz/marveen` (MIT licenc) — **nem a mi repónk**: oda nem pusholunk és PR-t sem nyitunk (owner-döntés, 2026-09-23) |
| Fork | `bkiscsatari/marveen` — **publikus**; a saját fejlesztések itt élnek |
| Eltérés (2026-10-26) | a fork 43 committal jár az upstream előtt, és 454 committal le van maradva mögötte; az utolsó beolvasztott upstream: **v1.39.0** (`787e37e`, 2026-09-22) |
| Saját branchek a GitHubon | `main`, `feat/agent-agnostic`, `feat/crm1leadkapu922-lead-gate` (a többi branch az upstreamből másolódott a fork létrehozásakor) |

### Upstream-követés és a push-zár

A helyi klónokban az `upstream` remote **csak olvasásra** van beállítva:

```bash
git remote -v
# origin    https://github.com/bkiscsatari/marveen.git (fetch/push)
# upstream  https://github.com/Szotasz/marveen.git (fetch)
# upstream  DISABLE (push)
```

Upstream-újítások behúzása: `git fetch upstream && git merge upstream/main` egy külön branchen
(mint a `merge/upstream-v1.39`), ütközésfeloldás, `npm run typecheck && npm test`, majd beolvasztás a
`main`-be és push az `origin`-ra. A v1.39.0-s merge feloldásai és nyitott döntései:
[agent-agnostic-progress.md](agent-agnostic-progress.md) „Upstream v1.39.0 merge”.

## 2. Mit ad hozzá a fork

| Terület | Mit | Részletes leírás |
|---|---|---|
| **Agent-agnosztikus runtime réteg** | Egy közös `AgentRuntime` interfész mögött hat futtató: `claude-tmux`, `claude-headless`, `codex-cli`, `gemini-cli`, `native-api` (saját tool-loop a Vercel AI SDK-n: DeepSeek, MiniMax, OpenRouter, Moonshot, Zhipu, OpenAI, Gemini, Anthropic, lokális Ollama), `minimax-cli`. Az ügynök-definíció (CLAUDE.md, SOUL.md, skillek, `.mcp.json`, hookok, engedélyek) mindegyikre ugyanaz. A Claude Code marad az első osztályú alapértelmezés. | [runtime.md](runtime.md) |
| **Governance minden runtime-on** | A 29 hook-script változatlanul fut: Claude-on natívan, Codexen és Geminin natív hook + shim (`scripts/hooks/shim/`), MiniMax Code-on telepítésenként egyedi nevű, `cwd`-re szűkített plugin, a natív loopban in-process `PolicyEngine` + Claude-szintaxisú engedély-kiértékelés. A biztonsági kapuk hibánál **tiltanak** (fail-closed). | [runtime.md](runtime.md) „Governance”, [runtime-parity.md](runtime-parity.md) (6 kritikus kapu × 5 végrehajtási út mátrix) |
| **Headless session-agentek** | Egy sub-agent, akinek a runtime-ja nem `claude-tmux`, a dashboard session-loopján fut: tartós kör-journal (crash után visszajátszás), korlátos sor, folytatási token dashboard-restart után is, naplógomb a kártyán; az üzenet-router, a kanban, az ütemező és a reconciler változtatás nélkül működik vele. | [runtime.md](runtime.md) „Headless session-agentek” |
| **Saját Telegram-bridge** | `CHANNEL_BRIDGE=marveen`: grammY long polling, allowlist/pairing, saját reply MCP-szerver (`plugin_telegram_bridge`), így a fő-agent bármely runtime-on futhat. | [runtime.md](runtime.md) „Telegram-bridge” |
| **Jev model routing** | A TypeSafe AI Jev minden delegált feladatnál modell-**profilt** javasol (`routine_lowcost` … `premium_reasoning`); `shadow` módban csak naplóz, `background` / `all` módban (csak nyitott **mérési kapuval**: `store/model-routing-calibration.json`) a háttérfeladatok és a Jev-routed agentek runtime+modelljét is választja, hiszterézissel. | [model-routing.md](model-routing.md); a mérés: `bkiscsatari/Jev` repó |
| **Hardening** (2026-09-22/23) | Egy CLI-futtató és egy session-lánc a négy CLI-adapternek; titkok ki a renderelt configokból; a reader sub-agent karantén (egress) módja; port-visszaszerzés nem öl más telepítés dashboardját; valós célpont-elérhetőség (CLI-login, kvóta-cooldown); a Codex/Gemini a választóban „kísérleti”. | [agent-agnostic-progress.md](agent-agnostic-progress.md) „Hardening” |
| **Mérési szabályok** | A flotta közös szabályai arról, mikor nevezhető egy mért szám állításnak. | [meresi-jegyzokonyv-szabalyok.md](meresi-jegyzokonyv-szabalyok.md) |

## 3. A runtime réteg felépítése

```mermaid
flowchart TB
    subgraph Callers["Marveen fogyasztók (upstream kód, változatlan interfészen)"]
        MR[message-router<br/>inter-agent]
        KB[kanban dispatch]
        BG[háttérfeladatok]
        SCH[ütemező / heartbeat /<br/>memória-digest]
        CH[fő-agent csatorna<br/>src/channel/]
    end
    JEV[Jev router<br/>src/web/model-routing.ts<br/>routing-gate.ts]
    RS[resolve-spec.ts<br/>agent-config.json → runtime · provider · authMode]
    REG[registry.ts — AgentRuntime]
    subgraph Adapters["src/runtime/"]
        A1[claude-tmux]
        A2[claude-headless<br/>claude -p stream-json]
        A3[codex-cli + codex-events]
        A4[gemini-cli + gemini-events]
        A5[minimax-cli + minimax-events]
        A6[native-api<br/>AI SDK tool-loop + mcp-client]
    end
    POL[policy/engine.ts + permissions.ts<br/>scripts/hooks/shim/*]
    BR[bundle-render.ts<br/>.codex/hooks.json, .gemini/settings.json, plugin]
    HL[web/headless-agents.ts<br/>session-loop, journal, queue]

    MR & KB & BG & SCH --> JEV
    JEV -. profil → store/model-profile-map.json .-> RS
    MR & KB & BG & SCH & CH --> RS --> REG
    REG --> A1 & A2 & A3 & A4 & A5 & A6
    A3 & A4 & A5 --> BR
    A6 --> POL
    BR --> POL
    REG --> HL
```

Fontosabb modulok: `types.ts` / `agent-spec.ts` (az interfész és a feloldott spec), `cli-process.ts` /
`child-registry.ts` (közös CLI-futtató, árva gyerekfolyamatok eltakarítása induláskor), `stream-json.ts`
/ `stream-dump.ts` (eseményfolyam-értelmezés, fixture-rögzítés), `quota-state.ts` / `usage-sink.ts`
(kvóta és használat), `secret-ids.ts` (vault-azonosítók: `provider:<provider>:api-key`,
`agent:<id>:api-key`, régi aliasokkal), `env-flags.ts` / `flags.ts` (a feature flagek a `.env`-ből is),
`model-catalog.ts`, `anthropic-compat-env.ts`.

**Feature flagek** (mind a régi viselkedésre állnak alapból, így a kód beolvasztása önmagában nem
változtat semmin): `MARVEEN_DEFAULT_RUNTIME`, `MARVEEN_WORKER_RUNTIME`, `MARVEEN_BG_RUNTIME`,
`CHANNEL_BRIDGE`, `MODEL_ROUTING`, `MARVEEN_RUNTIME_DUMP_DIR`, `MARVEEN_EXTRA_MCP_CONFIG` — részletek:
[runtime.md](runtime.md) „Feature flagek”.

## 4. Hol fut

- **Éles példány**: WSL (Ubuntu) `~/marveen`, a fork `main`-je; dashboard `http://localhost:3420`,
  `systemctl --user` alatt (`icuka-dashboard`); a fő-agent `icuka-channels`. Adatbázis:
  `store/claudeclaw.db` (SQLite), állapotfájlok a `store/` alatt.
- **Fejlesztői klón**: WSL `~/marveen-agnostic` (origin = a helyi `~/marveen`), a fejlesztés itt
  folyik branchen, és fast-forwarddal kerül az éles `main`-re (deploy-checklist és visszaállás:
  [agent-agnostic-progress.md](agent-agnostic-progress.md) „Éles deploy-checklist”).
- A WSL-ből a GitHubra pusholáshoz a git hitelesítést külön be kell állítani (pl. `gh auth setup-git`);
  addig a Windows oldali git-tel lehet pusholni a `\\wsl.localhost\Ubuntu\home\balint\marveen` útvonalról.

## 5. Tesztelés

`npm run typecheck`, `npm test` (≈ 4660 teszt; ismert: a `hook-registration-completeness` egy
éles oldali regisztrációs hiány miatt piros, a `memory-performance` Ollama-időzítéstől függően villog),
paritás-teszt ([runtime-parity.md](runtime-parity.md)), és valós smoke-ok runtime-onként
(`scripts/smoke-*.ts`). A CLI-adapterek tesztjei élőben rögzített fixture-ökön futnak
(`src/__tests__/fixtures/<runtime>/`).

## 6. Nyitott owner-teendők

- Codex CLI és Gemini CLI bejelentkezés (vagy API-kulcs a vaultba), utána a paritás-mátrix élő
  ellenőrzése és fixture-rögzítés.
- Dev Telegram-bot a saját bridge élő próbájához.
- Vault-kulcsok a natív loophoz (DeepSeek / MiniMax / OpenRouter…).
- Jev: a kalibrációs fájl írása és jóváhagyása csak ≥ 100 címkézett sor után.
- Az upstream 454 commitjának behúzása (v1.39.0 óta) — külön merge-branchen, a fenti menettel.
