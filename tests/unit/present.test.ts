/**
 * Unit tests for presentation mode (FR-20), derived from the delivered behaviour (CQ-04).
 *
 * Two halves, both at unit level:
 *
 *  - the pure timing seam — `readCues`, `totalDuration`, `currentCue` — which decides what the
 *    speaker sees at a given second. This is the contract in FR-20.3 and the place where an
 *    off-by-one hides.
 *  - `createPresentation` against a real jsdom document: the panel's state machine, the clock and
 *    the audience tab. No store, no layer, no network — the module takes its note set and its
 *    document as arguments.
 *
 * Everything is deterministic: the clock is driven by fake timers and the notes carry a fixed
 * `createdAt`, so nothing here depends on wall-clock time or execution order.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNote, type Note, type NoteDraft } from "../../src/core/model";
import {
  createPresentation,
  currentCue,
  readCues,
  totalDuration,
  type Cue,
  type PresentationHandle,
  type PresentationOptions,
} from "../../src/ui/present";

/* -------------------------------------------------------------------------- */
/* fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:05:00.000Z";

interface NoteSpec {
  id: string;
  /** Cue position in seconds; omitted means "this note has no timing". */
  at?: number;
  duration?: number;
  label?: string;
  /** Chapter carried by the anchor itself. */
  route?: string;
  createdAt?: string;
}

/** A realistic speaker note: a body, an anchor, and optionally a cue (FR-20.4). */
function makeNote(spec: NoteSpec): Note {
  const draft: NoteDraft = {
    id: spec.id,
    now: spec.createdAt ?? T0,
    type: "text",
    body: `speaker note for ${spec.id}`,
    anchor:
      spec.route === undefined
        ? { quote: `the line behind ${spec.id}` }
        : { quote: `the line behind ${spec.id}`, route: spec.route },
  };
  if (spec.at !== undefined) {
    draft.timing = {
      at: spec.at,
      ...(spec.duration !== undefined ? { duration: spec.duration } : {}),
      ...(spec.label !== undefined ? { label: spec.label } : {}),
    };
  }
  return createNote(draft);
}

function cueIds(cues: Cue[]): string[] {
  return cues.map((cue) => cue.note.id);
}

/** A three-cue talk: intro at 0, demo at 60, questions at 120, plus one untimed note. */
function talk(): Note[] {
  return [
    makeNote({ id: "n-demo", at: 60, duration: 60, route: "/demo" }),
    makeNote({ id: "n-questions", at: 120, duration: 30, route: "/qa" }),
    makeNote({ id: "n-intro", at: 0, duration: 30, route: "/intro" }),
    makeNote({ id: "n-appendix", route: "/demo" }),
  ];
}

/** A real element or a loud failure — indexing with `noUncheckedIndexedAccess` would hide it. */
function query<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`expected to find ${selector}`);
  }
  return found;
}

const handles: PresentationHandle[] = [];

/** Mounts the mode on the real jsdom document; every handle is torn down in `afterEach`. */
function present(notes: Note[], extra: Omit<PresentationOptions, "notes"> = {}): PresentationHandle {
  const handle = createPresentation({ notes: () => notes, ...extra }, document);
  handles.push(handle);
  return handle;
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-bp-part="presentation"]');
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.destroy();
  }
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/* -------------------------------------------------------------------------- */
/* readCues — talk order, ties and chapters (FR-20.3)                         */
/* -------------------------------------------------------------------------- */

describe("readCues (FR-20.3)", () => {
  it("[FR-20.3] orders timed notes by cue position, not by input order", () => {
    const cues = readCues([
      makeNote({ id: "n-late", at: 120 }),
      makeNote({ id: "n-early", at: 0 }),
      makeNote({ id: "n-middle", at: 60 }),
    ]);

    expect(cueIds(cues)).toEqual(["n-early", "n-middle", "n-late"]);
    expect(cues.map((cue) => cue.at)).toEqual([0, 60, 120]);
  });

  it("[FR-20.3] breaks equal cue positions by createdAt", () => {
    const cues = readCues([
      makeNote({ id: "n-second", at: 30, createdAt: T1 }),
      makeNote({ id: "n-first", at: 30, createdAt: T0 }),
    ]);

    expect(cueIds(cues)).toEqual(["n-first", "n-second"]);
  });

  it("[FR-20.3] appends untimed notes after every timed cue, whatever their input position", () => {
    const cues = readCues([
      makeNote({ id: "n-untimed-first" }),
      makeNote({ id: "n-timed", at: 10 }),
      makeNote({ id: "n-untimed-last" }),
    ]);

    expect(cueIds(cues)).toEqual(["n-timed", "n-untimed-first", "n-untimed-last"]);
    expect(cues[1]?.at).toBe(Number.POSITIVE_INFINITY);
    expect(cues[2]?.at).toBe(Number.POSITIVE_INFINITY);
  });

  it("[FR-20.3] keeps the input order of untimed notes (the store already hands them over in creation order)", () => {
    // Delivered behaviour, and the reason the doc comment's "by creation" holds in practice: the
    // untimed half is not re-sorted. A caller that passes an unsorted array gets that order back.
    const cues = readCues([makeNote({ id: "n-b" }), makeNote({ id: "n-a" })]);

    expect(cueIds(cues)).toEqual(["n-b", "n-a"]);
  });

  it("[FR-20.3] carries at, duration and label from the note's timing", () => {
    const [cue] = readCues([makeNote({ id: "n-intro", at: 15, duration: 45, label: "Auftrag" })]);

    expect(cue?.at).toBe(15);
    expect(cue?.duration).toBe(45);
    expect(cue?.label).toBe("Auftrag");
  });

  it("[FR-20.3] takes the chapter from the anchor route before asking the host", () => {
    const cues = readCues([makeNote({ id: "n-intro", at: 0, route: "/pricing" })], () => "/from-host");

    expect(cues[0]?.route).toBe("/pricing");
  });

  it("[FR-20.3] falls back to the host's route provider when the anchor has no route", () => {
    const cues = readCues([makeNote({ id: "n-intro", at: 0 })], () => "/checkout");

    expect(cues[0]?.route).toBe("/checkout");
  });

  it("[FR-20.3] leaves the chapter undefined when neither source names one", () => {
    const cues = readCues([makeNote({ id: "n-intro", at: 0 })]);

    expect(cues[0]?.route).toBeUndefined();
  });

  it("[FR-20.3] resolves the chapter of an untimed note the same way", () => {
    const cues = readCues([makeNote({ id: "n-appendix" })], () => "/appendix");

    expect(cues[0]?.route).toBe("/appendix");
  });

  it("[FR-20.3] returns an empty plan for an empty note set", () => {
    expect(readCues([])).toEqual([]);
  });

  it("[FR-20.3] does not reorder or mutate the caller's note array", () => {
    const notes = talk();
    const before = notes.map((note) => note.id);

    readCues(notes);

    expect(notes.map((note) => note.id)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* totalDuration — the planned talk length (FR-20.3)                          */
/* -------------------------------------------------------------------------- */

describe("totalDuration (FR-20.3)", () => {
  it("[FR-20.3] sums the cues' own durations", () => {
    const cues = readCues([
      makeNote({ id: "n-intro", at: 0, duration: 30 }),
      makeNote({ id: "n-demo", at: 30, duration: 120 }),
      makeNote({ id: "n-qa", at: 150, duration: 45 }),
    ]);

    expect(totalDuration(cues)).toBe(195);
  });

  it("[FR-20.3] counts a cue without a duration as zero", () => {
    const cues = readCues([
      makeNote({ id: "n-intro", at: 0, duration: 30 }),
      makeNote({ id: "n-open-end", at: 30 }),
    ]);

    expect(totalDuration(cues)).toBe(30);
  });

  it("[FR-20.3] is zero for an empty plan and for a plan with no durations", () => {
    expect(totalDuration([])).toBe(0);
    expect(totalDuration(readCues([makeNote({ id: "n-one", at: 0 }), makeNote({ id: "n-two" })]))).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* currentCue — the boundary table from FR-20.3                               */
/* -------------------------------------------------------------------------- */

describe("currentCue (FR-20.3)", () => {
  const cues = readCues([
    makeNote({ id: "n-intro", at: 10, duration: 10 }),
    makeNote({ id: "n-demo", at: 20, duration: 10 }),
    makeNote({ id: "n-appendix" }),
  ]);

  it("[FR-20.3] returns nothing at elapsed 0 before the first cue", () => {
    expect(currentCue(cues, 0)).toBeUndefined();
  });

  it("[FR-20.3] returns nothing for a negative elapsed time", () => {
    expect(currentCue(cues, -1)).toBeUndefined();
  });

  it("[FR-20.3] returns the cue exactly at its start", () => {
    expect(currentCue(cues, 10)?.note.id).toBe("n-intro");
    expect(currentCue(cues, 20)?.note.id).toBe("n-demo");
  });

  it("[FR-20.3] keeps the previous cue until the next start", () => {
    expect(currentCue(cues, 19.999)?.note.id).toBe("n-intro");
  });

  it("[FR-20.3] returns a cue that starts at zero when elapsed is zero", () => {
    const zeroBased = readCues([makeNote({ id: "n-zero", at: 0 })]);

    expect(currentCue(zeroBased, 0)?.note.id).toBe("n-zero");
  });

  it("[FR-20.3] returns the last timed cue past the end of the plan", () => {
    expect(currentCue(cues, 10_000)?.note.id).toBe("n-demo");
  });

  it("[FR-20.3] never returns an untimed note", () => {
    for (const elapsed of [0, 10, 20, 30, 10_000]) {
      expect(currentCue(cues, elapsed)?.at).not.toBe(Number.POSITIVE_INFINITY);
    }
  });

  it("[FR-20.3] returns nothing for an empty plan", () => {
    expect(currentCue([], 42)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* createPresentation — panel, modes and clock (FR-20.1, FR-20.5)             */
/* -------------------------------------------------------------------------- */

describe("createPresentation panel (FR-20.1)", () => {
  it("[FR-20.1] starts off and mounts no panel", () => {
    const handle = present(talk());

    expect(handle.mode).toBe("off");
    expect(panel()).toBeNull();
  });

  it("[FR-20.1] mounts the panel in read mode and removes it again on off", () => {
    const handle = present(talk());

    handle.setMode("read");
    expect(handle.mode).toBe("read");
    expect(panel()?.getAttribute("data-bp-mode")).toBe("read");
    expect(document.querySelectorAll(".bp-present-item")).toHaveLength(4);

    handle.setMode("off");
    expect(panel()).toBeNull();
  });

  it("[FR-20.1] toggles between off and read with one gesture", () => {
    const handle = present(talk());

    handle.toggle();
    expect(handle.mode).toBe("read");
    expect(panel()).not.toBeNull();

    handle.toggle();
    expect(handle.mode).toBe("off");
    expect(panel()).toBeNull();
  });

  it("[FR-20.1] destroy removes the panel and is idempotent", () => {
    const handle = present(talk());
    handle.setMode("read");

    handle.destroy();
    handle.destroy();

    expect(panel()).toBeNull();
  });

  it("[FR-20.3] lists the cues in talk order and groups them by chapter", () => {
    const handle = present([
      makeNote({ id: "n-questions", at: 120, duration: 30, route: "/qa" }),
      makeNote({ id: "n-demo", at: 60, duration: 60, route: "/demo" }),
      makeNote({ id: "n-intro", at: 0, duration: 30, route: "/intro" }),
    ]);
    handle.setMode("read");

    const list = query<HTMLElement>(document, ".bp-present-list");
    const items = [...list.querySelectorAll<HTMLElement>(".bp-present-item")];
    expect(items.map((item) => item.getAttribute("data-bp-note-id"))).toEqual([
      "n-intro",
      "n-demo",
      "n-questions",
    ]);

    const chapters = [...list.querySelectorAll<HTMLElement>(".bp-present-chapter")];
    expect(chapters.map((chapter) => chapter.textContent)).toEqual(["/intro", "/demo", "/qa"]);
  });

  it("[FR-20.3] groups only consecutive cues: an untimed note repeating an earlier chapter opens a second heading", () => {
    // Delivered behaviour, recorded rather than endorsed: the list is grouped by a running
    // `lastRoute`, and untimed notes are appended last (FR-20.3), so a chapter that reappears at
    // the end is not merged with its earlier block.
    const handle = present(talk());
    handle.setMode("read");

    const chapters = [...document.querySelectorAll<HTMLElement>(".bp-present-chapter")];
    expect(chapters.map((chapter) => chapter.textContent)).toEqual(["/intro", "/demo", "/qa", "/demo"]);
  });

  it("[FR-20.3] marks exactly the due cue with aria-current", () => {
    const handle = present(talk());
    handle.setMode("read");

    const current = document.querySelectorAll<HTMLElement>('.bp-present-item[aria-current="true"]');
    expect(current).toHaveLength(1);
    // elapsed is 0 and the intro starts at 0.
    expect(current[0]?.getAttribute("data-bp-note-id")).toBe("n-intro");
  });

  it("[FR-20.1] gives read mode no write path", () => {
    const handle = present(talk());
    handle.setMode("read");

    expect(document.querySelector(".bp-present-textarea")).toBeNull();
  });

  it("[FR-20.1] refresh replaces the note set the panel shows", () => {
    const handle = present([makeNote({ id: "n-intro", at: 0 })]);
    handle.setMode("read");

    handle.refresh([makeNote({ id: "n-intro", at: 0 }), makeNote({ id: "n-new", at: 30 })]);

    expect(document.querySelectorAll(".bp-present-item")).toHaveLength(2);
    expect(document.querySelector('[data-bp-note-id="n-new"]')).not.toBeNull();
  });
});

describe("createPresentation edit mode (FR-20.5)", () => {
  it("[FR-20.5] adds one textarea per cue in edit mode", () => {
    const handle = present(talk());
    handle.setMode("edit");

    expect(document.querySelectorAll(".bp-present-textarea")).toHaveLength(4);
  });

  it("[FR-20.5] reports a body edit through onWrite", () => {
    const onWrite = vi.fn<(id: string, body: string) => void>();
    const handle = present([makeNote({ id: "n-intro", at: 0 })], { onWrite });
    handle.setMode("edit");

    const editor = query<HTMLTextAreaElement>(document, ".bp-present-textarea");
    expect(editor.value).toBe("speaker note for n-intro");

    editor.value = "revised speaker note";
    editor.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledWith("n-intro", "revised speaker note");
  });

  it("[FR-20.5] renders a note through the supplied renderer when one is given", () => {
    const handle = present([makeNote({ id: "n-intro", at: 0 })], {
      renderNote: (note) => `rendered:${note.id}`,
    });
    handle.setMode("read");

    expect(query<HTMLElement>(document, ".bp-present-body").textContent).toBe("rendered:n-intro");
  });
});

describe("createPresentation clock (FR-20.5)", () => {
  it("[FR-20.3] renders elapsed over the planned length", () => {
    const handle = present(talk());
    handle.setMode("read");

    expect(query<HTMLElement>(document, ".bp-present-clock").textContent).toBe("0:00 / 2:00");
  });

  it("[FR-20.5] start advances the clock, pause freezes it", () => {
    vi.useFakeTimers();
    const handle = present(talk());
    handle.setMode("read");

    handle.start();
    expect(handle.elapsedRunning()).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(handle.elapsed()).toBeCloseTo(1, 5);

    handle.pause();
    expect(handle.elapsedRunning()).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(handle.elapsed()).toBeCloseTo(1, 5);
  });

  it("[FR-20.5] reset returns the clock to zero and stops it", () => {
    vi.useFakeTimers();
    const handle = present(talk());
    handle.setMode("read");
    handle.start();
    vi.advanceTimersByTime(2_000);

    handle.reset();

    expect(handle.elapsed()).toBe(0);
    expect(handle.elapsedRunning()).toBe(false);
    expect(query<HTMLElement>(document, ".bp-present-clock").textContent).toBe("0:00 / 2:00");

    vi.advanceTimersByTime(3_000);
    expect(handle.elapsed()).toBe(0);
  });

  it("[FR-20.5] marks the clock as overrun once elapsed passes the planned length", () => {
    vi.useFakeTimers();
    const handle = present([makeNote({ id: "n-intro", at: 0, duration: 30 })]);
    handle.setMode("read");
    const clock = query<HTMLElement>(document, ".bp-present-clock");

    handle.start();
    vi.advanceTimersByTime(30_000);
    expect(clock.classList.contains("bp-is-over")).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(clock.classList.contains("bp-is-over")).toBe(true);
    expect(clock.textContent).toBe("0:31 / 0:30");
  });

  it("[FR-20.5] leaving the mode stops the timer", () => {
    vi.useFakeTimers();
    const handle = present(talk());
    handle.setMode("read");
    handle.start();
    vi.advanceTimersByTime(1_000);

    handle.setMode("off");
    vi.advanceTimersByTime(5_000);

    expect(handle.elapsed()).toBeCloseTo(1, 5);
    expect(handle.elapsedRunning()).toBe(false);
  });

  it("[FR-20.3] moves the due-cue marker when the running clock reaches the next cue", () => {
    // The tick path re-evaluates the active cue, so `aria-current` follows the clock without the
    // list being rebuilt: the cue that is due now carries the marker, the previous one loses it.
    vi.useFakeTimers();
    const handle = present([
      makeNote({ id: "n-intro", at: 0, duration: 60 }),
      makeNote({ id: "n-demo", at: 60, duration: 60 }),
    ]);
    handle.setMode("read");

    expect(
      document.querySelector<HTMLElement>('.bp-present-item[aria-current="true"]')?.getAttribute("data-bp-note-id"),
    ).toBe("n-intro");

    handle.start();
    vi.advanceTimersByTime(61_000);

    expect(handle.elapsed()).toBeCloseTo(61, 5);
    expect(query<HTMLElement>(document, ".bp-present-clock").textContent).toBe("1:01 / 2:00");

    const current = document.querySelectorAll<HTMLElement>('.bp-present-item[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("data-bp-note-id")).toBe("n-demo");
    expect(document.querySelector('[data-bp-note-id="n-intro"]')?.hasAttribute("aria-current")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* createPresentation — the audience tab (FR-20.6)                            */
/* -------------------------------------------------------------------------- */

describe("createPresentation audience tab (FR-20.6)", () => {
  it("[FR-20.6] asks for a same-origin audience URL carrying bp-present=1 and bp-mode=read", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(window);
    const handle = present(talk());

    expect(handle.openAudience()).toBe(true);

    const [url, target, features] = open.mock.calls[0] ?? [];
    expect(typeof url).toBe("string");
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe(window.location.origin);
    expect(parsed.searchParams.get("bp-present")).toBe("1");
    expect(parsed.searchParams.get("bp-mode")).toBe("read");
    expect(target).toBe("bluepencil-audience");
    expect(String(features)).toContain("noopener");
  });

  it("[FR-20.6] uses the injected audience URL when the host supplies one", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(window);
    const handle = present(talk(), { audienceUrl: () => "https://example.test/app?bp-present=1" });

    handle.openAudience();

    expect(open).toHaveBeenCalledWith(
      "https://example.test/app?bp-present=1",
      "bluepencil-audience",
      expect.stringContaining("noopener"),
    );
  });

  it("[FR-20.6] reports a blocked popup instead of failing silently", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const onError = vi.fn<(error: unknown) => void>();
    const handle = present(talk(), { onError });

    expect(handle.openAudience()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
