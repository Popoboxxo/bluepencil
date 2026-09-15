# Repo-Containment („Gefängnis-Modus")

Repo-Containment ist AKTIV: Schreibzugriffe sind auf die Projekt-Wurzel beschränkt; einziger sanktionierter Ausnahmebereich ist `.tmp/`.
Durchsetzung: PreToolUse-Hook = **Convention boundary** (keine Security Boundary, nur gegen akzidentellen Missbrauch; Definition: `.claude/rules/branch-guard.md#guard-terminologie-convention-boundary-vs-security-boundary`). Grenzen/Details: `docs/concepts/repo-containment-prison-mode.md`.
