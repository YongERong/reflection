import { describe, expect, it } from "vitest";
import { parseBotReplySplitRate, parseBotResponseDelay } from "./env.js";

describe("bot environment parsing", () => {
  it("defaults BOT_RESPONSE_DELAY to 5 seconds", () => {
    expect(parseBotResponseDelay(undefined)).toBe(5);
    expect(parseBotResponseDelay("")).toBe(5);
  });

  it("accepts BOT_RESPONSE_DELAY boundaries", () => {
    expect(parseBotResponseDelay("0")).toBe(0);
    expect(parseBotResponseDelay("30")).toBe(30);
  });

  it("rejects BOT_RESPONSE_DELAY outside the supported range", () => {
    expect(() => parseBotResponseDelay("-1")).toThrow("BOT_RESPONSE_DELAY must be between 0 and 30 seconds.");
    expect(() => parseBotResponseDelay("31")).toThrow("BOT_RESPONSE_DELAY must be between 0 and 30 seconds.");
  });

  it("defaults BOT_REPLY_SPLIT_RATE to 0.2", () => {
    expect(parseBotReplySplitRate(undefined)).toBe(0.2);
    expect(parseBotReplySplitRate("")).toBe(0.2);
  });

  it("accepts BOT_REPLY_SPLIT_RATE boundaries", () => {
    expect(parseBotReplySplitRate("0")).toBe(0);
    expect(parseBotReplySplitRate("1")).toBe(1);
    expect(parseBotReplySplitRate("0.35")).toBe(0.35);
  });

  it("rejects BOT_REPLY_SPLIT_RATE outside the supported range", () => {
    expect(() => parseBotReplySplitRate("-0.1")).toThrow("BOT_REPLY_SPLIT_RATE must be between 0 and 1.");
    expect(() => parseBotReplySplitRate("1.1")).toThrow("BOT_REPLY_SPLIT_RATE must be between 0 and 1.");
  });
});
