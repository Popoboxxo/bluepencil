/**
 * Client presence on the hub — the *last time a credential kind was accepted*, not a client list.
 *
 * The hub has no sessions and no client registry: every request carries everything it needs, and a
 * reader that never writes leaves no trace in the note set or the journal. What *is* observable is
 * the authentication itself, one level below the routes: whether a request got in with a signed
 * token or with the shared secret. That is what this module records, and nothing more:
 *
 * - **One value per credential kind** (`token`, `secret`), both nullable. Since #134 a third,
 *   additive signal records the last accepted request per *named device* (the name inside a verified
 *   token, never a browser identity). Two browsers holding the same shared secret remain
 *   indistinguishable; a per-device stamp exists only for a verified signed token.
 * - **At most one write per kind/device per minute.** A page that polls the hub must not turn presence into
 *   a clock churn. A stamp younger than the throttle window keeps the previous value untouched —
 *   including when the clock stepped backwards, where `at - previous` is negative and also falls
 *   inside the window.
 * - **Memory only.** Nothing is written to disk, so a restart forgets presence; the admin page says
 *   so instead of pretending the timestamps survive.
 * - **No secret and no token value** ever reaches this module: callers pass a credential *kind*, and
 *   a snapshot holds ISO-8601 timestamps or `null`.
 * - **Injectable.** `createPresence({ now })` takes a clock so tests need no fake timers, and the
 *   handler context can carry an explicit tracker (`presenceOf` returns it unchanged). Without one,
 *   a tracker is created lazily per context object in a `WeakMap` — no module-level mutable state,
 *   so two hubs in one process (and two tests) never share presence.
 */

/** The credential kinds the hub distinguishes at its gate — the same two `authorize()` checks. */
export type PresenceKind = "token" | "secret";

/** What `/admin/status` reports; ISO-8601 timestamps, or `null` when a kind was never accepted. */
export interface PresenceSnapshot {
  token: string | null;
  secret: string | null;
  /**
   * #134: last accepted request per *named device* (not per browser), throttled like the two kind
   * stamps. The optional sessionRef is the one a client sent in `mcp-session-id`, so the admin page
   * can drill from a device to the notes of that session. Memory only; never a credential value.
   */
  devices: Array<{ device: string; lastSeenAt: string; sessionRef?: string }>;
}

/** Dependencies of a tracker; all optional so the production path is a plain `createPresence()`. */
export interface PresenceOptions {
  /** Wall clock in epoch milliseconds; injectable so tests need no fake timers. */
  now?: () => number;
  /** Minimum interval between two recorded stamps of one kind; defaults to one minute. */
  throttleMs?: number;
}

export interface PresenceTracker {
  /** Records "a credential of this kind was accepted now", throttled per kind. */
  stamp(kind: PresenceKind): void;
  /** #134: records a named device's last accepted request and the session it presented. */
  stampDevice(device: string, sessionRef?: string): void;
  /** A copy of the current state; later stamps do not mutate it. */
  snapshot(): PresenceSnapshot;
}

/** One write per kind per minute — the documented throttle. */
export const PRESENCE_THROTTLE_MS = 60_000;

const KINDS: readonly PresenceKind[] = ["token", "secret"];

/**
 * A tracker with its own clock and throttle. The state is closed over, so two trackers are two
 * independent hubs even inside one process.
 */
export function createPresence(options: PresenceOptions = {}): PresenceTracker {
  const now = options.now ?? Date.now;
  const throttleMs = options.throttleMs ?? PRESENCE_THROTTLE_MS;
  const lastSeen = new Map<PresenceKind, number>();
  const deviceSeen = new Map<string, { at: number; sessionRef?: string }>();

  return {
    stamp(kind: PresenceKind): void {
      const at = now();
      // A non-finite clock (a broken or mocked `now`) records nothing rather than an invalid date.
      if (!Number.isFinite(at)) return;
      const previous = lastSeen.get(kind);
      // Keep the previous value: no write, no clock churn — also for a backwards clock step.
      if (previous !== undefined && at - previous < throttleMs) return;
      lastSeen.set(kind, at);
    },

    stampDevice(device: string, sessionRef?: string): void {
      const name = device.trim();
      if (name.length === 0) return;
      const at = now();
      if (!Number.isFinite(at)) return;
      const previous = deviceSeen.get(name);
      if (previous !== undefined && at - previous.at < throttleMs) return;
      deviceSeen.set(name, sessionRef === undefined ? { at } : { at, sessionRef });
    },

    snapshot(): PresenceSnapshot {
      const snapshot: PresenceSnapshot = { token: null, secret: null, devices: [] };
      for (const kind of KINDS) {
        const at = lastSeen.get(kind);
        if (at !== undefined && Number.isFinite(at)) snapshot[kind] = new Date(at).toISOString();
      }
      for (const [device, { at, sessionRef }] of deviceSeen) {
        if (!Number.isFinite(at)) continue;
        const entry: { device: string; lastSeenAt: string; sessionRef?: string } = {
          device,
          lastSeenAt: new Date(at).toISOString(),
        };
        if (sessionRef !== undefined) entry.sessionRef = sessionRef;
        snapshot.devices.push(entry);
      }
      return snapshot;
    },
  };
}

/** Anything that may carry an injected tracker — structurally `HandlerContext`, without importing it. */
export interface PresenceHost {
  presence?: PresenceTracker;
}

/**
 * The tracker belonging to one handler context.
 *
 * An explicitly injected tracker wins (that is how tests pin the clock). Otherwise the tracker is
 * created once per context *object* and kept in a `WeakMap`: the hub builds its context once at
 * startup, so the tracker lives exactly as long as the hub, and nothing leaks between tests or
 * between two hubs in one process.
 */
const trackers = new WeakMap<object, PresenceTracker>();

export function presenceOf(host: PresenceHost): PresenceTracker {
  if (host.presence !== undefined) return host.presence;
  let tracker = trackers.get(host);
  if (tracker === undefined) {
    tracker = createPresence();
    trackers.set(host, tracker);
  }
  return tracker;
}
