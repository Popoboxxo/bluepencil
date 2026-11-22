# Pipeline `feature-lifecycle`

Execution mode: parallel_group

1. background(agent="git", prompt="Feature-Branch anlegen") → warten bis abgeschlossen
⏸ Abnahme erforderlich vor Stage 'approve' — warte auf explizite Nutzerbestätigung, bevor validator startet.
2. background(agent="validator", prompt="Spec/Plan-Gate: freigegebene Spec/Plan (Status: APPROVED) per plan_ref belegen (S-Klasse: entfällt) — fehlt sie, Abbruch und Route auf concept-driven-dev") → warten bis abgeschlossen
3. background(agent="tester", prompt="TDD Red Phase — fehlschlagende Tests zuerst (Benennung laut tester-Rolle)") → warten bis abgeschlossen

**implement** — Plan-driven: Agent aus payload.plan_ref (Stage-ID 'implement') übernehmen.

  **Plan-Validierung (vor Delegation):**
  1. Prüfe: payload.plan_ref-Pfad existiert → sonst fallback_agent = `developer`
  2. Prüfe: Plan-Frontmatter `pipeline_stages` enthält `implement` → sonst Fehler
  3. Prüfe: Agent in Stage `implement` ∈ {junior-developer, developer, senior-developer, frontend-component-engineer} → sonst `developer`
  4. Bei allen Fehlern: `developer` verwenden, Fehler in Status-Payload dokumentieren

4. background(agent="tester", prompt="Tests grün, keine Regression") → warten bis abgeschlossen

**validate-and-document** — Parallel dispatch:
  - background(agent="validator", prompt="DoD-Check")
  - background(agent="documenter", prompt="CODEBASE_OVERVIEW aktualisieren")

5. background(agent="git", prompt="Commit (Format: Rule commit-conventions) + PR") → warten bis abgeschlossen
