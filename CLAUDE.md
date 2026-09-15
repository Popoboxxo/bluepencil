# bluepencil

> Projektbeschreibung für Claude-Agenten. Diese Datei ist die **einzige Quelle**
> für projektspezifischen Kontext — Agenten lesen sie, statt eigenen Kontext zu haben.
>
> Generiert von agent-meta v1.2.0-beta.2 — `2026-09-13`
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
  core/       # model, store, anchor, capture, protocol, export/ (UI-unabhaengig, DOM nur in anchor/capture)
  data/       # HEADLESS: schema, validate, canonical, bundle, merge, migrate (kein DOM)
  cli/        # bluepencil inspect|validate|merge|export|import
  adapters/   # memory, local-storage, file, http
  ui/         # layer, composer, panel, legend, styles.css
  i18n/       # en, de
  mcp/        # MCP-Server (thin wrapper ueber src/data)
  index.ts    # oeffentliche API: init(), mount(), enable(), disable(), destroy()
server/       # Referenz-Server (Sidecar-Modus)
examples/     # vanilla, react, home-assistant, round-trip
tests/        # unit (vitest), e2e (Playwright)
docs/         # CONCEPT, REQUIREMENTS, ARCHITECTURE, PROTOCOL, INTEGRATION

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


## Code-Konventionen

- TypeScript strict, ESM, keine Default-Exports im Kern
- Dateinamen snake_case-frei: kebab-case fuer Dateien, camelCase fuer Symbole
- Oeffentliche Typen in src/core/model.ts, alles andere importiert von dort
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



## Agenten-Konfiguration

<!-- agent-meta:managed-begin -->
<!-- Dieser Block wird von sync.py bei jedem sync automatisch aktualisiert. -->
<!-- Manuelle Änderungen hier werden überschrieben. -->

> **AI ROUTING:** Claude -> CLAUDE.md | Opencode -> AGENTS.md

Generiert von agent-meta v1.2.0-beta.2 — `2026-09-13`
DoD-Preset: **standard** | REQ-Traceability: false | Tests: true | Codebase-Overview: false | Security-Audit: false
> **Einstiegspunkt:** Starte mit dem `orchestrator`-Agenten für alle Entwicklungsaufgaben — Ausnahmen siehe Abschnitt »Orchestrator — Universal Router«.
<!-- agent-meta:managed-end -->
