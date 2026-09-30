import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suites are not homogeneous, and one global environment cannot serve them all.
    //
    // The browser-facing suites (ui, anchor, capture, attach, blueprint, ui-hydration, embed) need
    // jsdom. The Node-facing suites (journal, server) need the real Node builtins: under jsdom
    // `os.tmpdir` and `pathToFileURL` are not callable, which fails 14 tests on a clean checkout
    // of main.
    //
    // version.test.ts stays on jsdom: it reads the tree with `node:fs` *and* imports the element
    // build, which extends `HTMLElement`. It reaches `node:fs` through `createRequire` for the
    // same reason embed.test.ts reaches `node:vm` — under jsdom these builtin namespaces carry
    // only `default`, and a named import is `undefined` there.
    environment: "jsdom",
    environmentMatchGlobs: [
      ["tests/unit/journal.test.ts", "node"],
      ["tests/unit/server.test.ts", "node"],
      // The token suite signs and verifies HMACs. Under jsdom the `node:crypto` namespace carries
      // only `default`, so `createHmac` is `undefined` there — the same shape as the two long-standing
      // jsdom failures, and it needs the same environment, not a workaround.
      ["tests/unit/sidecar-tokens.test.ts", "node"],
      // Starts real servers on real ports, so it needs Node's `fetch` and its network stack. Under
      // jsdom the suite is not even collected — `server/index.ts` fails to load and vitest reports
      // "no tests" rather than a failure, which is a silent green.
      ["tests/unit/server-token-wiring.test.ts", "node"],
      // Mints real tokens, so it needs `node:crypto` exactly as the issuer does.
      ["tests/unit/mint-token.test.ts", "node"],
      // Signs real HMACs *and* drives the handler over HTTP, so it needs both `node:crypto` and a
      // real Node `Request`. Under jsdom every one of its eleven token cases fails with
      // `createHmac is not a function` — a suite that is red for an environment reason teaches
      // nothing about the code.
      ["tests/unit/server-token-auth.test.ts", "node"],
    ],
    include: ["tests/unit/**/*.test.ts"],
    reporters: ["default"],
    restoreMocks: true,
    globals: false,
  },
});
