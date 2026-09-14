# Agent collaboration protocol

> Normative rules for how a human and an AI agent work on the same set of notes.
> Requirements: FR-5.x. Concept: [CONCEPT.md](CONCEPT.md#9-agent-collaboration-model-the-reason-this-exists).

---

## 1. Vocabulary

| Field | Values | Meaning |
|---|---|---|
| `type` | `text`, `design` | What the note is about: content/wording vs. appearance/layout |
| `intent` | `implement`, `feedback` | What should happen with the note |
| `status` | `open`, `done`, `needs_decision` | Where the note stands right now |
| `author_type` | `human`, `agent` | Who wrote a message in the thread |
| `kind` | `note`, `decision_request`, `decision`, `feedback`, `reply` | What a thread message is |

`intent` and `status` are **independent** on purpose: a note can be "assessment only"
(`intent=feedback`) while still being `open`, and a note can be `needs_decision` although the
intent is `implement`.

## 2. The four states an agent must distinguish

| Situation | Signal | Agent behaviour |
|---|---|---|
| Normal work item | `intent=implement`, `status=open` | Implement it. Then reply (`kind=reply`) describing what changed and set `status=done`. |
| Opinion requested | `intent=feedback` | Write an assessment, alternative(s) or risk note as `kind=feedback`. **Change nothing.** Leave the status alone. |
| Question pending | `status=needs_decision` | Wait. Do not implement. If the human answers (`kind=decision`, status returns to `open`), implement accordingly. |
| Unclear | none of the above helps | Ask — see §3. |

## 3. How to ask for a decision

An ask is only useful if the human can answer it in one line.

**Do:**

```
kind=decision_request   author_type=agent   status=needs_decision

Decision needed: the chapter heading still reads "FOPA" while the lead sentence says
"fauxpas" — inconsistent.
  A) Keep “FOPA” as the established short form (navigation stays short).
  B) Rename the heading to “Fauxpas — …”, dropping the abbreviation entirely.
I recommend B, because the lead already uses the word.
Reply in this note and I will implement it.
```

**Don't:**

* "What should I do here?" — no options, no context.
* "I changed it to X, is that ok?" — that is implementation without a decision.
* Bundle several unrelated questions into one ask; one decision per note.
* Ask about things that are obviously decidable (typos, spacing, ordering) — just do them.

## 4. Definition of done (for an agent)

A note may be set to `done` only when **all** of the following hold:

1. The requested change is actually applied (not planned, not described).
2. The change is committed/saved in the host's terms (commit, save, deploy as applicable).
3. The thread contains a `kind=reply` message: what changed, where, and any deviation from
   the request.
4. Nothing else regressed — if verification was possible, it was done and mentioned.
5. If the note was `intent=feedback`, it is **not** set to `done` by the agent; the human
   decides what to do with an assessment.

## 5. Reporting rules

* **Report in the thread**, not in a separate channel. The thread *is* the audit trail.
* One reply per note; keep it short (what, where, deviation).
* If a note cannot be implemented, say why and either ask (see §3) or set
  `intent=feedback` and explain the trade-off.
* Never edit or delete a human's message. Corrections are new messages.
* Never change a human's `intent` to make your own work easier.

## 6. Hard prohibitions

1. **Never invent a human decision.** A `kind=decision` message must come from a human. If you
   produced one while testing, remove it before handing the set over.
2. **Never implement `intent=feedback`.** Not even "a small improvement".
3. **Never mark `needs_decision` as done** to make the list look clean.
4. **Never delete notes you did not create** without an explicit instruction
   (bulk deletion is a human action).
5. **Never send note content to a third party** beyond the configured transport.

## 7. Reading order for an agent session

0. Know the environment you are in and the environment of the data you are reading — an
   import that mixes them is a defect, not a shortcut.
1. Fetch the export (`markdown` for reading, `json` for tooling).
2. The export opens with the exception sections: **open decisions** and **feedback only** —
   read them **first**; they constrain everything else.
3. Group the remaining notes by route/page; implement per page to keep changes reviewable.
4. After each batch: reply in the affected notes, set `done`, then re-export to confirm the
   new state (self-check).

## 8. Environments and exchange (FR-14)

* Notes and bundles are **tagged with an environment** (`dev`, `staging`, `live`). Never import
  across environments by accident: the import refuses on mismatch unless an operator passes the
  override deliberately.
* **Import is never destructive by default** (`merge`). A conflict — same note id, divergent
  content — is a message to a human, not something to resolve silently. Agents must not resolve
  conflicts on their own: report them.
* **Promotion** of a set (dev → live, or back) is an admin action. Keep the thread intact; only
  the environment tag changes.
* Machine-written notes (`source: tool:*`, `agent`) must stay distinguishable from human notes.
  Never rewrite a machine note into a human one, or vice versa.
* An agent working on imported notes follows §2–§4 to the letter: implement unambiguous
  `intent=implement`, answer `intent=feedback` without changing anything, ask when unsure.

## 9. Human rules (the other half)

* Use `intent=feedback` when you want an opinion, not a change. That is the whole point of
  the switch — it is not a weakness.
* Use the feedback-only mode for a whole review pass when you are still deciding direction.
* Answer open decisions in the thread, not by phone; the answer belongs to the note.
* If a note is wrong, correct it in the thread (or delete it) — the agent will not guess.
* Reveal done notes (settings ⚙) when you want the full history of a review round; the default
  view intentionally hides finished work.
