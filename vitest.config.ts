import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suites are not homogeneous, and one global environment cannot serve them all.
    //
    // The browser-facing suites (ui, anchor, capture, attach, blueprint, ui-hydration, embed) need
    // jsdom. The Node-facing suites (journal, server, the three token suites, mint-token) need the
    // real Node builtins: under jsdom `os.tmpdir` and `pathToFileURL` are not callable, which fails
    // 14 tests on a clean checkout of main, and `node:crypto` carries only `default`, so
    // `createHmac` is `undefined`.
    //
    // Which suite needs which environment is declared by the suite itself, in a
    // `@vitest-environment node` docblock in its header. This used to be a list here
    // (`environmentMatchGlobs`), which Vitest 5 removed — and the reasons for each entry lived in a
    // second place that could drift from the file. The docblock says it once, where it applies.
    //
    // version.test.ts stays on jsdom: it reads the tree with `node:fs` *and* imports the element
    // build, which extends `HTMLElement`. It reaches `node:fs` through `createRequire` for the
    // same reason embed.test.ts reaches `node:vm` — under jsdom these builtin namespaces carry
    // only `default`, and a named import is `undefined` there.
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
    reporters: ["default"],
    restoreMocks: true,
    // Vitest 5 also clears recorded mock calls before every test (`clearMocks: true` is the new
    // default). That is the safer default and this suite passes with it: nothing here asserts on a
    // call an earlier test recorded.
    globals: false,
  },
});
