/**
 * The worker-selection bookkeeping for the extension smoke test, split out so it can be tested
 * without a browser (issue #60).
 *
 * The selection loop itself is trivial; the part that flaked was the bookkeeping around a *failed*
 * probe. The old loop kept a `probed` Set of targetIds and skipped any id it had already touched,
 * so one transient failure — the worker had not finished its first evaluation yet, the 2 s attach
 * timed out, a CDP hiccup — was turned into a permanent verdict. The real worker was then excluded
 * for the rest of the 20 s budget and the run failed with "no extension service worker" while the
 * worker was right there.
 *
 * The fix is to never make a failure final: a target is remembered with an attempt count and is
 * asked again on a later pass until `maxAttempts` is reached or the deadline expires. A miss that
 * exhausts its attempts is only diagnosed, never silently dropped.
 *
 * Kept as plain ESM JS on purpose: `extension/*.mjs` is not part of the TypeScript project
 * (`tsconfig.json` includes `src/**` only), so a `.ts` file here would drag the extension build and
 * its tsconfig into the test harness for no gain.
 */

/**
 * Select the extension's own service worker from a live CDP target list.
 *
 * @param {object} options
 * @param {() => Array<{targetId: string, url?: string}> | Promise<Array<{targetId: string, url?: string}>>} options.candidates
 *   Returns the current candidate list. Called once per pass, so a worker that starts late still
 *   becomes a candidate.
 * @param {(targetId: string) => Promise<string | undefined>} options.probe
 *   Reads the target's own name. A throw or a non-string answer means "not this time", never "not
 *   this target": the failure stays retryable.
 * @param {RegExp} [options.expect] Matches the name of the worker that belongs to this extension.
 * @param {number} [options.timeoutMs] Overall budget. Nothing is selected after it expires.
 * @param {() => number} [options.now] Clock, injectable so a test can avoid real waiting.
 * @param {(ms: number) => Promise<void>} [options.sleep] Sleep, injectable for the same reason.
 * @param {number} [options.settleMs] Pause between passes over the candidate list.
 * @param {number} [options.maxAttempts] Attempts allowed per target before it is diagnosed.
 * @param {number} [options.backoffMs] Pause between two attempts on the same target — the first name
 *   read after an attach is exactly the call that races a worker still booting.
 * @param {() => string[]} [options.seen] Extra wire facts (e.g. every service_worker target) for the
 *   failure message. Optional; only used to make a genuine miss diagnosable.
 * @returns {Promise<{targetId: string, name: string, attempts: number, probed: Array<object>}>}
 * @throws {Error} when nothing matches within the budget, naming each candidate, its attempt count
 *   and whether it is still retryable.
 */
export async function selectWorker({
  candidates = () => [],
  probe,
  expect = /bluepencil/i,
  timeoutMs = 20000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  settleMs = 150,
  maxAttempts = 3,
  backoffMs = 200,
  seen = () => [],
} = {}) {
  if (typeof candidates !== "function") throw new TypeError("selectWorker: candidates must be a function");
  if (typeof probe !== "function") throw new TypeError("selectWorker: probe must be a function");

  const deadline = now() + timeoutMs;
  /** targetId → { targetId, url, attempts, last } — the attempt count replaces the old probed Set. */
  const records = new Map();

  while (now() < deadline) {
    const list = (await candidates()) ?? [];
    for (const candidate of list) {
      if (!candidate || typeof candidate.targetId !== "string") continue;
      // Create (and keep) the record before probing so even an exhausted target is still reported.
      let record = records.get(candidate.targetId);
      if (record === undefined) {
        record = { targetId: candidate.targetId, url: candidate.url, attempts: 0, last: "not probed" };
        records.set(candidate.targetId, record);
      }
      if (candidate.url !== undefined) record.url = candidate.url;

      while (record.attempts < maxAttempts && now() < deadline) {
        record.attempts += 1;
        let name;
        try {
          name = await probe(candidate.targetId);
        } catch (error) {
          name = undefined;
          record.last = `threw: ${error?.message ?? error}`;
        }
        if (typeof name === "string") {
          record.last = name;
          if (expect.test(name)) {
            return {
              targetId: candidate.targetId,
              name,
              attempts: record.attempts,
              probed: [...records.values()].map((entry) => ({
                ...entry,
                retryable: entry.attempts < maxAttempts,
              })),
            };
          }
        } else if (!String(record.last).startsWith("threw:")) {
          record.last = "no manifest";
        }
        // A miss is never final: back off briefly and ask the same target again. The next attempt
        // is what turns "the worker had not booted yet" back into a match instead of a red run.
        if (record.attempts < maxAttempts && now() < deadline) await sleep(backoffMs);
      }
    }
    if (now() >= deadline) break;
    await sleep(settleMs);
  }

  const described = [...records.values()]
    .map((entry) =>
      `${entry.url} (attempts=${entry.attempts}, retryable=${
        entry.attempts < maxAttempts ? "yes" : "no"
      }, last=${JSON.stringify(entry.last)})`,
    )
    .join(" | ");
  const extra = (seen() ?? []).join(", ");
  throw new Error(
    `no extension service worker matching ${expect} within ${timeoutMs} ms; candidates: ${
      described || "nothing"
    }; seen: ${extra || "nothing"}`,
  );
}
