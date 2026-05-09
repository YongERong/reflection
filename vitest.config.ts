import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      "@reflection/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url))
    }
  }
});
