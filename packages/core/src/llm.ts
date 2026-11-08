import {
  DEFAULT_API_URL,
  findModel,
  isErrorResponse,
  type ChatMessage,
  type ChatRequestBody,
} from "@coderbabasi/shared";
import { CoderBabaError } from "./errors.js";
import { consumeSse } from "./sse.js";

export type LlmResult = {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
};

export interface Llm {
  chat(input: {
    taskId: string;
    model: string;
    messages: ChatMessage[];
    tools: unknown[];
    onText?: (chunk: string) => void;
  }): Promise<LlmResult>;
}

export function apiBaseUrl(): string {
  return (process.env.CODERBABA_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
}

export function usesDirectOpenRouter(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function createLlm(token?: string): Llm {
  if (usesDirectOpenRouter()) return new OpenRouterLlm(process.env.OPENROUTER_API_KEY!);
  return new ProxyLlm(token);
}

class ProxyLlm implements Llm {
  constructor(private readonly token?: string) {}

  async chat(input: Parameters<Llm["chat"]>[0]): Promise<LlmResult> {
    if (!this.token) throw new CoderBabaError("UNAUTHORIZED", "You're not logged in. Type /login");
    const body: ChatRequestBody = {
      taskId: input.taskId,
      model: input.model,
      messages: input.messages,
      tools: input.tools,
    };
    return postChat(`${apiBaseUrl()}/api/chat`, body, { Authorization: `Bearer ${this.token}` }, input.onText);
  }
}

class OpenRouterLlm implements Llm {
  constructor(private readonly apiKey: string) {}

  async chat(input: Parameters<Llm["chat"]>[0]): Promise<LlmResult> {
    const model = findModel(input.model);
    const body = {
      model: model?.openrouterId ?? input.model,
      messages: input.messages,
      tools: input.tools,
      stream: true,
      usage: { include: true },
    };
    return postChat("https://openrouter.ai/api/v1/chat/completions", body, {
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": DEFAULT_API_URL,
      "X-Title": "CoderBaba",
    }, input.onText);
  }
}

async function postChat(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  onText?: (chunk: string) => void,
): Promise<LlmResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CoderBabaError("OFFLINE", "No internet connection. Check your network and try again.");
  }
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.includes("text/event-stream") || !response.body) {
    const payload = await response.json().catch(() => null);
    if (isErrorResponse(payload)) {
      throw new CoderBabaError(payload.error.code, payload.error.message, payload.error.resetAt);
    }
    throw new CoderBabaError("BAD_REQUEST", `The model request failed (${response.status}). Try again.`);
  }
  const parsed = await consumeSse(response.body, onText);
  if (parsed.error) throw new CoderBabaError(parsed.error.code, parsed.error.message, parsed.error.resetAt);
  return { content: parsed.content, toolCalls: parsed.toolCalls, finishReason: parsed.finishReason };
}
