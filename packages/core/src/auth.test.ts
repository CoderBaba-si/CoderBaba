import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "@coderbaba/shared";
import { maskEmail, readAuth, saveAuth } from "./auth.js";
import { friendlyMessage } from "./errors.js";

const original = process.env.CODERBABA_HOME;

afterEach(() => {
  if (original === undefined) delete process.env.CODERBABA_HOME;
  else process.env.CODERBABA_HOME = original;
});

describe("auth file", () => {
  it("writes the token with mode 600", async () => {
    process.env.CODERBABA_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "cb-auth-"));
    await saveAuth({ type: "anonymous", deviceId: "dev-1", token: "cb_anon_test" });
    const stat = await fs.stat(path.join(process.env.CODERBABA_HOME, "auth.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await readAuth()).toMatchObject({ type: "anonymous", token: "cb_anon_test" });
  });
});

describe("friendly errors", () => {
  it("maps trial, quota, and code failures", () => {
    expect(friendlyMessage(ErrorCodes.INVALID_CODE)).toBe("That code didn't match, try again");
    expect(friendlyMessage(ErrorCodes.CODE_EXPIRED)).toBe("Code expired, sending a new one");
    expect(friendlyMessage(ErrorCodes.TRIAL_EXHAUSTED)).toContain("5 free tries");
    expect(friendlyMessage(ErrorCodes.QUOTA_EXCEEDED, "You're out of free usage.", "08:00 UTC")).toContain("08:00 UTC");
    expect(friendlyMessage(ErrorCodes.OFFLINE)).toContain("No internet");
  });

  it("masks an email", () => {
    expect(maskEmail("alice@gmail.com")).toBe("a***@gmail.com");
  });
});
