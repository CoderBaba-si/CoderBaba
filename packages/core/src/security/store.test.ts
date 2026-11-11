import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { renderReport, statusTable } from "./report.js";
import { SecurityStore } from "./store.js";
import { securityTools } from "./tools.js";

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-security-"));
});

const finding = {
  title: "Notes API has no auth check",
  severity: "high" as const,
  category: "auth",
  folder: "server",
  file: "server/routes/notes.js",
  line: 12,
  risk: "Anyone can delete any note.",
  fix: "Add requireAuth and check the owner.",
};

describe("SecurityStore", () => {
  it("assigns ids, keeps repeats as one finding, and persists across opens", async () => {
    const store = await SecurityStore.open(root);
    const first = await store.record(finding);
    const second = await store.record({ ...finding, title: "Password stored in plain text", file: "server/models/user.js", line: 3 });
    const repeat = await store.record(finding);
    expect([first.finding.id, second.finding.id]).toEqual(["S1", "S2"]);
    expect(repeat).toMatchObject({ existing: true, finding: { id: "S1" } });

    const reopened = await SecurityStore.open(root);
    expect(reopened.findings().map((item) => item.id)).toEqual(["S1", "S2"]);
    expect(await fs.readFile(path.join(root, ".coderbaba", "security", ".gitignore"), "utf8")).toBe("*\n");
    expect(await fs.readFile(path.join(root, "SECURITY_REPORT.md"), "utf8")).toContain("S1: Notes API has no auth check");
  });

  it("updates status, evidence, and duplicates", async () => {
    const store = await SecurityStore.open(root);
    await store.record(finding);
    await store.record({ ...finding, title: "Notes delete route is public", line: 14 });
    await store.update("s1", { status: "confirmed", evidence: "curl -X DELETE ... -> 200" });
    await store.update("S2", { status: "duplicate", duplicateOf: "S1" });
    expect(store.get("S1")).toMatchObject({ status: "confirmed", evidence: "curl -X DELETE ... -> 200" });
    expect(store.get("S2")).toMatchObject({ status: "duplicate", duplicateOf: "S1" });
    expect(await store.update("S9", { status: "fixed" })).toBeUndefined();
  });

  it("redacts secret values from .env files and the session", async () => {
    await fs.mkdir(path.join(root, "server"));
    await fs.writeFile(path.join(root, "server", ".env"), "MONGODB_URI=mongodb+srv://admin:hunter2pass@db.example.net\n");
    const store = await SecurityStore.open(root, ["sk-session-secret-123"]);
    const { finding: saved } = await store.record({
      ...finding,
      risk: "The URI mongodb+srv://admin:hunter2pass@db.example.net is hardcoded.",
      fix: "Move sk-session-secret-123 to .env.",
    });
    expect(saved.risk).not.toContain("hunter2pass");
    expect(saved.fix).not.toContain("sk-session-secret-123");
    const report = await fs.readFile(path.join(root, "SECURITY_REPORT.md"), "utf8");
    expect(report).not.toContain("hunter2pass");
  });

  it("starts a new scan without losing diff findings or fixed history", async () => {
    const store = await SecurityStore.open(root);
    await store.record(finding);
    await store.record({ ...finding, title: "Fixed one", line: 20 });
    await store.update("S2", { status: "fixed" });
    await store.record({ ...finding, title: "From diff", line: 30, source: "diff" });
    await store.startScan();
    expect(store.findings().map((item) => item.title)).toEqual(["Fixed one", "From diff"]);
    const next = await store.record({ ...finding, title: "New scan finding", line: 40 });
    expect(next.finding.id).toBe("S4");
  });
});

describe("renderReport", () => {
  it("groups by severity, hides duplicates, lists chains and dependencies", async () => {
    const store = await SecurityStore.open(root);
    await store.record({ ...finding, chain: "account takeover" });
    await store.record({ ...finding, title: "Weak JWT secret", severity: "medium", category: "config", line: 2, chain: "account takeover" });
    await store.record({ ...finding, title: "Dup", line: 99 });
    await store.update("S3", { status: "duplicate", duplicateOf: "S1" });
    await store.record({ ...finding, title: "lodash 4.17.20 prototype pollution", category: "dependency", file: undefined, line: undefined });
    await store.saveThreatModel("## Apps\nserver: Express", ["Hosting settings"]);

    const state = JSON.parse(await fs.readFile(path.join(root, ".coderbaba", "security", "findings.json"), "utf8"));
    const report = renderReport(state, store.threatModel());
    expect(report).toContain("3 open findings: 2 high, 1 medium, 0 low.");
    expect(report).toContain("1 duplicate merged");
    expect(report.indexOf("## High")).toBeLessThan(report.indexOf("## Medium"));
    expect(report).not.toContain("### S3");
    expect(report).toContain("- **account takeover:** S1 + S2");
    expect(report).toMatch(/## Dependency audit\n\n### S4: lodash/);
    expect(report).toContain("- Hosting settings");
    expect(report).toContain("## Threat model");
  });

  it("prints a status table without duplicates", async () => {
    const store = await SecurityStore.open(root);
    expect(statusTable(store.findings())).toContain("Type /security");
    await store.record(finding);
    expect(statusTable(store.findings())).toMatch(/^S1\s+high\s+open\s+Notes API has no auth check {2}\(server\/routes\/notes\.js:12\)$/);
  });
});

describe("securityTools", () => {
  it("records, rejects bad input, and updates through the tool interface", async () => {
    const store = await SecurityStore.open(root);
    const tools = securityTools(store, { source: "diff" });
    const bad = await tools.run("record_finding", { title: "x", severity: "critical", risk: "r", fix: "f" });
    expect(bad.event.denied).toBe(true);
    const ok = await tools.run("record_finding", { ...finding, line: "12" });
    expect(ok.content).toBe("Recorded S1 high: Notes API has no auth check (server/routes/notes.js:12).");
    expect(store.get("S1")?.source).toBe("diff");
    const dup = await tools.run("update_finding", { id: "S1", duplicate_of: "S1" });
    expect(dup.content).toBe("Updated S1: duplicate.");
    const missing = await tools.run("update_finding", { id: "S7", status: "fixed" });
    expect(missing).toMatchObject({ content: "There is no finding S7.", event: { denied: true } });
  });
});
