/**
 * @vitest-environment node — `node:crypto` and a fake system clock are the whole subject here.
 *
 * One-time launcher tickets (spec §2.2 rules 1, AC-5.5, UT-11): 48 hex characters, a 60-second TTL,
 * atomic single use, a hard cap of 1024 with oldest-entry eviction, and a `size()` that prunes the
 * expired entries instead of reporting them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VIEWER_MAX_TICKETS,
  VIEWER_TICKET_TTL_SECONDS,
  createViewerTickets,
} from "../../server/viewer";

const NOW = new Date("2026-11-07T12:00:00.000Z");

/** Freezes `Date.now()`; `advance()` moves it — `setTimeout` is not used by the store. */
function freezeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("viewer tickets", () => {
  it("pins the documented constants", () => {
    expect(VIEWER_TICKET_TTL_SECONDS).toBe(60);
    expect(VIEWER_MAX_TICKETS).toBe(1024);
  });

  it("mints 24 random bytes as 48 lower-case hex characters with the default TTL", () => {
    freezeClock();
    const tickets = createViewerTickets();
    const { ticket, expiresAt } = tickets.mint();

    expect(ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(expiresAt).toBe(Date.now() + VIEWER_TICKET_TTL_SECONDS * 1000);
    expect(tickets.size()).toBe(1);
  });

  it("honours a custom TTL", () => {
    freezeClock();
    const tickets = createViewerTickets(5);
    expect(tickets.mint().expiresAt).toBe(Date.now() + 5_000);
  });

  it("mints distinct tickets", () => {
    freezeClock();
    const tickets = createViewerTickets();
    const first = tickets.mint().ticket;
    const second = tickets.mint().ticket;
    expect(first).not.toBe(second);
  });

  it("is single-use: the second consume of the same ticket is false", () => {
    freezeClock();
    const tickets = createViewerTickets();
    const { ticket } = tickets.mint();

    expect(tickets.consume(ticket)).toBe(true);
    expect(tickets.consume(ticket)).toBe(false);
    // The entry is gone, not merely marked: size() reflects the consumption.
    expect(tickets.size()).toBe(0);
  });

  it("refuses undefined, empty and unknown tickets", () => {
    freezeClock();
    const tickets = createViewerTickets();
    tickets.mint();

    expect(tickets.consume(undefined)).toBe(false);
    expect(tickets.consume("")).toBe(false);
    expect(tickets.consume("f".repeat(48))).toBe(false);
    // A failed lookup must not disturb the live set.
    expect(tickets.size()).toBe(1);
  });

  it("accepts a ticket right before the TTL and refuses it at the TTL", () => {
    freezeClock();
    const live = createViewerTickets();
    const expired = createViewerTickets();
    const fresh = live.mint().ticket;
    const stale = expired.mint().ticket;

    vi.advanceTimersByTime(VIEWER_TICKET_TTL_SECONDS * 1000 - 1);
    expect(live.consume(fresh)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(expired.consume(stale)).toBe(false);
  });

  it("size() prunes expired tickets instead of reporting them", () => {
    freezeClock();
    const tickets = createViewerTickets();
    tickets.mint();
    tickets.mint();
    tickets.mint();
    expect(tickets.size()).toBe(3);

    vi.advanceTimersByTime(VIEWER_TICKET_TTL_SECONDS * 1000);
    expect(tickets.size()).toBe(0);
  });

  it("caps the store at 1024 and evicts the oldest ticket first", () => {
    freezeClock();
    const tickets = createViewerTickets(3600);

    const oldest = tickets.mint().ticket;
    const secondOldest = tickets.mint().ticket;
    for (let index = 2; index < VIEWER_MAX_TICKETS; index += 1) tickets.mint();
    expect(tickets.size()).toBe(VIEWER_MAX_TICKETS);

    const newest = tickets.mint().ticket;
    expect(tickets.size()).toBe(VIEWER_MAX_TICKETS);

    // The insertion order is the age order: the first key made room for the new one.
    expect(tickets.consume(oldest)).toBe(false);
    expect(tickets.consume(secondOldest)).toBe(true);
    expect(tickets.consume(newest)).toBe(true);
  });
});
