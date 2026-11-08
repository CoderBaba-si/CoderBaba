export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) yield data;
    }
  }
}

export type ParsedStream = {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; costUsd: number };
  error?: { code: string; message: string; resetAt?: string };
};

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onText?: (chunk: string) => void,
): Promise<ParsedStream> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let content = "";
  let finishReason = "stop";
  let usage: ParsedStream["usage"];
  for await (const data of readSse(body)) {
    if (data === "[DONE]") break;
    let json: {
      error?: { code?: string; message?: string; resetAt?: string };
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    try {
      json = JSON.parse(data) as typeof json;
    } catch {
      continue;
    }
    if (json.error?.message) {
      return {
        content,
        toolCalls: [],
        finishReason: "error",
        error: { code: json.error.code ?? "BAD_REQUEST", message: json.error.message, resetAt: json.error.resetAt },
      };
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(index, current);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (json.usage) {
      usage = {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        costUsd: json.usage.cost ?? 0,
      };
    }
  }
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call);
  return { content, toolCalls, finishReason, usage };
}
