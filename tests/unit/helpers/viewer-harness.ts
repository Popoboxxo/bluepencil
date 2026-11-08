/**
 * Shared fixtures for the viewer-origin tests (issue #140).
 *
 * The fixtures model the current `ViewerOptions` contract:
 *
 * - `viewer.tickets` / `createViewerTickets()` — the one-time launcher tickets;
 * - `viewer.origin` / `viewer.hubOrigin` — the viewer's own public origin and the hub's
 *   loopback *bind* origin;
 * - `viewer.hostAliases` — extra names for the host gate;
 * - `surface: "viewer"` — the surface switch `handleViewer()` and `authorize()` branch on;
 * - an injectable DNS `resolver` — the hermetic boundary for `checkTarget()`.
 */
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostResolver } from "../../../src/federation/net-policy";
import type { HandlerContext, ServerRequest } from "../../../server/handler";
import {
  DEFAULT_VIEWER_TTL_SECONDS,
  createViewerSessions,
  createViewerTickets,
  type ViewerOptions,
  type ViewerTickets,
} from "../../../server/viewer";

/** The documented default API base, kept in one place for every suite. */
export const BASE = "/bluepencil/api";

/** A distinct viewer origin: the proxy's `endpoint` must use it, never the request `Host`. */
export const VIEWER_ORIGIN = "http://viewer.example:8788";

/** The hub's loopback *bind* origin — the only kind of `hubOrigin` the spec allows (Task 4). */
export const HUB_ORIGIN = "http://127.0.0.1:8787";

/**
 * Temp dirs this helper created, removed best-effort once the importing test file is done.
 * Only dirs the helper owns are tracked; an `assetsDir` passed by a caller stays untouched.
 */
const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: a leaked temp dir must never fail a suite */
    }
  }
});

function createAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bp-viewer-"));
  createdDirs.push(dir);
  return dir;
}

/** Target shape of `ViewerOptions` from 0.14.0 (spec §2.2). */
export interface TargetViewerOptions extends ViewerOptions {
  /** Public origin of the viewer listener; the proxy endpoint and the cookie's `Secure` use it. */
  origin?: string;
  /** Hub bind origin, only for the launcher hint in the 401 message. */
  hubOrigin?: string;
  /** One-time launcher tickets (Task 4). */
  tickets: ViewerTickets;
  /** Extra host names for the host gate (`--viewer-origin`). */
  hostAliases?: readonly string[];
}

/** Target surface switch; `undefined` means "hub" (spec §2.1). */
export type HubSurface = "hub" | "viewer";

/** The fixture is a `HandlerContext` that also carries the stub resolver. */
export interface ViewerFixture extends HandlerContext {
  surface?: HubSurface;
  viewer: TargetViewerOptions;
  /** DNS stub for `checkTarget()`; pass it as `deps.resolver` to `handleViewer()`. */
  resolver: HostResolver;
}

export interface ViewerContextOverrides {
  /** Hosts the proxy may fetch. */
  allow?: readonly string[];
  /** Directory the assets route reads from. */
  assetsDir?: string;
  /** Operator secret the hub-side launcher would verify; the viewer surface must ignore it. */
  adminSecret?: string;
  /** API base, normally `BASE`. */
  base?: string;
  /** Hub bind origin for the refusal message. */
  hubOrigin?: string;
  /** Viewer public origin. */
  origin?: string;
  /** Stub resolver; a fresh one is created when omitted. */
  resolver?: HostResolver;
  /** Surface the context belongs to. */
  surface?: HubSurface;
  /** Pre-built ticket store; a target one is created when omitted. */
  tickets?: ViewerTickets;
  /** Session/ticket lifetime. */
  ttlSeconds?: number;
}

/**
 * Builds a viewer-surface context with the 0.14.0 target fields.
 *
 * `createViewerTickets()` is called exactly like `resolveOptions()` will call it, so this
 * fixture also exercises the factory's default lifetime once Task 4 provides it.
 */
export function viewerContext(overrides: ViewerContextOverrides = {}): ViewerFixture {
  const base = overrides.base ?? BASE;
  const assetsDir = overrides.assetsDir ?? createAssetsDir();
  const ttlSeconds = overrides.ttlSeconds ?? DEFAULT_VIEWER_TTL_SECONDS;
  const origin = overrides.origin ?? VIEWER_ORIGIN;
  const viewer: TargetViewerOptions = {
    assetsDir,
    allow: overrides.allow ?? ["example.com", "*.example.com"],
    ttlSeconds,
    origin,
    hubOrigin: overrides.hubOrigin ?? HUB_ORIGIN,
    sessions: createViewerSessions(ttlSeconds),
    tickets: overrides.tickets ?? createViewerTickets(),
    hostAliases: [new URL(origin).hostname],
  };
  return {
    store: { notes: [] },
    base,
    environment: "dev",
    adminSecret: overrides.adminSecret ?? "operator-secret-123456",
    viewer,
    surface: overrides.surface ?? "viewer",
    resolver: overrides.resolver ?? stubResolver().resolver,
  };
}

/**
 * A minimal server request; `method` defaults to the door's common case.
 *
 * `host` defaults to `HUB_ORIGIN`'s value so a POST can derive the launcher's `Origin` basis
 * (spec §8, RVW2-4); an explicit `host` in `headers` wins. `body` is only added when the caller
 * passes one, so a GET stays body-less.
 */
export function request(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
): ServerRequest {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:8787", ...headers },
    ...(body === undefined ? {} : { body }),
  };
}

/** What a stubbed hostname resolves to: a fixed address list, or a rejection. */
export type ResolverAnswer = readonly string[] | Error;

export interface ResolverStub {
  /** The injectable resolver. */
  readonly resolver: HostResolver;
  /** Hostnames in the order they were resolved. */
  readonly calls: string[];
  /** Overrides (or adds) an answer for one hostname. */
  answer(hostname: string, value: ResolverAnswer): void;
}

/**
 * A DNS stub that never touches the network: configurable per hostname, counting calls.
 *
 * Unknown hostnames resolve to `[]` (the "no answer" case the SSRF policy must refuse),
 * not to an error — that keeps the default deterministic. Pass an `Error` to model a
 * resolver failure such as `ENOTFOUND`.
 */
export function stubResolver(initial: Record<string, ResolverAnswer> = {}): ResolverStub {
  const answers = new Map<string, ResolverAnswer>(Object.entries(initial));
  const calls: string[] = [];
  const resolver: HostResolver = async (hostname) => {
    calls.push(hostname);
    const value = answers.get(hostname);
    if (value === undefined) return [];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    resolver,
    calls,
    answer(hostname, value) {
      answers.set(hostname, value);
    },
  };
}

export interface StubFetchOptions {
  /** Response status; defaults to `200` (or `302` for a redirect). */
  status?: number;
  /** `content-type` of an HTML answer. */
  contentType?: string;
  /** Answer with a redirect instead of a body. */
  redirectTo?: string;
  /** Throw instead of answering — models a connection failure or an abort. */
  error?: Error | string;
}

export interface FetchStub {
  /** The fetch implementation to inject as `deps.fetchImpl`. */
  fetchImpl: typeof fetch;
  /** URLs in the order they were fetched. */
  seen: string[];
}

/**
 * A fetch stub that records every URL and answers with HTML, a redirect or an error.
 *
 * The counter is the point of the SSRF tests: a refusal that happens before the fetch must
 * leave `seen` empty.
 */
export function stubFetch(html: string, options: StubFetchOptions = {}): FetchStub {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (options.error !== undefined) {
      throw options.error instanceof Error ? options.error : new Error(options.error);
    }
    if (options.redirectTo !== undefined) {
      return new Response(null, {
        status: options.status ?? 302,
        headers: { location: options.redirectTo },
      });
    }
    return new Response(html, {
      status: options.status ?? 200,
      headers: { "content-type": options.contentType ?? "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}
