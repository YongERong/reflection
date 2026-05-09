import { describe, expect, it } from "vitest";
import { defaultPromptConfig } from "./config.js";

describe("prompt config defaults", () => {
  it("keeps the fallback config id as the storage sentinel", () => {
    expect(defaultPromptConfig.id).toBe("default");
  });
});
