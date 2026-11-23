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
