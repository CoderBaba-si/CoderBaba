import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isErrorResponse, type AnonymousResponse, type UsageResponse, type VerifyResponse } from "@coderbabasi/shared";
import { CoderBabaError, friendlyMessage } from "./errors.js";
import { apiBaseUrl, usesDirectOpenRouter } from "./llm.js";

export type AuthFile =
  | { type: "anonymous"; deviceId: string; token: string }
  | { type: "user"; token: string; email?: string; deviceId?: string };

export type EnsureAuthResult =
  | { ok: true; auth: AuthFile | null; direct: boolean }
  | { ok: false; needsLogin: true; message: string };

export function dataDir(): string {
  return process.env.CODERBABA_HOME ?? path.join(os.homedir(), ".coderbaba");
}

export function authFilePath(): string {
  return path.join(dataDir(), "auth.json");
}

export async function readAuth(): Promise<AuthFile | null> {
  try {
    const raw = await fs.readFile(authFilePath(), "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    if (!parsed || (parsed.type !== "anonymous" && parsed.type !== "user") || typeof parsed.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveAuth(auth: AuthFile): Promise<void> {
  const file = authFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(auth, null, 2), "utf8");
  await fs.chmod(file, 0o600);
}

export async function clearAuth(): Promise<void> {
  await fs.rm(authFilePath(), { force: true });
}

export function deviceName(): string {
  return `${os.hostname()} · ${os.platform()}`;
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  return `${name.slice(0, 1)}***@${domain}`;
}

export async function ensureAuth(): Promise<EnsureAuthResult> {
  if (usesDirectOpenRouter()) return { ok: true, auth: null, direct: true };
  const existing = await readAuth();
  if (existing) return { ok: true, auth: existing, direct: false };
  const deviceId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/api/auth/anonymous`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
  } catch {
    throw new CoderBabaError("OFFLINE", "No internet connection. Check your network and try again.");
  }
  const payload = (await response.json().catch(() => null)) as AnonymousResponse | null;
  if (!response.ok || !payload || !("token" in payload)) {
    if (isErrorResponse(payload)) {
      return { ok: false, needsLogin: true, message: friendlyMessage(payload.error.code, payload.error.message) };
    }
    return { ok: false, needsLogin: true, message: "Enter your email to keep going (still free)" };
  }
  const auth: AuthFile = { type: "anonymous", deviceId: payload.deviceId || deviceId, token: payload.token };
  await saveAuth(auth);
  return { ok: true, auth, direct: false };
}

export async function startEmailLogin(email: string): Promise<{ masked: string }> {
  const response = await fetch(`${apiBaseUrl()}/api/auth/email/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (isErrorResponse(payload)) throw new CoderBabaError(payload.error.code, friendlyMessage(payload.error.code, payload.error.message));
    throw new CoderBabaError("BAD_REQUEST", "Could not send a code. Try again.");
  }
  const masked = payload && typeof payload === "object" && "masked" in payload ? String(payload.masked) : maskEmail(email);
  return { masked };
}

export async function verifyEmailLogin(email: string, code: string, trialToken?: string): Promise<AuthFile> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (trialToken) headers.authorization = `Bearer ${trialToken}`;
  const response = await fetch(`${apiBaseUrl()}/api/auth/email/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, code, deviceName: deviceName() }),
  });
  const payload = (await response.json().catch(() => null)) as VerifyResponse | null;
  if (!response.ok || !payload || !("token" in payload)) {
    if (isErrorResponse(payload)) throw new CoderBabaError(payload.error.code, friendlyMessage(payload.error.code, payload.error.message));
    throw new CoderBabaError("INVALID_CODE", "That code didn't match, try again");
  }
  const previous = await readAuth();
  const auth: AuthFile = {
    type: "user",
    token: payload.token,
    email,
    deviceId: previous?.type === "anonymous" ? previous.deviceId : undefined,
  };
  await saveAuth(auth);
  return auth;
}

export async function logoutRemote(token: string): Promise<void> {
  await fetch(`${apiBaseUrl()}/api/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => undefined);
  await clearAuth();
}

export async function fetchUsage(token: string): Promise<UsageResponse | null> {
  try {
    const response = await fetch(`${apiBaseUrl()}/api/usage`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as UsageResponse;
  } catch {
    return null;
  }
}
