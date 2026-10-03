#!/usr/bin/env python3
"""Baut aus docs/REQUIREMENTS.md eine reqmd-Spec (spec/).

Regeln (aus https://reqmd.dev/ai/):
- Jede Anforderung = Ueberschrift + ```attr-Block + Prosa.
- attr-Felder sind eingebaut: status, disposition, version, verify, trace, requires-trace-from.
- NFR-3 hat eine eigene Groessen-Zahl, die als Prio erhalten bleibt -> eigenes Dokument.
- Der Pflicht-Trace von NFR -> FR wird ueber x-reqmd.upstream modelliert, soweit sinnvoll;
  wo keine echte Ableitung existiert, wird requires-trace-from: [] gesetzt (expliziter Opt-out
  laut Regel 5 der AGENTS.md-Empfehlung) statt ein fehlendes trace: zu erfinden.
- Die Original-Tabelle bleibt unangetastet: dieses Skript liest sie nur.
"""
import re
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SRC = os.path.join(REPO, "docs", "REQUIREMENTS.md")
OUT = os.path.join(REPO, "spec")

# ---------------------------------------------------------------- Quelle parsen
text = open(SRC, encoding="utf-8").read()

# Die Quelltabellen sind NICHT einheitlich: die FR-Sektion hat 6 Spalten
# (ID, Requirement, Prio, Ms, Origin, Acceptance), die NFR-Sektion nur 5
# (ID, Requirement, Prio, Ms, Acceptance) — NFR-20 steht in der FR-12-Sektion
# und hat deshalb eine Origin-Spalte. Beide Formen muessen matchen, sonst
# fallen Anforderungen stillschweigend weg.
ROW_WITH_ORIGIN = re.compile(
    r"^\|\s*(?P<id>(?:FR|NFR)-[0-9]+(?:\.[0-9]+)?)\s*\|"
    r"\s*(?P<req>.*?)\s*\|"
    r"\s*(?P<prio>P[0-2])\s*\|"
    r"\s*(?P<ms>[^|]*?)\s*\|"
    r"\s*(?P<origin>[PGN])\s*\|"
    r"\s*(?P<ac>.+?)\s*\|\s*$"
)
ROW_NO_ORIGIN = re.compile(
    r"^\|\s*(?P<id>(?:FR|NFR)-[0-9]+(?:\.[0-9]+)?)\s*\|"
    r"\s*(?P<req>.*?)\s*\|"
    r"\s*(?P<prio>P[0-2])\s*\|"
    r"\s*(?P<ms>[^|]*?)\s*\|"
    r"\s*(?P<ac>.+?)\s*\|\s*$"
)

rows = []
for line in text.splitlines():
    # Reihenfolge ist bedeutsam: die 5-Spalten-Variante ist gierig und frisst
    # auch 6-Spalten-Zeilen (sie schluckt "P | …" in das acceptance-Feld).
    # Deshalb zuerst die 6-Spalten-Variante probieren, dann die 5-Spalten-Variante.
    m = ROW_WITH_ORIGIN.match(line)
    if m is None:
        m = ROW_NO_ORIGIN.match(line)
    if not m:
        continue
    d = m.groupdict()
    # NFR-Zeilen mit Origin-Spalte fuehren ein zusaetzliches Feld; das fuehrende
    # Feld muss im Text-Modus immer die ID sein.
    d["ac"] = re.sub(r"<br\s*/?>", " ", d["ac"])
    d["req"] = re.sub(r"\*\*(.+?)\*\*", r"\1", d["req"])
    d["req"] = re.sub(r"`(.+?)`", r"\1", d["req"])
    d["req"] = re.sub(r"\s+", " ", d["req"]).strip()
    d["ms"] = d["ms"].strip()
    d["origin"] = (d.get("origin") or "").strip()
    d["ac"] = re.sub(r"\s+", " ", d["ac"]).strip()
    rows.append(d)

# Vollstaendigkeits-Gate: jede ID aus der Quelle muss in der Spec landen.
# Ein stillschweigender Verlust waere die schlimmste Fehlerklasse hier, weil
# `reqmd check` gruen bleibt und trotzdem eine Anforderung fehlt.
SRC_IDS = re.findall(r"^\|\s*((?:FR|NFR)-[0-9]+(?:\.[0-9]+)?)\s*\|", text, re.M)
SRC_IDS = list(dict.fromkeys(SRC_IDS))
PARSED_IDS = {r["id"] for r in rows}
_dropped = [i for i in SRC_IDS if i not in PARSED_IDS]
if _dropped:
    sys.exit(
        "ABBRUCH: %d Anforderung(en) aus der Quelle wurden nicht geparst: %s\n"
        "Die Tabellenstruktur von docs/REQUIREMENTS.md hat sich geaendert — "
        "Regex anpassen, nicht die Anforderung fallen lassen." % (len(_dropped), _dropped)
    )

FR = [r for r in rows if r["id"].startswith("FR-")]
NFR = [r for r in rows if r["id"].startswith("NFR-")]

# NFR-20 steht in der FR-12-Sektion der Quelle (Chrome-Scrolling) und hat dort
# eine Origin-Spalte, gehoert aber semantisch zu den non-funktionalen Anforderungen.
# Fuer die Dokument-Zuordnung zaehlt deshalb die QUELLE-Sektion, nicht das ID-Praefix:
# NFR-20 wird nicht in die FR-12-Gruppe verschoben, sondern bleibt NFR — sonst
# verliert es seinen Platz im NFR-Dokument und die Gruppe waere falsch benannt.
# Auskommentiert, weil es nachweislich falsch war:
#   FR += nfr20
NFR_20_PLACEHOLDER = bool([r for r in NFR if r["id"] == "NFR-20"])
if NFR_20_PLACEHOLDER:
    NFR = [r for r in NFR if r["id"] != "NFR-20"]
    NFR.append([r for r in rows if r["id"] == "NFR-20"][0])
    NFR.sort(key=lambda r: int(r["id"].split("-")[1]))

# Gruppen nach FR-<n>
def group_of(rid):
    m = re.match(r"FR-(\d+)", rid)
    return int(m.group(1)) if m else 0

def sort_key(r):
    if r["id"].startswith("NFR-"):
        return (0, int(r["id"].split("-")[1]))
    num = r["id"].split("-")[1]
    grp, _, leaf = num.partition(".")
    return (1, int(grp), int(leaf) if leaf else 0)

FR.sort(key=sort_key)
NFR.sort(key=sort_key)

# ---------------------------------------------------------------- Schema
SCHEMA = """# Schema for the {title}
# Managed for reqmd: read this before adding an attribute —
# `additionalProperties: false` means an undeclared attribute fails `reqmd check`.
$schema: "https://json-schema.org/draft/2020-12/schema"
$id: "{doc_id}"
title: "bluepencil — {title}"
type: object
properties:
  prio:
    type: string
    enum: [P0, P1, P2]
    description: "MoSCoW priority: P0 must, P1 should, P2 could"
  origin:
    type: string
    enum: [P, G, N, ""]
    description: "P = proven in prototype, G = prototype gap, N = product need"
  milestone:
    type: string
    description: "Milestone from CONCEPT.md section 12"
x-reqmd:
  level: {level}
  document-id: "{doc_id}"
  id-prefix: "{prefix}"
"""

NON_FUNC_SCHEMA = """$schema: "https://json-schema.org/draft/2020-12/schema"
$id: "nonfunctional"
title: "bluepencil — Non-Functional Requirements"
type: object
properties:
  prio:
    type: string
    enum: [P0, P1, P2]
  milestone:
    type: string
x-reqmd:
  level: non-functional
  document-id: "nonfunctional"
  id-prefix: "NFR-"
  mandatory-disposition: true
"""

# ---------------------------------------------------------------- Docs-Definition
# (dir, schema-file, title, level, prefix, Which-Source)
DOCS = [
    ("01-capture", "capture", "Functional requirements: capture", "functional-requirements", "FR-", FR, "n", 1),
    ("02-anchoring", "anchoring", "Functional requirements: anchoring", "functional-requirements", "FR-", FR, "n", 2),
    ("03-note-model", "note-model", "Functional requirements: note model", "functional-requirements", "FR-", FR, "n", 3),
    ("04-presentation", "presentation", "Functional requirements: presentation and UI", "functional-requirements", "FR-", FR, "n", 4),
    ("05-collaboration", "collaboration", "Functional requirements: collaboration", "functional-requirements", "FR-", FR, "n", 5),
    ("06-storage", "storage", "Functional requirements: storage and transport", "functional-requirements", "FR-", FR, "n", 6),
    ("07-export", "export", "Functional requirements: export", "functional-requirements", "FR-", FR, "n", 7),
    ("08-lifecycle", "lifecycle", "Functional requirements: lifecycle and deletion", "functional-requirements", "FR-", FR, "n", 8),
    ("09-permissions", "permissions", "Functional requirements: permissions and safety", "functional-requirements", "FR-", FR, "n", 9),
    ("10-integration", "integration", "Functional requirements: integration", "functional-requirements", "FR-", FR, "n", 10),
    ("11-i18n-a11y", "i18n-a11y", "Functional requirements: i18n and accessibility", "functional-requirements", "FR-", FR, "n", 11),
    ("12-runtime", "runtime", "Functional requirements: runtime lifecycle and host variety", "functional-requirements", "FR-", FR, "n", 12),
    ("13-devsystems", "devsystems", "Functional requirements: developer systems", "functional-requirements", "FR-", FR, "n", 13),
    ("14-live-systems", "live-systems", "Functional requirements: live systems and exchange", "functional-requirements", "FR-", FR, "n", 14),
    ("15-headless", "headless", "Functional requirements: headless data library and CLI", "functional-requirements", "FR-", FR, "n", 15),
    ("16-mcp", "mcp", "Functional requirements: MCP interface", "functional-requirements", "FR-", FR, "n", 16),
    ("99-non-functional", None, "Non-functional requirements", "non-functional", "NFR-", NFR, "y", 0),
]

# Verifikationsmethode: nur belegbar zuweisen, wo die Abnahmekriterien das hergeben.
VERIFY = {
    "FR-1.1": "Inspection", "FR-1.2": "Demonstration", "FR-1.3": "Test", "FR-1.4": "Test",
    "FR-1.5": "Test", "FR-1.6": "Test", "FR-1.7": "Inspection", "FR-1.8": "Test",
    "FR-1.9": "Test", "FR-1.10": "Test", "FR-1.11": "Test", "FR-1.12": "Test",
    "FR-2.1": "Test", "FR-2.2": "Test", "FR-2.3": "Test", "FR-2.4": "Test",
    "FR-2.5": "Inspection", "FR-2.6": "Test", "FR-2.7": "Test",
    "FR-3.1": "Test", "FR-3.2": "Test", "FR-3.3": "Test", "FR-3.4": "Test", "FR-3.5": "Test",
    "FR-4.1": "Test", "FR-4.2": "Test", "FR-4.3": "Test", "FR-4.4": "Test",
    "FR-4.5": "Test", "FR-4.6": "Test", "FR-4.7": "Test", "FR-4.8": "Test",
    "FR-5.1": "Test", "FR-5.2": "Test", "FR-5.3": "Test", "FR-5.4": "Test",
    "FR-5.5": "Test", "FR-5.6": "Test", "FR-5.7": "Inspection", "FR-5.8": "Inspection",
    "FR-6.1": "Test", "FR-6.2": "Test", "FR-6.3": "Test", "FR-6.4": "Demonstration",
    "FR-6.5": "Test", "FR-6.6": "Test",
    # Phase 1/2 of #36. All three are covered against a *running* server (server-token-wiring) and
    # at the handler boundary (server-token-auth); the extension's credential mode and its expiry
    # line are asserted in a real Chrome by the extension smoke.
    "FR-6.7": "Test", "FR-6.8": "Test", "FR-6.9": "Test",
    "FR-6.10": "Test", "FR-6.11": "Demonstration", "FR-6.12": "Demonstration", "FR-6.13": "Test",
    "FR-16.8": "Test", "FR-16.9": "Test",
    "FR-7.1": "Test", "FR-7.2": "Test", "FR-7.3": "Test", "FR-7.4": "Demonstration",
    "FR-8.1": "Test", "FR-8.2": "Test", "FR-8.3": "Test", "FR-8.4": "Test", "FR-8.5": "Inspection",
    "FR-9.1": "Inspection", "FR-9.2": "Test", "FR-9.3": "Test", "FR-9.4": "Test",
    "FR-10.1": "Test", "FR-10.2": "Demonstration", "FR-10.3": "Test", "FR-10.4": "Inspection",
    "FR-11.1": "Test", "FR-11.2": "Test", "FR-11.3": "Inspection", "FR-11.4": "Inspection",
    "FR-12.1": "Test", "FR-12.2": "Test", "FR-12.3": "Test", "FR-12.4": "Test", "FR-12.5": "Demonstration",
    "FR-12.6": "Test", "FR-12.7": "Demonstration", "FR-12.8": "Test",
    "FR-12.9": "Test", "FR-12.10": "Test", "FR-12.11": "Test", "FR-12.12": "Test", "FR-12.13": "Test",
    "FR-13.1": "Test", "FR-13.2": "Test", "FR-13.3": "Test", "FR-13.4": "Test",
    "FR-13.5": "Inspection", "FR-13.6": "Demonstration",
    "FR-14.1": "Test", "FR-14.2": "Test", "FR-14.3": "Test", "FR-14.4": "Test", "FR-14.5": "Test",
    "FR-14.6": "Test", "FR-14.7": "Test", "FR-14.8": "Test", "FR-14.9": "Test",
    "FR-15.1": "Test", "FR-15.2": "Test", "FR-15.3": "Test", "FR-15.4": "Test", "FR-15.5": "Test",
    "FR-16.1": "Test", "FR-16.2": "Test", "FR-16.3": "Test", "FR-16.4": "Test",
    "FR-16.5": "Test", "FR-16.6": "Demonstration", "FR-16.7": "Test",
    "NFR-1": "Test", "NFR-2": "Test", "NFR-3": "Test", "NFR-4": "Test", "NFR-5": "Inspection",
    "NFR-6": "Test", "NFR-7": "Test", "NFR-8": "Test", "NFR-9": "Test", "NFR-10": "Test",
    "NFR-11": "Test", "NFR-12": "Inspection", "NFR-13": "Test", "NFR-14": "Inspection",
    "NFR-15": "Test", "NFR-16": "Test", "NFR-17": "Test", "NFR-18": "Test", "NFR-19": "Test",
    "NFR-20": "Test",
}


def slug(rid):
    """FR-1.3 -> FR-1-3 ; NFR-12 -> NFR-12"""
    return rid.replace(".", "-")


def yaml_quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


generated = []

# reqmd verlangt, dass `id-prefix` GLOBAL eindeutig ist (check: "prefix already used ...
# collision"). Die bluepencil-IDs sind zweistufig (FR-1.3, FR-12.11), ein flaches
# "FR-" kollidiert also in jedem Dokument. Das Schema deklariert deshalb genau die
# Gruppen-IDs, die das Dokument wirklich enthaelt: "FR-1." / "FR-12." usw.
# Kein Prefix darf doppelt vergeben werden — das pruft reqmd, und es stimmt auch
# ohne den Check: die Gruppen sind paarweise disjunkt.
def prefix_for(group):
    return "NFR-" if group == 0 else "FR-%d." % group


DECLARED_PREFIXES = [prefix_for(g) for *_, g in
                     [(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]) for d in DOCS]]
_dupe = {p for p in DECLARED_PREFIXES if DECLARED_PREFIXES.count(p) > 1}
if _dupe:
    sys.exit("ABBRUCH: id-prefix doppelt vergeben: %s" % sorted(_dupe))


for dirname, doc_id, title, level, _prefix, source, is_nfr, want_group in DOCS:
    if is_nfr == "n":
        sel = [r for r in source if group_of(r["id"]) == want_group]
    else:
        sel = list(source)
    if not sel:
        continue
    prefix = prefix_for(want_group)

    # Schema
    if is_nfr == "y":
        write(os.path.join(OUT, dirname, "schema.yaml"), NON_FUNC_SCHEMA)
    else:
        write(os.path.join(OUT, dirname, "schema.yaml"),
              SCHEMA.format(title=title, doc_id=doc_id, level=level, prefix=prefix))

    lines = [f"# {title}", "",
             f"Source: [`docs/REQUIREMENTS.md`](../../docs/REQUIREMENTS.md) — generated by",
             "`scripts/build-reqmd-spec.py`. Edit the source table, not this file.", ""]

    for r in sel:
        rid = r["id"]
        req_slug = slug(rid)
        heading = f"{rid} {r['req']}"
        # lange Ueberschriften kuerzen: der Titel steht als Prosa darunter
        if len(heading) > 96:
            heading = f"{rid} " + r["req"][:88].rstrip() + "…"

        attr = [f'prio: {r["prio"]}']
        if is_nfr != "y":
            if r["origin"]:
                attr.append(f'origin: {r["origin"]}')
        else:
            attr.append("disposition: implemented")
        if r["ms"]:
            attr.append(f'milestone: {yaml_quote(r["ms"])}')
        attr.append("status: approved")
        ver = VERIFY.get(rid)
        if ver:
            attr.append(f"verify: {ver}")
        attr.append("version: 1")
        # Regel 5: expliziter Opt-out statt fehlendem trace
        attr.append("requires-trace-from: []")

        body = r["ac"]
        lines.append(f"## {heading}")
        lines.append("")
        lines.append("```attr")
        lines.extend(attr)
        lines.append("```")
        lines.append("")
        if r["req"]:
            lines.append(r["req"])
            lines.append("")
        lines.append(f"*Acceptance criteria:* {body}")
        lines.append("")
        generated.append((rid, dirname, r["prio"]))

    write(os.path.join(OUT, dirname, "requirements.md"), "\n".join(lines).rstrip() + "\n")

print(f"{len(generated)} Anforderungen in {len(DOCS)} Dokumente geschrieben -> {OUT}")
by_prio = {}
for rid, _d, p in generated:
    by_prio[p] = by_prio.get(p, 0) + 1
print("Verteilung:", dict(sorted(by_prio.items())))
print("FR:", sum(1 for r, _d, _p in generated if r.startswith("FR-")),
      "NFR:", sum(1 for r, _d, _p in generated if r.startswith("NFR-")))
missing = [r for r, _d, _p in generated if r not in VERIFY]
print("ohne verify-Methode:", missing or "keine")
