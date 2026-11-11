import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, describePageCheck, isLocalPageUrl, problemCount, type PageCheck } from "./browser.js";
import { Checkpoints } from "./checkpoints.js";
import type { PermissionRequest } from "./permissions.js";
import { runTool } from "./tools.js";

describe("isLocalPageUrl", () => {
  it("accepts only local http pages", () => {
    expect(isLocalPageUrl("http://localhost:5173/")).toBe(true);
    expect(isLocalPageUrl("http://127.0.0.1:8000/admin/")).toBe(true);
    expect(isLocalPageUrl("http://[::1]:3000")).toBe(true);
    expect(isLocalPageUrl("https://example.com")).toBe(false);
    expect(isLocalPageUrl("file:///etc/passwd")).toBe(false);
    expect(isLocalPageUrl("http://localhost.evil.com/")).toBe(false);
  });
});

describe("page check report", () => {
  const base: PageCheck = { url: "http://localhost:5173/", status: 200, title: "App", consoleMessages: [], pageErrors: [], failedRequests: [], text: "Hello" };

  it("counts problems and describes a clean page", () => {
    expect(problemCount(base)).toBe(0);
    expect(describePageCheck(base)).toContain("No console errors, page errors, or failed requests.");
  });

  it("counts errors but not warnings", () => {
    const check = { ...base, consoleMessages: ["warning: key prop", "error: boom"], failedRequests: ["500 GET http://localhost:5173/api/notes"], waitedFor: { text: "Notes", found: false } };
    expect(problemCount(check)).toBe(3);
    const text = describePageCheck(check);
    expect(text).toContain('Did not find "Notes"');
    expect(text).toContain("- 500 GET http://localhost:5173/api/notes");
  });
});

describe("check_page tool", () => {
  const cwd = os.tmpdir();
  const base = { name: "check_page", cwd, turnId: "t", checkpoints: new Checkpoints(path.join(cwd, "cb-page-checkpoints")), allows: new Set<string>() };

  it("refuses public pages", async () => {
    const result = await runTool({ ...base, args: { url: "https://example.com" }, askPermission: async () => "allow", browser: new BrowserSession() });
    expect(result.content).toContain("only opens local pages");
  });

  it("asks before downloading a browser and falls back to curl when declined", async () => {
    const asks: PermissionRequest[] = [];
    const none = new BrowserSession(async () => {
      throw new Error("no playwright");
    });
    const result = await runTool({
      ...base,
      args: { url: "http://localhost:5173/" },
      askPermission: async (request) => (asks.push(request), "deny"),
      browser: none,
    });
    expect(asks[0]).toMatchObject({ kind: "download", what: "chromium" });
    expect(result.content).toContain("declined the download");
  });
});

const hasChrome = await (async () => {
  const session = new BrowserSession();
  const browser = await session.get();
  await session.close();
  return Boolean(browser);
})();

describe.skipIf(!hasChrome)("check_page with a real browser", () => {
  let server: http.Server;
  let port = 0;
  const session = new BrowserSession();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/api/notes") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"db down"}');
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Notes</title><h1>My notes</h1>
        <script>fetch('/api/notes'); console.error('React failed to render'); setTimeout(() => { throw new Error('undefined is not a function'); }, 0);</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await session.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it("reports console errors, page errors, failed requests, and text, and saves a screenshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-page-"));
    const result = await runTool({
      name: "check_page",
      args: { url: `http://127.0.0.1:${port}/`, wait_for_text: "My notes", screenshot: true },
      cwd: root,
      turnId: "t",
      checkpoints: new Checkpoints(path.join(root, ".cp")),
      allows: new Set(),
      askPermission: async () => "deny",
      browser: session,
    });
    expect(result.content).toContain('title "Notes"');
    expect(result.content).toContain('Found "My notes"');
    expect(result.content).toContain("error: React failed to render");
    expect(result.content).toContain("undefined is not a function");
    expect(result.content).toContain(`500 GET http://127.0.0.1:${port}/api/notes`);
    expect(result.event).toMatchObject({ name: "check_page", passed: false });
    expect(result.event.path).toMatch(/^\.coderbaba\/screenshots\/.+\.png$/);
    expect((await fs.stat(path.join(root, result.event.path!))).size).toBeGreaterThan(1000);
    expect(await fs.readFile(path.join(root, ".coderbaba", "screenshots", ".gitignore"), "utf8")).toBe("*\n");
  }, 60_000);

  it("explains when the server is not running", async () => {
    const result = await runTool({
      name: "check_page",
      args: { url: "http://127.0.0.1:1/" },
      cwd: os.tmpdir(),
      turnId: "t",
      checkpoints: new Checkpoints(path.join(os.tmpdir(), ".cp2")),
      allows: new Set(),
      askPermission: async () => "deny",
      browser: session,
    });
    expect(result.content).toContain("Is the dev server running?");
  }, 60_000);
});
