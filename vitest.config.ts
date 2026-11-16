import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e-smoke.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "npm:@supabase/supabase-js@2.118.0": resolve(
        __dirname,
        "node_modules/@supabase/supabase-js",
      ),
      "npm:zod@4.6.7": resolve(__dirname, "node_modules/zod"),
    },
  },
});
