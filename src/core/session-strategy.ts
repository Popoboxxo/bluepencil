/**
 * Client-configured session strategy (issue #135) — pure, DOM-free and dependency-free.
 *
 * A session ref is *intent*, not data: only the client knows whether shop-a and shop-b are one
 * review and whether two paths are one page. The hub keeps treating `sessionRef` as an opaque
 * string; this module is the one place that turns a configured strategy plus the automatic place
 * (origin, route) into that string.
 *
 * Vocabulary (`session-strategy` / `data-session-strategy` on the element):
 *   given                       the label verbatim — today's behaviour, the default
 *   origin                      <label>@<origin> (or the bare origin when no label was given)
 *   route                       <label>@<origin><route>
 *   glob:<pattern>              <label>@<origin><fixed key of the pattern>
 *   none                        no session ref at all
 *
 * A strategy attribute may be a comma-separated list: the first matching rule wins, the last
 * entry is the fallback (e.g. `glob:/shop/** , glob:/blog/** , origin`). An unknown token is a
 * validation issue, never a silent no-match. Everything after `@` is `[<instance>/]<origin>`;
 * the caller supplies an already-qualified origin for federated notes.
 */

import { normaliseOrigin } from "./origin";

/** One parsed rule of a strategy list. */
export type SessionRule =
  | { kind: "given" }
  | { kind: "origin" }
  | { kind: "route" }
  | { kind: "glob"; pattern: string; key: string }
  | { kind: "none" };

/** An ordered strategy; the last rule is the declared fallback. */
export type SessionStrategy = readonly SessionRule[];

/** What a rule needs to compute a ref. Deliberately structural so it is easy to test. */
export interface SessionPlace {
  /** Review label from `session` (may be absent). */
  label?: string;
  /** Canonical or federated origin (`dev-web/https://shop-a.de` is legal here). */
  origin?: string;
  /** Page route, pathname plus the opted-in query. */
  route?: string;
}

export interface ParsedStrategy {
  strategy?: SessionStrategy;
  issues: string[];
}

/** Characters a glob pattern may not contain: query, fragment and regex/character-class syntax. */
const FORBIDDEN_GLOB_CHARS = /[?#\[\](){}|^$\+\\\s]/;

/**
 * Validate one `glob:<pattern>` token and derive its session key.
 *
 * The key is the longest fixed prefix before the first placeholder (`/shop/**` → `/shop`).
 * Patterns are path patterns only: they start with `/`, contain no query, fragment or regex, and
 * their only wildcard tokens are `*` (one segment) and `**` (any number of segments, none
 * included). Returns `null` with a reason when the pattern is not valid.
 */
export function parseGlobRule(token: string): { rule: Extract<SessionRule, { kind: "glob" }> } | { issue: string } {
  const pattern = token.slice("glob:".length);
  if (pattern === "" || !pattern.startsWith("/")) {
    return { issue: `session-strategy "${token}" needs a glob pattern starting with "/"` };
  }
  if (FORBIDDEN_GLOB_CHARS.test(pattern)) {
    return { issue: `session-strategy "${token}" has forbidden glob characters (only /, *, ** and path segments are allowed)` };
  }
  const segments = pattern.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "") continue; // leading `/` and a single trailing `/` are harmless
    if (segment === "*" || segment === "**") continue;
    if (segment.includes("*")) {
      return { issue: `session-strategy "${token}" has an invalid wildcard "${segment}" (only * and ** are allowed)` };
    }
  }
  const firstPlaceholder = segments.findIndex((segment) => segment === "*" || segment === "**");
  const fixed = firstPlaceholder === -1 ? segments : segments.slice(0, firstPlaceholder);
  const key = `/${fixed.filter((segment) => segment !== "").join("/")}`;
  return { rule: { kind: "glob", pattern, key } };
}

/** Parse one strategy token (`given`, `origin`, `route`, `none`, `glob:…`). */
export function parseSessionRule(token: string): { rule: SessionRule } | { issue: string } {
  switch (token) {
    case "given":
    case "origin":
    case "route":
    case "none":
      return { rule: { kind: token } };
    default:
      if (token.startsWith("glob:")) return parseGlobRule(token);
      return {
        issue: `session-strategy "${token}" is not one of given, origin, route, none, glob:<pattern>`,
      };
  }
}

/**
 * Parse a `session-strategy` attribute value. An absent/empty value means `given` (the default,
 * so existing hosts produce byte-identical refs). Every unknown entry is reported; a list with
 * no valid entry falls back to `given` instead of disappearing silently.
 */
export function parseSessionStrategy(raw: string | undefined): ParsedStrategy {
  if (raw === undefined || raw.trim() === "") return { strategy: [{ kind: "given" }], issues: [] };
  const issues: string[] = [];
  const rules: SessionRule[] = [];
  for (const candidate of raw.split(",")) {
    const token = candidate.trim();
    if (token === "") continue;
    const parsed = parseSessionRule(token);
    if ("issue" in parsed) issues.push(parsed.issue);
    else rules.push(parsed.rule);
  }
  if (rules.length === 0) return { issues };
  // The last declared rule is the fallback; an explicit `given` at the end is never needed for
  // correctness but is harmless and stays where the host put it.
  return { strategy: Object.freeze(rules), issues };
}

/** `true` when a glob pattern matches a route. `*` = one segment, `**` = zero or more segments. */
export function globMatches(pattern: string, route: string): boolean {
  const path = route.split("?")[0] ?? route;
  const parts = path.split("/").slice(1).filter((segment) => segment !== "");
  const wanted = pattern.split("/").slice(1).filter((segment) => segment !== "");

  const match = (p: number, s: number): boolean => {
    if (p === wanted.length) return s === parts.length;
    const token = wanted[p];
    if (token === undefined) return false;
    if (token === "**") {
      // Zero segments, or one segment now and keep the `**` available for more.
      return match(p + 1, s) || (s < parts.length && match(p, s + 1));
    }
    if (s >= parts.length) return false;
    if (token !== "*" && token !== parts[s]) return false;
    return match(p + 1, s + 1);
  };
  return match(0, 0);
}

/** Canonical part of a place used in a ref: `[<instance>/]<origin>`; never a path or query. */
function placeOf(place: SessionPlace): string {
  if (place.origin === undefined || place.origin === "") return "";
  const slash = place.origin.indexOf("/");
  if (slash > 0) {
    // Federated spelling: `<instance>/<origin>`. The trailing part must itself be a canonical
    // origin — this parses unambiguously because an origin always starts with a scheme.
    const inner = place.origin.slice(slash + 1);
    if (normaliseOrigin(inner) === inner) return place.origin;
  }
  return normaliseOrigin(place.origin) ?? place.origin;
}

function compose(label: string | undefined, place: string): string | undefined {
  if (place === "") return label;
  if (label === undefined || label === "") return place;
  return `${label}@${place}`;
}

/**
 * Compose the session ref for one note. Returns `undefined` for `none` (no grouping at all) and
 * for a rule whose required place is unavailable — a note without an origin cannot be grouped
 * *by* origin, and inventing one would be worse than leaving it ungrouped.
 */
export function resolveSessionRef(
  strategy: SessionStrategy | undefined,
  place: SessionPlace,
): string | undefined {
  const rules = strategy ?? [{ kind: "given" }];
  for (const rule of rules) {
    switch (rule.kind) {
      case "given":
        return place.label;
      case "none":
        return undefined;
      case "origin": {
        const origin = placeOf(place);
        return origin === "" ? place.label : compose(place.label, origin);
      }
      case "route": {
        const origin = placeOf(place);
        const route = place.route ?? "";
        return compose(place.label, `${origin}${route}`);
      }
      case "glob": {
        if (place.route === undefined || !globMatches(rule.pattern, place.route)) continue;
        const origin = placeOf(place);
        return compose(place.label, `${origin}${rule.key}`);
      }
    }
  }
  // No rule matched and the last entry was a glob (a host without a fallback): report nothing
  // here — the element already reported the shape — and leave the note ungrouped.
  return undefined;
}
