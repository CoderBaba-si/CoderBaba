export const ErrorCodes = {
  INVALID_CODE: "INVALID_CODE",
  CODE_EXPIRED: "CODE_EXPIRED",
  TOO_MANY_ATTEMPTS: "TOO_MANY_ATTEMPTS",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  TRIAL_EXHAUSTED: "TRIAL_EXHAUSTED",
  TRIAL_TASK_CAPPED: "TRIAL_TASK_CAPPED",
  TRIAL_UNAVAILABLE: "TRIAL_UNAVAILABLE",
  MODEL_NOT_ALLOWED: "MODEL_NOT_ALLOWED",
  RATE_LIMITED: "RATE_LIMITED",
  UNAUTHORIZED: "UNAUTHORIZED",
  BAD_REQUEST: "BAD_REQUEST",
  OFFLINE: "OFFLINE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type ModelId = "fast" | "smart";

export type ModelInfo = {
  id: ModelId;
  label: string;
  openrouterId: string;
  anonAllowed: boolean;
};

/** Curated allowlist. Change ids here to retune the product. */
export const MODELS: readonly ModelInfo[] = [
  {
    id: "fast",
    label: "Fast",
    openrouterId: "qwen/qwen3-coder-next",
    anonAllowed: true,
  },
  {
    id: "smart",
    label: "Smart",
    openrouterId: "anthropic/claude-sonnet-4.5",
    anonAllowed: false,
  },
];

export function findModel(id: string): ModelInfo | undefined {
  const needle = id.trim().toLowerCase();
  return MODELS.find(
    (model) =>
      model.id === needle ||
      model.label.toLowerCase() === needle ||
      model.openrouterId.toLowerCase() === needle,
  );
}

export const DEFAULT_API_URL = "https://coderbaba.si";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ChatRequestBody = {
  taskId: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  maxTokens?: number;
};

export type ErrorResponse = {
  error: {
    code: string;
    message: string;
    resetAt?: string;
  };
};

export type AnonymousResponse = {
  token: string;
  deviceId: string;
  triesLeft: number;
  triesLimit: number;
};

export type VerifyResponse = {
  token: string;
};

export type DailyUsage = {
  usedUsd: number;
  limitUsd: number;
  percentLeft: number;
  resetAt: string;
};

export type UsageResponse =
  | {
      type: "anonymous";
      triesLeft: number;
      triesLimit: number;
      modelLocked: true;
    }
  | {
      type: "user";
      plan: string;
      email?: string;
      daily: DailyUsage;
      monthly: { usedUsd: number; limitUsd: number; resetAt: string };
    };

export function isErrorResponse(value: unknown): value is ErrorResponse {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: { code?: unknown; message?: unknown } }).error;
  return Boolean(error && typeof error.code === "string" && typeof error.message === "string");
}
