import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
    reporters: ["default"],
    restoreMocks: true,
    globals: false,
  },
});
