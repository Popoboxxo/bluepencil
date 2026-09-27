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
    ],
    include: ["tests/unit/**/*.test.ts"],
    reporters: ["default"],
    restoreMocks: true,
    globals: false,
  },
});
