/**
 * @vitest-environment node — reads `docs/REQUIREMENTS.md` and the generated `spec/` tree from disk;
 * no DOM is involved.
 *
 * Requirement-baseline assertions (AC-F01…AC-F05, AC-F08, AC-F10).
 *
 * The baseline is the source of truth every later contract traces to, so the failure mode this
 * suite guards against is silence: a section that was never written, a withdrawn ID that leaks back
 * into an active table, a rewritten requirement that lost the token its contract depends on.
 *
 * Deliberately *not* a repo-wide ID gate: G3 keeps that in the `spec` CI job (`npm run spec`,
 * `reqmd check`). This file asserts sections, ids and key tokens for the baseline under change —
 * never whole sentences, so an editorial rewrite does not turn the suite red for no reason.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_DIR = join(ROOT, "spec");

const REQUIREMENTS = readFileSync(join(ROOT, "docs", "REQUIREMENTS.md"), "utf8");

/** A row of the requirement tables. `cells` are the trimmed cells, id first. */
interface RequirementRow {
  readonly id: string;
  readonly cells: readonly string[];
}

/** One `## ` section of `docs/REQUIREMENTS.md`, heading line included in `body`. */
interface Section {
  readonly heading: string;
  readonly body: string;
}

const ROW_ID = /^(?:FR|NFR)-\d+(?:\.\d+)?$/;

/** Escape a requirement id (or heading fragment) for use inside a `RegExp`. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a markdown table row on its *unescaped* pipes. FR-15.2 writes `high\|medium\|low`, which is
 * one cell, not three — a naive `split("|")` would shift every later column.
 */
function splitRow(line: string): string[] {
  const trimmed = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function parseRows(text: string): RequirementRow[] {
  const found: RequirementRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    const id = cells[0] ?? "";
    if (ROW_ID.test(id)) found.push({ id, cells });
  }
  return found;
}

function parseSections(text: string): Section[] {
  const found: Section[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (heading !== null) found.push({ heading, body: body.join("\n") });
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      heading = line;
      body = [line];
      continue;
    }
    if (heading !== null) body.push(line);
  }
  flush();
  return found;
}

const REQUIREMENT_ROWS = parseRows(REQUIREMENTS);
const SECTIONS = parseSections(REQUIREMENTS);

/** The table row for a leaf requirement (`FR-6.7`, `NFR-3`, …). */
function rowFor(id: string): RequirementRow {
  const found = REQUIREMENT_ROWS.find((row) => row.id === id);
  if (found === undefined) {
    throw new Error(`docs/REQUIREMENTS.md has no requirement-table row for ${id}`);
  }
  return found;
}

/** The requirement text of a leaf row — the column between the id and the priority. */
function textFor(id: string): string {
  return rowFor(id).cells[1] ?? "";
}

/** The `## ` section whose heading starts with the given id. */
function sectionFor(id: string): Section {
  const pattern = new RegExp(`^## ${escapeLiteral(id)}(?:\\s|$)`);
  const found = SECTIONS.find((section) => pattern.test(section.heading));
  if (found === undefined) {
    throw new Error(`docs/REQUIREMENTS.md has no "## ${id}" section`);
  }
  return found;
}

function specDirs(): string[] {
  return readdirSync(SPEC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** The ids a generated spec directory carries as `## ` headings. */
function specIds(dir: string): string[] {
  const text = readFileSync(join(SPEC_DIR, dir, "requirements.md"), "utf8");
  return [...text.matchAll(/^## ((?:FR|NFR)-\d+(?:\.\d+)?)/gm)].map((match) => match[1] ?? "");
}

/** The shipped-behaviour sections FR-17…FR-20 and their generated spec directories. */
const SHIPPED_GROUPS = [
  {
    id: "FR-17",
    title: "Attach loader",
    dir: "17-attach-loader",
    members: ["FR-17.1", "FR-17.2", "FR-17.3", "FR-17.4"],
  },
  {
    id: "FR-18",
    title: "Store journal",
    dir: "18-store-journal",
    members: ["FR-18.1", "FR-18.2", "FR-18.3"],
  },
  {
    id: "FR-19",
    title: "Version reporting",
    dir: "19-version-reporting",
    members: ["FR-19.1", "FR-19.2"],
  },
  {
    id: "FR-20",
    title: "Presentation mode",
    dir: "20-presentation-mode",
    members: [
      "FR-20.1",
      "FR-20.2",
      "FR-20.3",
      "FR-20.4",
      "FR-20.5",
      "FR-20.6",
      "FR-20.7",
      "FR-20.8",
    ],
  },
] as const;

describe("requirement baseline — the four shipped-behaviour sections", () => {
  for (const group of SHIPPED_GROUPS) {
    it(`[${group.id}] documents "${group.title}" with a priority, a milestone and acceptance criteria per requirement`, () => {
      const section = sectionFor(group.id);
      expect(section.heading).toContain(group.title);

      for (const member of group.members) {
        const cells = rowFor(member).cells;
        // FR rows are [id, requirement, prio, milestone, origin, acceptance].
        expect(cells[2] ?? "", `${member} priority`).toMatch(/^P[0-2]$/);
        expect(cells[3] ?? "", `${member} milestone`).toMatch(/^M\d/);
        expect(cells[cells.length - 1] ?? "", `${member} acceptance criteria`).not.toBe("");
      }
    });
  }
});

describe("requirement baseline — the withdrawn voice group", () => {
  it("[FR-21] keeps FR-21.1…FR-21.8 in the annex only and out of the active tables", () => {
    const annex = sectionFor("Withdrawn in 0.12.0");
    const withdrawn = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `FR-21.${n}`);

    // The annex lists exactly these eight ids — nothing dropped, nothing invented.
    const listed = [...REQUIREMENTS.matchAll(/FR-21\.\d+/g)].map((match) => match[0]);
    expect(new Set(listed)).toEqual(new Set(withdrawn));

    for (const id of withdrawn) {
      expect(annex.body).toContain(id);
      // Each one is marked withdrawn, so "still listed" cannot be read as "still active".
      expect(annex.body).toMatch(
        new RegExp(`\\*\\*${escapeLiteral(id)}\\*\\* — .*\\*Withdrawn\\.\\*`),
      );
      // "The IDs stay listed here so they are not reused" — one mention, in the annex.
      expect(listed.filter((value) => value === id)).toHaveLength(1);
    }

    // No active table row, no group section, and nothing outside the annex.
    expect(REQUIREMENT_ROWS.some((row) => row.id.startsWith("FR-21"))).toBe(false);
    expect(SECTIONS.some((section) => /^## FR-21(?:\s|$)/.test(section.heading))).toBe(false);
    const outsideAnnex = REQUIREMENTS.replace(annex.body, "");
    expect(outsideAnnex).not.toMatch(/FR-21\.\d/);
  });
});

describe("requirement baseline — the rewritten sections", () => {
  it("[FR-2.2] keeps origin distinct from anchor.route", () => {
    const text = textFor("FR-2.2");
    expect(text).toContain("`origin`");
    expect(text).toContain("anchor.route");
    // The distinction is the requirement: provenance vs. position.
    expect(text).toContain("provenance");
    expect(text).toContain("position");
    expect(text).toContain("null");
  });

  it("[FR-6.7] states the non-suppressible warning and the journal location/author risk", () => {
    const text = textFor("FR-6.7");
    // The warning is not suppressible, not even by --quiet.
    expect(text).toContain("cannot be suppressed");
    expect(text).toContain("`--quiet`");
    // The public journal exposes audit metadata; that is an accepted risk, not an oversight.
    expect(text).toContain("journal");
    expect(text).toContain("`location`");
    expect(text).toContain("`author`");
    expect(text).toContain("accepted risk");
  });

  it("[FR-6.9] puts the credential in the worker and removes the token attributes", () => {
    const text = textFor("FR-6.9");
    expect(text).toContain("service worker");
    expect(text).toContain("page never sees a credential");
    // The embed attributes and the window config field are gone in 0.12.0.
    expect(text).toContain("`token`");
    expect(text).toContain("`token-header`");
    expect(text).toContain("`token-scheme`");
    expect(text).toContain("`__bluepencilConfig__.token`");
    expect(text).toContain("removed in 0.12.0");
    // A host that still sets them gets told, instead of a silent unauthenticated request.
    expect(text).toContain("`issues`");
  });

  it("[FR-14.2] carries origin in the bundle and in the summary", () => {
    const text = textFor("FR-14.2");
    expect(text).toContain("`origin`");
    expect(text).toContain("summary");
    expect(text).toContain("distinct origins");
    expect(text).toContain("unassigned");
    expect(text).toContain("null");
  });

  it("[FR-14.3] pins the merge rule to existing.origin ?? incoming.origin", () => {
    const text = textFor("FR-14.3");
    expect(text).toContain("`existing.origin ?? incoming.origin`");
    // The rule's observable consequences.
    expect(text).toContain("divergingFields");
    expect(text).toContain("conflicts");
    expect(text).toContain("skipped");
  });

  it("[FR-16.1] makes origin optional in create_note and list_notes", () => {
    const text = textFor("FR-16.1");
    expect(text).toContain("`create_note`");
    expect(text).toContain("`list_notes`");
    expect(text).toContain("optional `origin`");
    // `null` selects the unassigned notes; an absent field must not widen the filter.
    expect(text).toContain("`origin: null`");
    expect(text).toContain("no silent widening");
  });
});

describe("requirement baseline — the size budget rule", () => {
  it("[NFR-3] names the measured values, the measurement date and the derivation rule", () => {
    const text = textFor("NFR-3");
    expect(text).toContain("Core = measured + 10 %");
    expect(text).toContain("IIFE = measured + 1.5 kB");
    expect(text).toContain("Element = measured + 1.5 kB");
    expect(text).toContain("attach loader");

    // Real numbers with the measurement date, not the old release-cut caveat.
    expect(text).toContain("2026-11-03");
    expect(text).toContain("Core 40.7 kB");
    expect(text).toContain("44.7 kB");
    expect(text).toContain("IIFE 44.4 kB");
    expect(text).toContain("45.9 kB");
    expect(text).toContain("Element 47.6 kB");
    expect(text).toContain("49.1 kB");
    expect(text).toContain("attach 4.1 kB");
    expect(text).toContain("never raised preventively");
    expect(text).toContain("no historical budget figure");
    expect(text).not.toContain("Zahlen folgen im Release-Cut");

    // No carried-forward headline figure (the old 33 kB and 100 kB claims) …
    expect(text).not.toMatch(/33\s?kB/i);
    expect(text).not.toMatch(/100\s?kB/i);
  });
});

describe("requirement baseline — the generated spec", () => {
  it("[FR-17][FR-18][FR-19][FR-20] generates one spec directory per shipped section and none for the withdrawn one", () => {
    const dirs = specDirs();
    for (const group of SHIPPED_GROUPS) {
      expect(dirs, `${group.id} spec directory`).toContain(group.dir);
      expect(specIds(group.dir).length, `${group.dir} requirements`).toBeGreaterThan(0);
    }

    // FR-21 is withdrawn, so it must not survive as a generated group.
    expect(dirs).not.toContain("21-voice");
    expect(dirs.some((dir) => /^21[-_]/.test(dir))).toBe(false);
    for (const dir of dirs) {
      expect(specIds(dir).some((id) => id.startsWith("FR-21")), `${dir} carries FR-21`).toBe(false);
    }
  });

  it("[FR-17][FR-18][FR-19][FR-20] keeps the spec headings in step with the requirement table", () => {
    for (const group of SHIPPED_GROUPS) {
      expect(new Set(specIds(group.dir)), `${group.dir} ids`).toEqual(new Set(group.members));
    }
  });

  it("[FR-2.2][FR-6.7][FR-6.9][FR-14.2][FR-14.3][FR-16.1][NFR-3] defines every cited requirement id as a section", () => {
    // A light existence check for the ids the contracts cite — not a repo-wide ID gate (G3).
    const leafIds = ["FR-2.2", "FR-6.7", "FR-6.9", "FR-14.2", "FR-14.3", "FR-16.1", "NFR-3"];
    const specHeadings = new Set(specDirs().flatMap((dir) => specIds(dir)));

    for (const id of leafIds) {
      expect(rowFor(id).id, `${id} in the requirement table`).toBe(id);
      expect(specHeadings.has(id), `${id} in the generated spec`).toBe(true);
    }
    for (const group of SHIPPED_GROUPS) {
      expect(sectionFor(group.id).heading, `${group.id} in the requirement table`).toContain(
        group.id,
      );
      for (const member of group.members) {
        expect(specHeadings.has(member), `${member} in the generated spec`).toBe(true);
      }
    }
  });
});

/**
 * AC-D11's documentation half (G1, SEC-10).
 *
 * The journal is public on purpose; the two fields FR-6.7 calls out (`location`, `author`) are the
 * accepted risk. This block is deliberately separate from the FR-6.7 wording assertions above so
 * contract D observes its own sentence without rewriting an F block (plan §2.2).
 */
describe("requirement baseline — FR-6.7's documented accepted risk (AC-D11)", () => {
  it("[FR-6.7] keeps the non-suppressible bind warning and the journal location/author exposure as an accepted risk", () => {
    const row = rowFor("FR-6.7");
    const text = row.cells[1] ?? "";
    const acceptance = row.cells[row.cells.length - 1] ?? "";

    // G1 = B: the non-loopback bind stays allowed — visibility, not a refusal, is the mitigation.
    expect(text).toContain("bind beyond loopback");
    expect(text).toContain("`stderr`");
    expect(text).toContain("cannot be suppressed");
    expect(text).toContain("`--quiet`");
    expect(text).toContain("readable by anyone who can reach the port");

    // The journal is the deliberate exception: audit metadata beyond the note body, plus the two
    // fields an unauthenticated reader learns. That is the risk, and it is named as accepted.
    expect(text).toContain("deliberate exception");
    expect(text).toContain("`noteId`");
    expect(text).toContain("`actor`");
    expect(text).toContain("`summary`");
    expect(text).toContain("`location`");
    expect(text).toContain("`author`");
    expect(text).toContain("accepted risk");

    // The acceptance criterion pins the observable contract, so an editorial rewrite cannot drop
    // either field or turn the warning into something `--quiet` may hide.
    expect(acceptance).toContain("`location`");
    expect(acceptance).toContain("`author`");
    expect(acceptance).toContain("including with `--quiet`");
  });
});
