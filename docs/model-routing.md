# Jev model routing (Phase B0 — shadow)

> A feladat komplexitása döntse el a modellt, ne egy fix beállítás. Első lépés: mérni, nem kapcsolni.

---

## Mit csinál most (B0)

Minden delegált feladatnál — inter-agent üzenet kézbesítése (`src/web/message-router.ts`),
kanban → agent dispatch (`src/web/routes/kanban.ts`), háttérfeladat indítása
(`src/web/routes/background-tasks.ts`) — a rendszer **a kézbesítéstől függetlenül** megkérdezi a
TypeSafe AI Jev modelljét, melyik **modell-profil** (`src/model-profiles.ts`: `routine_lowcost`,
`analysis_efficient`, `build_strong`, `premium_reasoning`) illik a feladathoz, és az eredményt a
`model_routing_log` táblába írja a ténylegesen használt modell mellé.

**Semmit nem vált át.** A kézbesítés nem várja meg a választ, hiba esetén csak egy `error` sor
keletkezik. Kikapcsolt állapotban (`MODEL_ROUTING=off`, alapértelmezés) egyetlen hívás sem történik.

Miért profil és nem modellnév: a Jev soha nem lát és nem ad vissza vendor-modell-azonosítót; a
konkrét modellt továbbra is a `store/model-profile-map.json` és az operátor dönti ("no silent
model change").

## Bekapcsolás

```
# .env
MODEL_ROUTING=shadow
TYPESAFE_API_KEY=...        # https://console.typesafe.ai/keys
```

Dashboard-újraindítás után él. Ellenőrzés:

```
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/model-routing
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/model-routing/log?limit=10"
```

## Mit küld ki a gépről

Csak: forrás (`inter_agent|kanban|background`), cél-agent id, a cél-agent `securityProfile`-ja, és a
feladat szövege **legfeljebb 6000 karakterig**, credential-mintákra maszkolva (`scrubSecrets` a
`src/model-router.ts`-ben). A TypeSafe nem tanít ügyféladaton (privacy policy), zero-data-retention
enterprise-nak kérhető. A Jev csak angolul teljesít legjobban; a flotta magyarul dolgozik — a shadow
log pont azt mutatja meg, mennyire megbízható ez nálunk.

## Kérdések (egy hívásban, ld. `buildRoutingQuestions`)

| kulcs | típus | mire |
|---|---|---|
| `profile` | choice (4 profil + `needs_review`) | az elsődleges javaslat |
| `complexity` | score trivial…expert | ordinális második nézet a kalibrációhoz |
| `multi_step`, `needs_code_change`, `needs_web_research` | noul | jellemzők a riporthoz |
| `risky_action` | noul | ≥0,5 esetén a javaslat **sosem gyengébb** `build_strong`-nál |

`needs_review` kötelező opció: a Jev magától nem tartózkodik (out-of-scope inputra is 0,9+
confidence), ezért kell neki hely, ahová a nem-feladatot teheti.

## Riport és a B1 döntés

A `~/Projects/Jev/scripts/shadow_marveen_routing.py` a `model_routing_log`-ot a `token_usage`
táblával (agent + időablak) veti össze: a tényleges turn-szám/output-token/futásidő adja a feladat
"valódi" nehézségét, ebből lesz referencia-tier, és ahhoz mérjük az egyezést, az over/under-routing
arányt és a kérdésenkénti kalibrációt (ECE). Küszöböt csak ≥100 címkézett soron, held-out felén
mérve fogadunk el.

B1 (élesítés) külön jóváhagyás után, ebben a sorrendben:
1. háttérfeladatok: `claude -p … --model <profile-map[javaslat]>` — friss process, nincs respawn;
2. inter-agent/kanban: idle pane esetén `writeModelFor` + `restartAgentProcess(name, {fresh:false})`
   (a `model-fallback-runner.ts` már ezt csinálja limit-esésnél), hiszterézissel
   (`shouldSwitch` a `src/model-router.ts`-ben: felfelé bármikor, lefelé csak két szintnyi különbségnél);
3. a fő-agent Telegram-chatje fix marad (a channels plugin közvetlenül a sessionbe ad, üzenetenként
   nem routolható) — a nehéz munkát delegálja, a delegált út routolt.

Kill-switch: `MODEL_ROUTING=off`. A `background` és `all` mód-értékek foglaltak a B1-nek, ma
`shadow`-ként viselkednek.
