import { describe, expect, it } from "vitest";
import { createSecretToken, decryptToken, encryptToken, sha256Hex } from "./tokenCrypto.js";

describe("Google token crypto helpers", () => {
  it("encrypts tokens without leaving plaintext in the stored value", () => {
    const encrypted = encryptToken("refresh-token", "local-test-secret");

    expect(encrypted).not.toContain("refresh-token");
    expect(decryptToken(encrypted, "local-test-secret")).toBe("refresh-token");
  });

  it("hashes one-time tokens deterministically", () => {
    expect(sha256Hex("telegram-link-token")).toBe(sha256Hex("telegram-link-token"));
    expect(sha256Hex("telegram-link-token")).not.toBe("telegram-link-token");
  });

  it("creates URL-safe random secret tokens", () => {
    expect(createSecretToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
