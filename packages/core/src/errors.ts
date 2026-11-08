import { ErrorCodes, type ErrorCode } from "@coderbabasi/shared";

export class CoderBabaError extends Error {
  readonly code: string;
  readonly resetAt?: string;

  constructor(code: string, message: string, resetAt?: string) {
    super(message);
    this.name = "CoderBabaError";
    this.code = code;
    this.resetAt = resetAt;
  }
}

const FALLBACK: Record<string, string> = {
  [ErrorCodes.INVALID_CODE]: "That code didn't match, try again",
  [ErrorCodes.CODE_EXPIRED]: "Code expired, sending a new one",
  [ErrorCodes.TOO_MANY_ATTEMPTS]: "Too many tries. Type r to send a new code.",
  [ErrorCodes.QUOTA_EXCEEDED]: "You're out of free usage.",
  [ErrorCodes.TRIAL_EXHAUSTED]: "You've used your 5 free tries. Enter your email to keep going (still free)",
  [ErrorCodes.TRIAL_TASK_CAPPED]: "This free try hit its limit. Log in to continue (free)",
  [ErrorCodes.TRIAL_UNAVAILABLE]: "Free trials are busy right now. Log in to continue (free)",
  [ErrorCodes.MODEL_NOT_ALLOWED]: "That model unlocks after you log in (free). /login",
  [ErrorCodes.RATE_LIMITED]: "Too many requests. Wait a moment and try again.",
  [ErrorCodes.UNAUTHORIZED]: "You're not logged in. Type /login",
  [ErrorCodes.OFFLINE]: "No internet connection. Check your network and try again.",
  [ErrorCodes.BAD_REQUEST]: "That request could not be sent. Try again.",
};

export function friendlyMessage(code: string, serverMessage?: string, resetAt?: string): string {
  if (code === ErrorCodes.QUOTA_EXCEEDED) {
    const when = resetAt ? ` It resets ${resetAt}.` : "";
    return `${serverMessage || FALLBACK[code]}${when}`;
  }
  if (serverMessage && code !== ErrorCodes.INVALID_CODE) return serverMessage;
  return FALLBACK[code] ?? serverMessage ?? "Something went wrong. Try again.";
}

export function isLoginCode(code: string): boolean {
  return code === ErrorCodes.TRIAL_EXHAUSTED || code === ErrorCodes.TRIAL_UNAVAILABLE || code === ErrorCodes.UNAUTHORIZED;
}

export type { ErrorCode };
