/**
 * Presentation mode (FR-20).
 *
 * A layer on top of the annotation layer, not a second data layer: it reads the *same* store, so a
 * speaker note is an ordinary note (FR-15.3 — one store, one schema) and an agent can write it with
 * `create_note` over MCP or the sidecar without learning anything about this module.
 *
 * Three states, and the third is not a variant of the second:
 *
 *   off  — the layer is untouched; the host page behaves as if this file did not exist.
 *   read — presenter panel: talk clock, the cue that is due now, notes per chapter, read only.
 *   edit — the same panel, but notes can be written and timed from it.
 *
 * The audience view (FR-20.6) is a second browser tab of the *same* origin, addressed by
 * `?bp-present=1`. It talks to the presenter tab over a `BroadcastChannel` — no server, no new
 * dependency, and nothing that leaves the machine (FR-9.4/NFR-7). It is read-only by construction:
 * an audience tab never gets a write path, the same stance as a live system being admin-only
 * (FR-14.6).
 *
 * Keyboard: the mode owns a profile of its own, and every key it claims is one no host page uses
 * for navigation (`j`/`k`/`0`–`9` stay with the host — see the table in docs/REQUIREMENTS.md FR-20.8).
 * `Escape` is shared with the layer's cancel, which is why leaving the mode is the same gesture.
 */

import { formatCue } from "../core/export/markdown";
import type { MessageKey } from "../i18n";
import type { Note } from "../core/model";

/** What the mode is doing right now. */
export type PresentMode = "off" | "read" | "edit";

/** Which side of the handshake a tab is on. */
export type PresentRole = "presenter" | "audience";

export interface PresentationOptions {
  /** Where the note set comes from — the very store the layer annotates with. */
  notes(): Note[];
  /** Renders one note as a presenter line; defaults to the note body. */
  renderNote?: (note: Note) => string;
  /** Chapter label for a note, normally the host's current section. */
  routeOf?: (note: Note) => string | undefined;
  /** Called when a note is written from the panel; the layer's store does the persisting. */
  onWrite?: (id: string, body: string) => void;
  /** Called when a cue is retimed from the panel. */
  onRetime?: (id: string, at: number) => void;
  /** Overrides the audience tab URL; used by the fixture and by tests. */
  audienceUrl?: () => string;
  language?: string;
  t?: (key: MessageKey) => string;
  onError?: (err: unknown) => void;
}

export interface PresentationHandle {
  readonly mode: PresentMode;
  setMode(mode: PresentMode): void;
  toggle(): void;
  /** Opens the audience tab (FR-20.6). Returns false when the browser refused the popup. */
  openAudience(): boolean;
  /** Presenter clock in seconds since the talk was started; 0 when stopped. */
  elapsed(): number;
  /** Whether the clock is currently advancing. One key drives both directions (FR-20.5). */
  elapsedRunning(): boolean;
  start(): void;
  pause(): void;
  reset(): void;
  /** Feeds a store change into the panel. */
  refresh(notes: Note[]): void;
  /** Tears the panel down and drops every listener, timer and channel (FR-12.2). */
  destroy(): void;
}

const TICK_MS = 250;
const CHANNEL = "bluepencil:present";

type BusMessage =
  | { kind: "hello"; role: PresentRole; mode: PresentMode }
  | { kind: "ready"; role: PresentRole }
  | { kind: "cue"; route?: string; label?: string }
  | { kind: "time"; elapsed: number; running: boolean }
  | { kind: "notes-updated" };

/** A cue in talk order. Notes without timing are appended after the timed ones, by creation. */
export interface Cue {
  note: Note;
  at: number;
  duration?: number;
  label?: string;
  route?: string;
}

/**
 * The talk plan: timed notes in order, with the total planned length. A note with no `timing` is a
 * valid note that simply has no place on the clock — it stays in the panel, sorted last, because a
 * speaker still wants to read it.
 */
export function readCues(notes: Note[], routeOf?: (note: Note) => string | undefined): Cue[] {
  const timed = notes.filter((note): note is Note & { timing: NonNullable<Note["timing"]> } =>
    note.timing !== undefined,
  );
  const untimed = notes.filter((note) => note.timing === undefined);
  const byAt = (a: Cue, b: Cue): number => a.at - b.at || a.note.createdAt.localeCompare(b.note.createdAt);
  return [
    ...timed
      .map((note) => ({
        note,
        at: note.timing.at,
        duration: note.timing.duration,
        label: note.timing.label,
        route: note.anchor.route ?? routeOf?.(note),
      }))
      .sort(byAt),
    ...untimed.map((note) => ({ note, at: Number.POSITIVE_INFINITY, route: note.anchor.route ?? routeOf?.(note) })),
  ];
}

/** Total planned talk length in seconds: the sum of the cues' own durations. */
export function totalDuration(cues: Cue[]): number {
  return cues.reduce((sum, cue) => sum + (cue.duration ?? 0), 0);
}

/** The cue that is due at `elapsed`, i.e. the last one that has not run out yet. */
export function currentCue(cues: Cue[], elapsed: number): Cue | undefined {
  let found: Cue | undefined;
  for (const cue of cues) {
    if (!Number.isFinite(cue.at)) break;
    if (cue.at <= elapsed) found = cue;
    else break;
  }
  return found;
}

export function createPresentation(options: PresentationOptions, doc: Document): PresentationHandle {
  const t = options.t ?? ((key: string) => key);
  let mode: PresentMode = "off";
  let role: PresentRole = "presenter";
  let notes: Note[] = options.notes();
  let root: HTMLElement | null = null;
  let clockEl: HTMLElement | null = null;
  let modeEl: HTMLButtonElement | null = null;
  let listEl: HTMLElement | null = null;
  let ticker: number | null = null;
  let elapsed = 0;
  let lastTick = 0;
  let running = false;
  let channel: BroadcastChannel | null = null;

  /* Same-origin handshake. No BroadcastChannel (older browsers, some embedded webviews) simply
   * means the audience tab shows the page and no live clock — the presenter tab still works. */
  const bus = {
    send(message: BusMessage): void {
      channel?.postMessage(message);
    },
    on(handler: (message: BusMessage) => void): void {
      if (!channel) return;
      channel.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { role?: PresentRole; message?: BusMessage } | null;
        if (data?.role === role || data?.role === undefined) handler(data?.message as BusMessage);
      });
    },
    open(): void {
      if (typeof BroadcastChannel === "undefined" || channel) return;
      try {
        channel = new BroadcastChannel(CHANNEL);
      } catch (error) {
        options.onError?.(error);
      }
    },
    close(): void {
      channel?.close();
      channel = null;
    },
  };

  function send(message: BusMessage): void {
    bus.send({ ...message, role } as BusMessage);
  }

  /* -- the audience tab (FR-20.6) --------------------------------------- */

  function audienceUrl(): string {
    if (options.audienceUrl) return options.audienceUrl();
    const url = new URL(doc.defaultView?.location.href ?? "about:blank");
    url.searchParams.set("bp-present", "1");
    url.searchParams.set("bp-mode", "read");
    return url.toString();
  }

  function openAudience(): boolean {
    const view = doc.defaultView;
    if (!view) return false;
    // `noopener` keeps the audience tab from reaching back into the presenter tab's window object.
    const opened = view.open(audienceUrl(), "bluepencil-audience", "width=1280,height=800,noopener");
    if (!opened) options.onError?.(new Error("popup blocked"));
    return opened !== null;
  }

  /* -- the clock -------------------------------------------------------- */

  function tick(): void {
    const now = Date.now();
    elapsed += (now - lastTick) / 1000;
    lastTick = now;
    renderClock();
    send({ kind: "time", elapsed, running });
  }

  function renderClock(): void {
    if (!clockEl) return;
    const planned = totalDuration(readCues(notes, options.routeOf));
    // Past the plan the clock goes red: overrunning is the one thing a speaker must notice.
    clockEl.textContent = `${formatCue(elapsed)} / ${formatCue(planned)}`;
    clockEl.classList.toggle("bp-is-over", planned > 0 && elapsed > planned);
  }

  /* -- the panel -------------------------------------------------------- */

  function chapterLabel(cue: Cue): string {
    return cue.route ?? cue.label ?? t("present.unplaced" as MessageKey);
  }

  function renderPanel(): void {
    if (!root || !listEl) return;
    const cues = readCues(notes, options.routeOf);
    const active = currentCue(cues, elapsed);
    listEl.textContent = "";

    let lastRoute: string | undefined;
    for (const cue of cues) {
      if (cue.route !== undefined && cue.route !== lastRoute) {
        const heading = doc.createElement("li");
        heading.className = "bp-present-chapter";
        heading.textContent = cue.route;
        listEl.append(heading);
        lastRoute = cue.route;
      }
      const item = doc.createElement("li");
      item.className = "bp-present-item";
      item.setAttribute("data-bp-note-id", cue.note.id);
      if (active?.note.id === cue.note.id) {
        item.classList.add("is-current");
        item.setAttribute("aria-current", "true");
      }

      const meta = doc.createElement("p");
      meta.className = "bp-present-meta";
      meta.textContent = Number.isFinite(cue.at) ? formatCue(cue.at) : chapterLabel(cue);

      const body = doc.createElement("p");
      body.className = "bp-present-body";
      const rendered = options.renderNote?.(cue.note) ?? cue.note.body;
      body.textContent = rendered;

      item.append(meta, body);

      // Edit mode adds the two write paths: the text of the note and its cue (FR-20.5).
      if (mode === "edit") {
        const editor = doc.createElement("textarea");
        editor.className = "bp-present-textarea";
        editor.value = rendered;
        editor.setAttribute("aria-label", t("present.editLabel" as MessageKey));
        editor.addEventListener("change", () => options.onWrite?.(cue.note.id, editor.value));
        item.append(editor);
      }
      listEl.append(item);
    }

    if (modeEl) {
      modeEl.textContent = mode === "edit" ? t("present.edit" as MessageKey) : t("present.read" as MessageKey);
      modeEl.setAttribute("aria-pressed", String(mode === "edit"));
    }
    renderClock();
  }

  function ensurePanel(): void {
    if (root || role === "audience") return;
    root = doc.createElement("section");
    root.className = "bp-present";
    root.setAttribute("data-bp-part", "presentation");
    root.setAttribute("data-bp-mode", mode);
    root.setAttribute("data-bp-slot", "bottom-start");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", t("present.panelLabel" as MessageKey));

    const bar = doc.createElement("header");
    bar.className = "bp-present-bar";

    clockEl = doc.createElement("span");
    clockEl.className = "bp-present-clock";
    clockEl.setAttribute("role", "timer");
    clockEl.setAttribute("aria-live", "off");

    modeEl = doc.createElement("button");
    modeEl.type = "button";
    modeEl.className = "bp-present-mode";
    modeEl.addEventListener("click", () => setMode(mode === "edit" ? "read" : "edit"));

    const audience = doc.createElement("button");
    audience.type = "button";
    audience.className = "bp-present-audience";
    audience.setAttribute("data-bp-action", "audience");
    audience.textContent = t("present.audience" as MessageKey);
    audience.addEventListener("click", () => openAudience());

    bar.append(clockEl, modeEl, audience);

    listEl = doc.createElement("ol");
    listEl.className = "bp-present-list";
    listEl.setAttribute("data-bp-part", "presentation-list");

    root.append(bar, listEl);
    doc.body.append(root);
  }

  function teardownPanel(): void {
    root?.remove();
    root = null;
    clockEl = null;
    modeEl = null;
    listEl = null;
  }

  /* -- mode ------------------------------------------------------------- */

  function applyMode(): void {
    // An audience tab is a viewer: it reflects the mode it was opened with and has no panel of its
    // own, so `off` there means "hide the markers", not "leave".
    if (root) root.setAttribute("data-bp-mode", mode);
    if (mode === "off") {
      if (role === "presenter") {
        stopTicker();
        teardownPanel();
      } else {
        root?.setAttribute("hidden", "");
      }
    } else if (role === "presenter") {
      ensurePanel();
      renderPanel();
    }
    doc.dispatchEvent(new CustomEvent("bp:present", { detail: { mode, role } }));
  }

  function setMode(next: PresentMode): void {
    if (mode === next) return;
    mode = next;
    applyMode();
    send({ kind: "hello", role, mode });
  }

  function stopTicker(): void {
    if (ticker !== null) {
      doc.defaultView?.clearInterval(ticker);
      ticker = null;
    }
    running = false;
  }

  function startTicker(): void {
    if (mode === "off" || ticker !== null) return;
    lastTick = Date.now();
    ticker = doc.defaultView?.setInterval(tick, TICK_MS) ?? null;
  }

  const handle: PresentationHandle = {
    get mode() {
      return mode;
    },
    setMode,
    toggle() {
      setMode(mode === "off" ? "read" : "off");
    },
    openAudience,
    elapsed: () => elapsed,
    elapsedRunning: () => running,
    start() {
      if (running) return;
      running = true;
      lastTick = Date.now();
      startTicker();
      send({ kind: "time", elapsed, running: true });
    },
    pause() {
      if (!running) return;
      tick();
      running = false;
      stopTicker();
      send({ kind: "time", elapsed, running: false });
    },
    reset() {
      elapsed = 0;
      running = false;
      stopTicker();
      renderClock();
      send({ kind: "time", elapsed: 0, running: false });
    },
    refresh(next: Note[]) {
      notes = next;
      renderPanel();
      send({ kind: "notes-updated" });
    },
    destroy() {
      stopTicker();
      teardownPanel();
      bus.close();
      root = null;
    },
  };

  /* -- wiring ----------------------------------------------------------- */

  /**
   * The tab's role and initial mode come from the URL, read-only for that load (the same rule as
   * `?bp-chrome=`, FR-12.12): an audience tab is `read` whatever the presenter does, and a
   * presenter tab never starts in presentation mode on its own.
   *
   * Returns the state instead of assigning it — a nested mutation would leave the declared type
   * narrowed to `"presenter"` at the call site, which is exactly the kind of silent narrowing that
   * makes a role check silently dead.
   */
  function urlState(): { role: PresentRole; mode: PresentMode } {
    const search = doc.defaultView?.location.search;
    if (!search) return { role, mode };
    const params = new URLSearchParams(search);
    if (params.get("bp-present") !== "1") return { role, mode };
    return { role: "audience", mode: params.get("bp-mode") === "edit" ? "edit" : "read" };
  }

  const initial = urlState();
  role = initial.role;
  mode = initial.mode;
  bus.open();
  if (mode !== "off") applyMode();
  if (role === "audience") {
    send({ kind: "hello", role, mode });
    bus.on((message) => {
      if (message.kind === "time") {
        elapsed = message.elapsed;
        renderClock();
      }
    });
  }

  return handle;
}
