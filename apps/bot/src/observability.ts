import type { ObservabilityHandle } from "langwatch/observability/node";
import { setupObservability } from "langwatch/observability/node";
import { getLangWatchTracer } from "langwatch";
import type { LangWatchSpan, LangWatchTracer } from "langwatch/observability";
import { env } from "./env.js";

let observabilityHandle: ObservabilityHandle | undefined;

export function setupBotObservability(): ObservabilityHandle | undefined {
  if (observabilityHandle) return observabilityHandle;

  if (!env.LANGWATCH_API_KEY) {
    return undefined;
  }

  observabilityHandle = setupObservability({
    langwatch: {
      apiKey: env.LANGWATCH_API_KEY,
      endpoint: env.LANGWATCH_ENDPOINT,
      processorType: env.NODE_ENV === "test" ? "simple" : "batch"
    },
    serviceName: "reflection-bot",
    attributes: {
      "service.namespace": "reflection",
      "deployment.environment": env.NODE_ENV ?? "development",
      "langwatch.project_id": env.LANGWATCH_PROJECT_ID ?? "unset"
    },
    dataCapture: env.LANGWATCH_CAPTURE_MODE,
    debug: {
      consoleTracing: env.LANGWATCH_DEBUG === "true",
      logLevel: env.LANGWATCH_DEBUG === "true" ? "debug" : "warn"
    }
  });

  return observabilityHandle;
}

export function getBotTracer(): LangWatchTracer {
  return getLangWatchTracer("reflection-bot");
}

export function shouldCaptureTraceInput(): boolean {
  return env.LANGWATCH_CAPTURE_MODE === "all" || env.LANGWATCH_CAPTURE_MODE === "input";
}

export function shouldCaptureTraceOutput(): boolean {
  return env.LANGWATCH_CAPTURE_MODE === "all" || env.LANGWATCH_CAPTURE_MODE === "output";
}

export function captureTraceInput(
  span: Pick<LangWatchSpan, "setInput">,
  type: "json" | "chat_messages",
  input: unknown
): void {
  if (shouldCaptureTraceInput()) {
    span.setInput(type as never, input as never);
  }
}

export function captureTraceOutput(span: Pick<LangWatchSpan, "setOutput">, output: unknown): void {
  if (shouldCaptureTraceOutput()) {
    span.setOutput("json", output);
  }
}
