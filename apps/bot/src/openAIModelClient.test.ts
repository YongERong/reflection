import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAIModelClient } from "./openAIModelClient.js";

function jsonResponse(content: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("OpenAIModelClient", () => {
  it("requests strict JSON schema responses and parses valid objects", async () => {
    const fetchMock = vi.fn(async (..._args: [RequestInfo | URL, RequestInit?]) =>
      jsonResponse({
        stageComplete: true,
        reply: "That sounds awkward. Who was there with you?",
        tone: "peer_coach",
        reason: "Acknowledged vibe and asked People stage question"
      })
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const client = new OpenAIModelClient("test-key", "test-model", fetchImpl);

    const result = await client.generateJson({
      task: "adaptive_reflection_reply",
      schema: z.object({
        stageComplete: z.boolean(),
        reply: z.string(),
        tone: z.enum(["peer_coach", "gentle", "concise", "safety_redirect"]),
        reason: z.string()
      }),
      fallback: {
        stageComplete: false,
        reply: "fallback",
        tone: "peer_coach" as const,
        reason: "fallback"
      },
      responseContract: {
        type: "object",
        additionalProperties: false,
        required: ["stageComplete", "reply", "tone", "reason"],
        properties: {
          stageComplete: { type: "boolean" },
          reply: { type: "string" },
          tone: { type: "string", enum: ["peer_coach", "gentle", "concise", "safety_redirect"] },
          reason: { type: "string" }
        }
      },
      messages: [{ role: "user", content: "idk" }]
    });

    expect(result.reply).toBe("That sounds awkward. Who was there with you?");
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(requestInit?.body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it("falls back when the model returns the wrong top-level shape", async () => {
    const fetchImpl = vi.fn(async (..._args: [RequestInfo | URL, RequestInit?]) =>
      jsonResponse({ message: "not the expected shape" })
    ) as unknown as typeof fetch;
    const client = new OpenAIModelClient("test-key", "test-model", fetchImpl);

    const result = await client.generateJson({
      task: "safety_classification",
      schema: z.object({
        hasConcern: z.boolean(),
        level: z.enum(["none", "low", "medium", "high", "crisis"])
      }),
      fallback: { hasConcern: false, level: "none" as const },
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result).toEqual({ hasConcern: false, level: "none" });
  });
});
