# Repo-Containment („Gefängnis-Modus")

Repo-Containment ist AKTIV: Schreibzugriffe sind auf die Projekt-Wurzel beschränkt; einziger sanktionierter Ausnahmebereich ist `.tmp/`.
Durchsetzung: PreToolUse-Hook = **Convention boundary** (keine Security Boundary, nur gegen akzidentellen Missbrauch; Convention boundary = fail-closed nur gegen akzidentellen Missbrauch, Security boundary = auch gegen deliberate Umgehung).
Kerngrenzen: Indirektion (`eval`, `bash -c`, `xargs`, Interpreter, Variablen-Ziele) und exotische Redirections/`cd`-Ketten umgehen den Tokenizer; Symlink-/TOCTOU-Escape ist nur per `realpath` gemildert; MCP-/Nicht-Tool-Schreibpfade und Selbst-Deaktivierung des Guards durch den Agenten sind nicht abgedeckt; hook-lose Provider erhalten nur die Prompt-Konvention.
