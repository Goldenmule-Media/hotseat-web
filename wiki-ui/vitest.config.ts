import { defineConfig } from "vitest/config";

/** Unit tests live in `lib/`; `bench/` is Playwright's (its `*.bench.spec.ts` files match
 *  vitest's default include, and vitest cannot run them). */
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
