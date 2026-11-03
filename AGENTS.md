# bluepencil

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



<!-- agent-meta:managed-begin -->
> **AI ROUTING:** Claude -> CLAUDE.md | Opencode -> AGENTS.md
> **ENTRY:** `orchestrator`-Agent (für alle Dev-Tasks).
`agent-meta v2.0.0-beta.6` | DoD: `standard` | REQ-Trace: `false`



## Regeln

# Branch-Guard

Verwende Feature-Branches (`feat/`, `fix/`, `chore/`). Keine Code-Änderungen direkt auf `main` oder `master`.

## Guard-Terminologie: Convention Boundary vs. Security Boundary

Guards im System (Orchestrator-Guard, DoD-Push-Check, etc.) werden inkonsistent als
"Konventions-Tool" und als "security boundary" bezeichnet — beide Aussagen sind korrekt,
aber gegen unterschiedliche Bedrohungsmodelle:

- **Convention boundary**: fail-closed gegen AKZIDENTIELLEN Missbrauch (Tippfehler,
  vergessene Bestätigungen, naive Automatisierung). Nicht darauf ausgelegt, einen
  gezielten Bypass-Versuch zu widerstehen (siehe Lücken unten, z.B. #592).
- **Security boundary**: fail-closed gegen einen DELIBERATEN Umgehungsversuch.

Diese Definition ist die zentrale Referenz — Hook-Header und andere Doku sollen sie
verlinken (`.claude/rules/branch-guard.md#guard-terminologie-convention-boundary-vs-security-boundary`)
statt sie ad hoc zu wiederholen.

`orchestrator-guard.sh` ist primär eine **convention boundary** (siehe Lücken unten),
mit einzelnen **security-boundary**-Eigenschaften für spezifische Fälle (z.B. das
Destructive-Gate aus #516/#809, das auch bei gültigem `git`-Sentinel blockt). `dod-push-check.sh`
ist als **security boundary** gegen fehlendes/kaputtes `python3` fail-closed (#595).

## Bekannte Grenzen

Die technische Durchsetzung (`orchestrator-guard.sh`) erkennt Git-Mutationen über eine tokenisierte Analyse des Bash-Befehls (gemeinsamer Tokenizer für Destructive- und Mutation-Gate, Issue #551), kein vollständiger Shell-Parser. Das Destructive-Gate deckt zusätzlich die kanonischen Shell-Katastrophen ab (Issue #809): rekursives `rm` auf einem gefährlichen Root (`/`, `~`/`$HOME`, Top-Level-Systemverzeichnisse wie `/etc`) sowie eine rekursive Fork-Bomb (`` :(){ :|:& };: ``). Benigne In-Repo-Löschungen (`rm -rf .tmp/...`) bleiben erlaubt. Bekannte Lücken:

1. `eval "git commit ..."` wird nicht erkannt.
2. Direkte Schreibzugriffe auf `.git/` werden nicht geprüft.
3. Andere Git-Tools (`hub`, `gh repo ...`) sind nicht erfasst.
4. Command-Substitution und Indirektion (`$(...)`, Backticks, `xargs`, `eval`) können eine Git-Mutation am Tokenizer vorbeischleusen, weil der Hook den Befehl weder ausführt noch die Shell vollständig parst (Issue #592). Ein echter Shell-Interpreter wäre unverhältnismäßig für ein Konventions-Tool. Für das FS-Destructive-Gate (#809) gilt dasselbe: nur direkte `rm`-Aufrufe (ggf. hinter `sudo`/`env`/KEY=VALUE) werden erkannt; indirekte Löschungen (`find ... -delete`, `xargs rm`, Variablen-/`$(...)`-Expansion eines Pfads, gequoteter ANSI-C-Pfad, `rm` über einen Wrapper-Alias), Pfad-Traversal (`rm -rf /var/tmp/../etc`) sowie eine als String-Literal gequotete `:(){ :|:& };:`-Definition bzw. indirekte Fork-Bombs (`eval`, base64) bleiben möglich — ein Tippfehler-/Akzident-Netz, kein Ersatz für Backups.
5. Der Fork-Bomb-Scan des Destructive-Gates beendet den Funktionskörper am ersten ungequoteten `}` (keine Verschachtelung): Bomben mit `${…}` oder `{ …; }` vor dem Selbstaufruf (z. B. `f(){ : ${x}; f|f& };f`) werden nicht erkannt. Ein Funktionskörper ohne ungequotetes `}` in den ersten 512 Zeichen wird dagegen geblockt (fail-closed, mögliche Fehlalarme). Fix: Folge-Issue.

Bewusster Trade-off, kein Bug (siehe Kommentar-Header in `.claude/hooks/orchestrator-guard.sh`) — nur relevant für Nutzer, die sich vollständig auf den Schutz statt auf die Konvention verlassen.



# Commit-Konventionen

Verwende Conventional Commits (feat, fix, chore).
Beschreibungssprache: `Englisch`
Max 72 Zeichen in erster Zeile. Imperativ.
Format: `<type>: <beschreibung>` (Bsp: `feat: ...`)



# Definition of Done (DoD)

Pflicht: Code komplett, Konventionen & Conv. Commits eingehalten, keine Regressions.
Tests: Test vorhanden & grün



# Sprachregeln

| Kontext | Sprache |
|---|---|
| User-Kommunikation | **Deutsch** |
| User-Input | **Deutsch** |
| Externe Doku | **Englisch** |
| Interne Doku | **Deutsch** |
| Code/Commits | **Englisch** |



# MCP Hard Prohibitions

> Kurzfassung der harten Tool-Verbote aktiver MCP-Server. Vollständige Tool-Listen und
> Hinweise: pro Provider in `.opencode/skills` — jeweils `mcp-<server>/SKILL.md` (`use-lazy-rules.md`).

- (keine aktiven MCP-Server mit gesperrten Tools)



# No Worktree Isolation

**Anti-Pattern:** Niemals das Argument `isolation: "worktree"` beim Spawnen von Subagenten verwenden.
**Grund:** Agenten schreiben dann ihren Output in den internen Ordner `.claude/worktrees/agent-<id>/` anstatt in das eigentliche Projektverzeichnis. Das führt zu fehlgeleiteten Dateien und Datenverlust in der eigentlichen Codebase.

Alle Agenten müssen direkt im Projektverzeichnis arbeiten (Isolation deaktivieren oder weglassen). Der `.claude/` Ordner (sowie `.gemini/`, `.continue/`, `.mammouth/` etc.) ist strikt als Infrastruktur-Ordner zu betrachten und darf nicht für Arbeitskopien missbraucht werden.



# Repo-Containment („Gefängnis-Modus")

Repo-Containment ist AKTIV: Schreibzugriffe sind auf die Projekt-Wurzel beschränkt; einziger sanktionierter Ausnahmebereich ist `.tmp/`.
Durchsetzung: PreToolUse-Hook = **Convention boundary** (keine Security Boundary, nur gegen akzidentellen Missbrauch; Definition: `.claude/rules/branch-guard.md#guard-terminologie-convention-boundary-vs-security-boundary`). Grenzen/Details: `docs/concepts/repo-containment-prison-mode.md`.



# Security Paved Roads

Security wird als vorgeprüfte Paved-Road-Blöcke geliefert, nicht als DIY-Aufgabe:
**invisible, consistent, embedded, non-optional** (Netflix Paved Roads / Golden Path).
Ein Block ist ausgereift, sicherheitsgeprüft und wird identisch überall verwendet —
niemand implementiert Security-Logik selbst neu.

## Block-Katalog

| Block | Abdeckt | Eigentümer-Agent |
|-------|---------|------------------|
| `auth-flow` | Authentifizierung (Login, Session, Token) | *(keine aktive Eigentümer-Rolle)* |
| `dependency-check` | SBOM + CVE-Scan der Abhängigkeiten | `dependency-auditor` |
| `input-validation` | Eingabevalidierung (Schema, Sanitizing) | *(keine aktive Eigentümer-Rolle)* |
| `rate-limiting` | Rate-Limiting / Throttling | `devops-engineer` |
| `cors-config` | CORS-Konfiguration | *(keine aktive Eigentümer-Rolle)* |
| `secret-scanning` | Secret-Scan (Leaks in Diffs, Commits, Logs) | *(keine aktive Eigentümer-Rolle)* |

## Enforcement

- **Vor jedem Commit:** Secret-Scan über den Block `secret-scanning` ausführen.
- **Vor jedem Deploy:** `dependency-check` (SBOM + CVE) ausführen.
- **Für neue Features:** den `auth-flow`-Block nutzen statt Auth selbst zu bauen.

DIY-Security ist eine Anti-Pattern: jede Variante erzeugt unbekannte Lücken.
Abweichungen vom Block-Katalog werden als Review-Befund
gemeldet, nicht als Eigenbau gerechtfertigt.



# Threat Model — die 4 Fragen

Vor jedem öffentlichen Release die 4 Fragen beantworten (Igor Andriushchenko,
CISO Lovable):

1. **Was baust du?** — Datenspeicherung, Auth, Autorisierung, woher kommen die User?
2. **Was könnte schiefgehen?** — Worst-Case-Szenarien (Leak, Bypass, Datenverlust).
3. **Was tust du dagegen?** — konkrete Gegenmaßnahme pro Risiko.
4. **Was sind die Konsequenzen?** — Business-Impact, Datenverlust, Reputation.

## Anwendung

- `concept-reviewer` prüft die 4 Fragen in Design-Docs (Threat-Model-Checkliste).
- `orchestrator` stellt die 4 Fragen vor Feature-Releases.
- **Interne Apps:** vereinfacht — 1–2 Fragen reichen.
- **Customer-facing Apps:** vollständig — alle 4 Fragen plus dokumentiertes Threat Model.



# Lazy-Loaded Rules

> Nicht immer geladen — bei Bedarf per `Read` öffnen: `.opencode/skills/<skill>/SKILL.md` (jeweils).

| Skill | Wann |
|---|---|
| sync-interface | sync.py, Templates/Rules ändern |
| admin-ui | Admin-Server/UI betreiben (Lifecycle, Token, Ports) |
| architecture | Templates/Overrides/Placeholder ändern |
| conventions | Vor Commits in agents/, config/, scripts/lib |
| submodule-protection | .agent-meta/, external/, .gitmodules |
| a2a-delegation-gates | A2A-Delegation an Subagenten |
| issue-lifecycle | GitHub-Issue |
| lifecycle-tasks | Session-Start, pending-tasks.md vorhanden |
| session-conclusion | Feature-Abschluss |
| provider-agnostic | agents/1-generic editieren |
| mcp-viz-logger | viz-logger Event-Logging |

Harte MCP-Tool-Verbote: siehe `mcp-guardrails.md` (always-on).



# CRITICAL GATE (runtime-partially enforced)
MAIN CHAT darf nicht selbst editieren. ALLES -> `orchestrator`.
Provider-native Permissions block Main-Chat-Writes; Delegations-Provenienz ist
NICHT erzwungen (Prompt + Permission-Layer).

**Spec/Plan-Gate (Convention boundary):** Auch Nicht-Pipeline-Anfragen (Ad-hoc-Dispatch, `quick-fix`, `bugfix`) erst über die Classify-Route (`S`/`M`/`L`/`XL`) führen — kein Direkteinstieg in die Implementierung ohne freigegebene Spec/Plan (`Status: APPROVED`). Details: Master-Rule `spec-plan-workflow`.
## Git Delegation
Git Mutationen (commit, push, add etc) -> `git` Agent. Read-only (status, log) im Main Chat ok.

Native Extensions (Skills/Hooks) erlaubt, ignorieren nicht Branch-Guard/DoD.
Skill-getriebene Sub-Agent-Loops (z.B. generische Harness-Skills wie `subagent-driven-development`) sind KEINE dritte Ausnahme von der Orchestrator-Pflicht: ein Skill darf einen bereits vom `orchestrator` gestarteten Loop ausführen, aber niemals selbst zum Einstiegspunkt für einen neuen Dev-Task werden. Einzige Ausnahmen bleiben User-Override.

Anti-Recursion: Worker dürfen nicht an `orchestrator` zurück delegieren.






## Übrige Regeln (Lazy-Load)

Nicht-Kern-Regeln werden NICHT in diesen Block eingebettet (Progressive Disclosure, #192):
sie liegen pro Provider als separate Dateien in .opencode/skills — jeweils `<rule-name>/SKILL.md`.
Bei Bedarf mit `Read` laden; verfügbare Regeln via `ls` im jeweiligen Verzeichnis.


## Agent Directory
> ⚠️ **ACHTUNG:** Agenten (Prompts) liegen in `.opencode/agents`.

| Agent | Core Capabilities |
|-------|-------------------|
| `accessibility-specialist` | WCAG 2.1/2.2 Compliance-Audit, ARIA-Checks, Keyboard-Navigation |
| `agent-meta-manager` | agent-meta verwalten: Upgrade, Sync, Feedback |
| `agent-meta-scout` | Claude-Ökosystem scouten: neue Skills, Rollen, Rules |
| `api-specialist` | OpenAPI/Contract-First API Design, Schnittstellen-Spezifikationen |
| `bug-feature-analyzer` | Issue-Triage: Eingehende Bug-Meldungen, Feature-Requests analysieren, k |
| `code-reviewer` | Clean Code Gatekeeper: Blast-Radius-Analyse, SOLID/DRY Prüfung, Code-Qualität |
| `concept-architect` | Systemdesign für komplexe Änderungen: Komponenten, Schnittstellen, Trade-offs |
| `concept-reviewer` | Konzept-Critic: reviewt Design-Docs, Konzepte auf Vollständigkeit, Logik |
| `concept-specifier` | Technische Spezifikationen aus Anforderungen, Codebase-Kontext — implementiert nicht |
| `dependency-auditor` | Supply-Chain-Hygiene: SBOM-Analyse, Lizenz-Kompatibilität, Version-Drift und |
| `design-system-architect` | Design-System-Schema → echte Token-Artefakte, Farbharmonie, Variant-Contracts |
| `developer` | Feature-Implementierung, Bugfixes |
| `devops-engineer` | CI/CD, Infrastructure as Code, Kubernetes |
| `documenter` | CODEBASE_OVERVIEW, ARCHITECTURE, README |
| `e2e-tester` | E2E-Tests, visuelle Regression, Accessibility-Audits via Playwright |
| `effort-estimator` | Schätzt Aufwände für Entwicklungsaufgaben basierend auf Task-Typ, LLM-Kali |
| `explorer` | Read-only Codebase-Recherche, Dependency, Impact-Mapping |
| `feedback` | Projekt-Feedback standardisieren: Bugs, Features, Verbesserungen als GitHub I |
| `frontend-component-engineer` | Screen-Spec + Token-Contract → produktionsreife UI-Komponenten |
| `git` | Commits, Branches, Tags |
| `ideation` | Neue Ideen explorieren, Vision schärfen, Übergabe an requirements |
| `junior-developer` | Triviale Code-Änderungen (≤2 Dateien, kein Architektur-Impact) |
| `log-analyzer` | System, Applikations-Logs analysieren: Frequency-Clustering, Severity-Kla |
| `meta-feedback` | Verbesserungsvorschläge für agent-meta als GitHub Issues einreichen |
| `orchestrator` | Einstiegspunkt für alle Entwicklungsaufgaben |
| `performance-optimizer` | Big-O Bottleneck-Identifikation, datengetriebene Performance-Optimierung |
| `planner` | Umsetzungsplanung |
| `prompt-engineer` | Der ultimative Experte für Prompt-Engineering |
| `refactoring-specialist` | Systematische großflächige Code-Transformation mit Sicherheitsnetz: Strangler |
| `release` | Versioning, Changelog, Build-Artifact |
| `requirements` | Anforderungen aufnehmen, REQ-IDs vergeben, REQUIREMENTS.md pflegen |
| `senior-developer` | Komplexe Features, Architektur-Entscheidungen, schwierige Bugs |
| `technical-writer` | Externe entwickler, nutzergerichtete Doku: API-Referenzen, Getting-Starte |
| `test-executor` | Bestehende Test-Suiten ausführen — kein Test-Design, kein Code-Schreiben |
| `tester` | TDD, Test-Suite ausführen, Testabdeckung sichern |
| `ui-ux-designer` | UI-Spezifikationen, Mockups, Design-Systeme erstellen |
| `validator` | Code gegen REQs prüfen, DoD-Checkliste, Traceability-Audit |




<!-- agent-meta:managed-end -->

## Eigene Notizen

Hier kannst du eigene, projektspezifische Notizen eintragen. Dieser Bereich wird von `agent-meta` nicht überschrieben!
