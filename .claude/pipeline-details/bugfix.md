# Pipeline `bugfix`

Execution mode: loop

1. background(agent="bug-feature-analyzer", prompt="Bug klassifizieren (Bug/User-Error/Feature/Out-of-Scope). Bei User-Error/Out-of-Scope → Pipeline stoppen.") → warten bis abgeschlossen
2. background(agent="bug-feature-analyzer", prompt="Root-Cause belegen: root_cause + prior_attempts. Ein Symptom-Fix erfüllt das Gate nicht — ohne belegte Ursache wird fix nicht betreten.") → warten bis abgeschlossen
3. background(agent="developer", prompt="Bugfix implementieren") → warten bis abgeschlossen

**review** — REPEAT_UNTIL Loop:
  - background(agent="developer", prompt="Code-Qualität, Blast-Radius, SOLID/DRY prüfen")
  - background(agent="code-reviewer", prompt="Review / Critic feedback")
  Max iterations: 2 → Erfolg pruefen; bei Abbruch User benachrichtigen

4. background(agent="documenter", prompt="CODEBASE_OVERVIEW und Session-Erkenntnisse aktualisieren") → warten bis abgeschlossen
