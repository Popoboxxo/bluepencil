# bluepencil

> Projektbeschreibung für Claude-Agenten. Diese Datei ist die **einzige Quelle**
> für projektspezifischen Kontext — Agenten lesen sie, statt eigenen Kontext zu haben.
>
> Generiert von agent-meta v2.0.0-beta.6 — `2026-10-31`
>
> **Längenempfehlung:** 200–500 Zeilen optimal. Über 500 Zeilen → Detailwissen in
> `docs/ARCHITECTURE.md`, `docs/API.md` o.ä. auslagern und manuell verlinken.
> Agent-spezifisches Wissen → `.claude/3-project/<rolle>-ext.md` (Extension).
>
> **CLAUDE.md Hierarchie (Claude Code lädt in dieser Reihenfolge):**
> 1. `~/.claude/CLAUDE.md` — global, alle Projekte (~50 Zeilen max, persönliche Präferenzen)
> 2. `<projekt>/CLAUDE.md` — diese Datei, projektspezifisch (von agent-meta verwaltet)
> 3. `<ordner>/CLAUDE.md` — optional in Unterordnern (z.B. `src/backend/CLAUDE.md`)

---

## Eigene Notizen

Hier kannst du eigene, projektspezifische Notizen eintragen. Dieser Bereich wird von `agent-meta` nicht überschrieben!

---

## Projekt

**Name:** bluepencil
**Präfix:** bp
**Plattform:** TypeScript-Bibliothek (Browser + Node, kein Runtime-Dependency)
**Beschreibung:** Framework-agnostische Review-Schicht fuer beliebige Web-Apps: Annotieren von Inhalt und Design, verankert am Element, lesbar von Menschen und Agenten.

> Struktur: siehe Verzeichnisstruktur im Repo (`ls`/`find`); deklarativ: `.meta-config/project.yaml` → `variables.PROJECT_STRUCTURE`.

**Verzeichnisstruktur:**
```
src/
  core/       # model, store, anchor, capture, protocol, adapter, export/{markdown,json} (UI-unabhaengig)
  data/       # HEADLESS: schema (inkl. Validierung), bundle, canonical, merge, migrate, order (kein DOM)
  cli/        # bluepencil inspect|validate|merge|export|import
  adapters/   # memory, local-storage, chrome-storage, file, http + transport.ts (registerHttpTransport-Seam)
  ui/         # layer, composer, panel, legend, modes, present, voice, keymap, styles.ts
  i18n/       # en, de
  element/    # <bluepencil-notes> custom element
  embed/      # attach.js one-tag loader (attributes, version)
  federation/ # federator: aggregate, backend, registry, client, net-policy
  mcp/        # MCP server (server, tools, protocol, stdio, backend, options)
  index.ts    # oeffentliche API: init(), mount(), enable(), disable(), destroy()
server/       # Referenz-Hub (HTTP + MCP door) und Federator
              # credentials.ts (credentialMode/acceptedCredentials), cors.ts (preflightResponse),
              # presence.ts (in-memory Presence), admin*.ts (admin surface), tokens/mint/registry/journal
extension/    # MV3-Chromium-Extension
  src/        # sw.ts, bridge.ts, connection.ts (Test-connection-Probe), handoff.ts, hub-fetch.ts,
              # page-relay.ts, storage-relay.ts, bootstrap.ts, detect.ts, options.ts, settings.ts
examples/     # vanilla, attach, parity, presentation, round-trip, voice, federation
scripts/      # build.mjs, dev.mjs, size-guard.mjs, verify-sync.mjs, check-version-bump.mjs, *-smoke.mjs
tests/        # unit (vitest), e2e (dependency-freier CDP-Harness, kein Playwright)
spec/         # GENERIERTE reqmd-Spec aus docs/REQUIREMENTS.md (nicht handeditieren)
docs/         # CONCEPT, REQUIREMENTS, ARCHITECTURE, PROTOCOL, RELEASING, DOCKER, EMBED, EXTENSION, ...
  plans/      # Feature-Plaene (spec-plan-workflow); archive/ fuer abgeschlossene Plaene
  specs/      # Feature-Spezifikationen (spec-plan-workflow)
  spikes/     # Zeitbox-Erkundungen (spec-plan-workflow, Namensmuster *-spike.md)
docker/       # entrypoint.sh + bin wrappers; Dockerfile + docker-compose.yml im Root

```

> Runtime & Abhängigkeiten: siehe Projekt-Manifest (`pyproject.toml` / `requirements.txt` / `package.json` / `manifest.json`).

**Entry-Point:** `src/index.ts (Bibliothek) / src/cli/bin.ts (CLI) / src/mcp/server.ts (MCP)`

**Besondere Patterns:**
- Keine Runtime-Dependencies im Kern (NFR-4); Dev-Dependencies nur fuer Build/Test
- Alle UI-Klassen mit Prefix bp-, Styles nur ueber CSS-Custom-Properties (--bp-*)
- enable()/disable() muessen vollstaendig und idempotent sein (FR-12.1/12.2, NFR-15)
- Nutzertexte immer als Text rendern, nie als HTML (FR-9.3)
- Keine Netzwerkaufrufe ausser zum host-konfigurierten Adapter (FR-9.4, NFR-7)
- Kanonische, stabile Serialisierung fuer diffbare Bundles (NFR-17)
- Transport-Seam ist additiv: registerHttpTransport() ergaenzt, ersetzt aber nie den Default-fetch (src/adapters/http.ts)
- Extension-Hub-Zugriff nur page -> bridge -> service worker; CSP connect-src braucht diese Ausnahme,
  Reichweite strikt Endpoint-Origin+Base, Methoden GET/POST/PATCH, Header-Allowlist, {base}/admin nie
- Credential-Paritaet: shared secret UND signed tokens sind gleichzeitig akzeptiert (server/credentials.ts);
  /config und /health bleiben credential-frei, Notiz-Routen nie
- Presence ist in-memory, max. 1 Update/Minute, nie persistiert und nie mit Secret
- OPTIONS-Preflight kommt aus genau einer Implementierung (server/cors.ts preflightResponse)
- Bundle-Budget ist knapp: IIFE 44.2/45 kB, Element 47.0/48 kB (min+gzip) - Feature-Zuwachs explizit begruenden


## Code-Konventionen

- TypeScript strict, ESM, keine Default-Exports im Kern
- Dateinamen snake_case-frei: kebab-case fuer Dateien, camelCase fuer Symbole
- Public **data-model** types live in `src/core/model.ts`; adapter, layer and store interfaces/options stay in their own modules (`core/adapter.ts`, `ui/layer.ts`, `core/store.ts`, `adapters/transport.ts`) — deliberate exceptions, not drift
- Tests neben der Sache: tests/unit/<modul>.test.ts
- Dokumentation und Code-Kommentare auf Englisch (externe Doku), Kommunikation auf Deutsch


## Build & Development

```bash
# Build
npm run build

# Tests
npm test

# Dev-Stack starten
npm run dev

# Nach Änderungen neu laden
automatisch via esbuild watch
```

## Anforderungs-Kategorien

Kategorien für `docs/REQUIREMENTS.md`:

- Capture & Anchoring (FR-1.x, FR-2.x)
- Note-Modell & Protokoll (FR-3.x, FR-5.x, PROTOCOL.md)
- UI, Filter & A11y (FR-4.x, FR-11.x)
- Adapter, Export & Bundles (FR-6.x, FR-7.x, FR-14.x)
- Headless/CLI/MCP (FR-13.x, FR-15.x, FR-16.x)
- Hub-Betrieb, Auth & Extension-Relay (FR-6.7, FR-6.10-6.16, FR-10.4, CSP connect-src)



## Agenten-Konfiguration

<!-- agent-meta:managed-begin -->
<!-- Dieser Block wird von sync.py bei jedem sync automatisch aktualisiert. -->
<!-- Manuelle Änderungen hier werden überschrieben. -->

> **AI ROUTING:** Claude -> CLAUDE.md | Opencode -> AGENTS.md

Generiert von agent-meta v2.0.0-beta.6 — `2026-10-31`
DoD-Preset: **standard** | REQ-Traceability: false | Tests: true | Codebase-Overview: false | Security-Audit: false
> **Einstiegspunkt:** Starte mit dem `orchestrator`-Agenten für alle Entwicklungsaufgaben — Ausnahmen siehe Abschnitt »Orchestrator — Universal Router«.
<!-- agent-meta:managed-end -->
