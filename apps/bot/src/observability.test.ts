import { afterEach, describe, expect, it, vi } from "vitest";

const originalCaptureMode = process.env.LANGWATCH_CAPTURE_MODE;

vi.mock("langwatch", () => ({
  getLangWatchTracer: vi.fn(() => ({ withActiveSpan: vi.fn() }))
}));

describe("LangWatch capture helpers", () => {
  afterEach(() => {
    if (originalCaptureMode === undefined) {
      delete process.env.LANGWATCH_CAPTURE_MODE;
    } else {
      process.env.LANGWATCH_CAPTURE_MODE = originalCaptureMode;
    }
    vi.resetModules();
  });

  it.each([
    ["none", false, false],
    ["input", true, false],
    ["output", false, true],
    ["all", true, true]
  ] as const)("honors LANGWATCH_CAPTURE_MODE=%s", async (mode, capturesInput, capturesOutput) => {
    process.env.LANGWATCH_CAPTURE_MODE = mode;
    vi.resetModules();

    const { captureTraceInput, captureTraceOutput, shouldCaptureTraceInput, shouldCaptureTraceOutput } =
      await import("./observability.js");
    const span = {
      setInput: vi.fn(),
      setOutput: vi.fn()
    };

    captureTraceInput(span, "json", { text: "student text" });
    captureTraceOutput(span, { reply: "bot reply" });

    expect(shouldCaptureTraceInput()).toBe(capturesInput);
    expect(shouldCaptureTraceOutput()).toBe(capturesOutput);
    expect(span.setInput).toHaveBeenCalledTimes(capturesInput ? 1 : 0);
    expect(span.setOutput).toHaveBeenCalledTimes(capturesOutput ? 1 : 0);
  });

  it("gets the LangWatch tracer lazily instead of during module import", async () => {
    vi.resetModules();
    const langwatch = await import("langwatch");
    const getLangWatchTracer = vi.mocked(langwatch.getLangWatchTracer);

    const { getBotTracer } = await import("./observability.js");

    expect(getLangWatchTracer).not.toHaveBeenCalled();

    getBotTracer();

    expect(getLangWatchTracer).toHaveBeenCalledOnce();
    expect(getLangWatchTracer).toHaveBeenCalledWith("reflection-bot");
  });
});
