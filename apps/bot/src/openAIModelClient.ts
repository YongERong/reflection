import type { ModelClient, ModelMessage } from "@reflection/core";
import type { z } from "zod";
import { env } from "./env.js";

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
        await traceModelFallback(input.task, `OpenAI request failed: ${response.status}`);
        return input.fallback;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return input.fallback;

      const parsedJson = JSON.parse(content);
      const parsed = input.schema.safeParse(parsedJson);
      if (!parsed.success) {
        await traceModelFallback(input.task, `${parsed.error.message}; raw=${safeRaw(parsedJson)}`);
        return input.fallback;
      }

      await traceModelSuccess(input.task);
      return parsed.data;
    } catch (error) {
      await traceModelFallback(input.task, error instanceof Error ? error.message : String(error));
      return input.fallback;
    }
  }
}

export function createModelClient(): ModelClient | undefined {
  return env.OPENAI_API_KEY ? new OpenAIModelClient(env.OPENAI_API_KEY) : undefined;
}

async function traceModelSuccess(task: string): Promise<void> {
  await traceLangWatch({ task, status: "ok" });
}

async function traceModelFallback(task: string, reason: string): Promise<void> {
  await traceLangWatch({ task, status: "fallback", reason });
}

async function traceLangWatch(payload: Record<string, string>): Promise<void> {
  if (!env.LANGWATCH_API_KEY) return;
  // Placeholder instrumentation: keep local traces visible without blocking the bot.
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
