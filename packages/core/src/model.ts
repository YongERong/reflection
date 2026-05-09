import { z } from "zod";

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelClient = {
  generateJson<T>(input: {
    task: string;
    messages: ModelMessage[];
    schema: z.ZodType<T>;
    fallback: T;
    responseContract?: Record<string, unknown>;
  }): Promise<T>;
};

export class NoopModelClient implements ModelClient {
  async generateJson<T>(input: { fallback: T }): Promise<T> {
    return input.fallback;
  }
}
