import type { ModelClient, ModelMessage } from "@reflection/core";
import type { z } from "zod";
import { env } from "./env.js";
import { createModelRouter, type ComparisonModelName, type ModelRouter } from "./modelRouter.js";
import { captureTraceInput, captureTraceOutput, getBotTracer } from "./observability.js";

export class OpenAIModelClient implements ModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly model = env.OPENAI_MODEL,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async generateJson<T>(input: {
    task: string;
    messages: ModelMessage[];
    schema: z.ZodType<T>;
    fallback: T;
    responseContract?: Record<string, unknown>;
  }): Promise<T> {
    return getBotTracer().withActiveSpan(`model.${input.task}`, async (span) => {
      span.setType("llm");
      span.setRequestModel(this.model);
      captureTraceInput(span, "chat_messages", input.messages);
      span.setAttributes({
        "gen_ai.operation.name": input.task,
        "gen_ai.request.model": this.model,
        "reflection.model.task": input.task
      });

      try {
        const response = await this.fetchImpl("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0.2,
            response_format: input.responseContract
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: taskSchemaName(input.task),
                    strict: true,
                    schema: input.responseContract
                  }
                }
              : { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "Return valid compact JSON only. Do not wrap it in Markdown. The response must be one top-level JSON object matching the requested schema exactly."
              },
              ...input.messages
            ]
          })
        });

        if (!response.ok) {
          traceModelFallback(input.task, `OpenAI request failed: ${response.status}`);
          span.setAttributes({
            "reflection.model.status": "fallback",
            "reflection.model.fallback_reason": `OpenAI request failed: ${response.status}`
          });
          captureTraceOutput(span, { status: "fallback", reason: `OpenAI request failed: ${response.status}` });
          return input.fallback;
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          traceModelFallback(input.task, "OpenAI response did not include message content");
          span.setAttributes({
            "reflection.model.status": "fallback",
            "reflection.model.fallback_reason": "missing_content"
          });
          captureTraceOutput(span, { status: "fallback", reason: "missing_content" });
          return input.fallback;
        }

        const parsedJson = JSON.parse(content);
        const parsed = input.schema.safeParse(parsedJson);
        if (!parsed.success) {
          traceModelFallback(input.task, `${parsed.error.message}; raw=${safeRaw(parsedJson)}`);
          span.setAttributes({
            "reflection.model.status": "fallback",
            "reflection.model.fallback_reason": parsed.error.message
          });
          captureTraceOutput(span, { status: "fallback", reason: parsed.error.message, raw: safeRaw(parsedJson) });
          return input.fallback;
        }

        traceModelSuccess(input.task);
        span.setAttribute("reflection.model.status", "ok");
        captureTraceOutput(span, { status: "ok", value: parsed.data });
        return parsed.data;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        traceModelFallback(input.task, reason);
        span.setAttributes({
          "reflection.model.status": "fallback",
          "reflection.model.fallback_reason": reason
        });
        captureTraceOutput(span, {
          status: "fallback",
          reason
        });
        return input.fallback;
      }
    });
  }
}

export function createModelClient(): ModelClient | undefined {
  return env.OPENAI_API_KEY ? new OpenAIModelClient(env.OPENAI_API_KEY) : undefined;
}

export function createComparisonModelRouter(): ModelRouter {
  const clients: Partial<Record<ComparisonModelName, ModelClient>> = env.OPENAI_API_KEY
    ? {
        "gpt-4o-mini": new OpenAIModelClient(env.OPENAI_API_KEY, "gpt-4o-mini"),
        "gpt-5-mini": new OpenAIModelClient(env.OPENAI_API_KEY, "gpt-5-mini")
      }
    : {};

  return createModelRouter(clients);
}

function traceModelSuccess(task: string): void {
  traceLangWatch({ task, status: "ok" });
}

function traceModelFallback(task: string, reason: string): void {
  traceLangWatch({ task, status: "fallback", reason });
}

function traceLangWatch(payload: Record<string, string>): void {
  if (!env.LANGWATCH_API_KEY) return;
  console.log(`[langwatch:${payload.status}] ${payload.task}${payload.reason ? ` - ${payload.reason}` : ""}`);
}

function taskSchemaName(task: string): string {
  return task.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60) || "model_response";
}

function safeRaw(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 800);
  } catch {
    return "[unserializable]";
  }
}
