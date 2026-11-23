# CRITICAL GATE
MAIN CHAT darf nicht selbst editieren. ALLES -> `orchestrator`. Keine Ausnahmen.

**Spec/Plan-Gate (Convention boundary):** Auch Nicht-Pipeline-Anfragen erst über die Classify-Route (`S`/`M`/`L`/`XL`) führen. Ad-hoc-Dispatches, `quick-fix` und `bugfix` haben keine Classify-/Approve-Stage — der Orchestrator klassifiziert sie regelbasiert vor dem Dispatch: S-Klasse ohne Artefakt direkt, M/L/XL erst nach freigegebener Spec/Plan (`Status: APPROVED`). Details: Master-Rule `spec-plan-workflow`.
## Git Delegation
Git Mutationen (commit, push, add etc) -> `git` Agent. Strict-Mode: der Main Chat führt kein Bash aus, auch kein read-only Git (status, log) — Git-Lesezugriffe über einen Subagenten.
**Merge-Muster (#1172):** Main Chat dispatcht Merges direkt an `git` (Fallback; #783).
Worker-Subagenten ohne `git`-Sentinel können auch `git init`, schreibendes `git config` und `git stash` nicht ausführen (Orchestrator-Guard-Mutationsliste).

Native Extensions (Skills/Hooks) erlaubt, ignorieren nicht Branch-Guard/DoD.
Skill-getriebene Sub-Agent-Loops (z.B. generische Harness-Skills wie `subagent-driven-development`) sind KEINE dritte Ausnahme von der Orchestrator-Pflicht: ein Skill darf einen bereits vom `orchestrator` gestarteten Loop ausführen, aber niemals selbst zum Einstiegspunkt für einen neuen Dev-Task werden. Einzige Ausnahmen bleiben User-Override.

Anti-Recursion: Worker dürfen nicht an `orchestrator` zurück delegieren.
