import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "./checkpoints.js";
import type { PermissionRequest } from "./permissions.js";
import { runTool } from "./tools.js";
import { blockedHost, fetchPublicPage, htmlToText, isPrivateAddress, pageSlice, type Lookup } from "./web.js";

const publicLookup: Lookup = async () => ["93.184.216.34"];

function fakeFetch(routes: Record<string, { status?: number; type?: string; body?: string; location?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input.toString();
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const headers = new Headers();
    if (route.type) headers.set("content-type", route.type);
    if (route.location) headers.set("location", route.location);
    return new Response(route.body ?? "", { status: route.status ?? 200, headers });
  }) as typeof fetch;
}

describe("private addresses", () => {
  it("blocks loopback, private, link-local, and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("blocks local names and hosts that resolve to private addresses", async () => {
    expect(await blockedHost("localhost")).toContain("local or private");
    expect(await blockedHost("printer.local")).toContain("local or private");
    expect(await blockedHost("evil.example", async () => ["93.184.216.34", "10.0.0.5"])).toContain("local or private");
    expect(await blockedHost("nextjs.org", publicLookup)).toBeUndefined();
    expect(await blockedHost("[::1]")).toContain("local or private");
  });
});

describe("htmlToText", () => {
  it("keeps the main content, headings, code, lists, and links", () => {
    const html = `<html><head><title>Install | Docs</title><style>.x{}</style></head><body>
      <nav>Home Blog Pricing</nav>
      <main><h1>Installation</h1><p>Run this &amp; wait:</p>
      <pre><code>npx create-next-app@latest
  --yes</code></pre>
      <ul><li>Node 20</li><li>npm</li></ul>
      <p>See <a href="/docs/cli">the CLI page</a> and <code>--ts</code>. ${"Filler text. ".repeat(20)}</p>
      <script>alert(1)</script></main><footer>Copyright</footer></body></html>`;
    const text = htmlToText(html, "https://nextjs.org/docs/install");
    expect(text.startsWith("Install | Docs")).toBe(true);
    expect(text).toContain("# Installation");
    expect(text).toContain("Run this & wait:");
    expect(text).toContain("```\nnpx create-next-app@latest\n  --yes\n```");
    expect(text).toContain("- Node 20");
    expect(text).toContain("the CLI page (https://nextjs.org/docs/cli)");
    expect(text).toContain("`--ts`");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("Home Blog Pricing");
    expect(text).not.toContain("Copyright");
  });
});

describe("fetchPublicPage", () => {
  it("follows redirects but re-checks every host", async () => {
    const fetchImpl = fakeFetch({
      "https://docs.example/a": { status: 301, location: "https://docs.example/b" },
      "https://docs.example/b": { type: "text/html", body: "<h1>Hi</h1>" },
      "https://open.example/go": { status: 302, location: "http://169.254.169.254/latest/meta-data" },
    });
    const page = await fetchPublicPage("https://docs.example/a", { fetchImpl, lookup: publicLookup });
    expect(page.url).toBe("https://docs.example/b");
    expect(page.text).toContain("# Hi");
    await expect(fetchPublicPage("https://open.example/go", { fetchImpl, lookup: publicLookup })).rejects.toThrow(/local or private/);
  });

  it("rejects other protocols, credentials, and binary content, and pretty-prints JSON", async () => {
    await expect(fetchPublicPage("file:///etc/passwd")).rejects.toThrow(/Only http and https/);
    await expect(fetchPublicPage("https://u:p@docs.example/")).rejects.toThrow(/username or password/);
    const fetchImpl = fakeFetch({
      "https://registry.example/next/latest": { type: "application/json", body: '{"version":"16.4.6"}' },
      "https://cdn.example/logo.png": { type: "image/png", body: "x" },
    });
    const json = await fetchPublicPage("https://registry.example/next/latest", { fetchImpl, lookup: publicLookup });
    expect(json.text).toBe('{\n  "version": "16.4.6"\n}');
    await expect(fetchPublicPage("https://cdn.example/logo.png", { fetchImpl, lookup: publicLookup })).rejects.toThrow(/image\/png/);
  });

  it("stops reading at the size limit", async () => {
    const fetchImpl = fakeFetch({ "https://big.example/": { type: "text/plain", body: "a".repeat(5000) } });
    const page = await fetchPublicPage("https://big.example/", { fetchImpl, lookup: publicLookup, maxBytes: 1000 });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(1000);
  });
});

describe("pageSlice", () => {
  it("returns slices with a pointer to the next one", () => {
    const text = "x".repeat(50);
    expect(pageSlice(text, 0, 20)).toBe(`${"x".repeat(20)}\n\n(more: offset 20 of 50)`);
    expect(pageSlice(text, 40, 20)).toBe("x".repeat(10));
  });
});

describe("read_url tool", () => {
  const base = {
    name: "read_url",
    cwd: os.tmpdir(),
    turnId: "t",
    checkpoints: new Checkpoints(path.join(os.tmpdir(), "cb-web-checkpoints")),
  };
  const fetchImpl = fakeFetch({
    "https://nextjs.org/docs": { type: "text/html", body: `<main><h1>Docs</h1><p>${"word ".repeat(6000)}</p></main>` },
    "https://blog.example/post": { type: "text/plain", body: "post body" },
  });

  it("reads docs hosts without asking and pages through long content", async () => {
    const asks: PermissionRequest[] = [];
    const opts = { ...base, allows: new Set<string>(), askPermission: async (request: PermissionRequest) => (asks.push(request), "deny" as const), web: { fetchImpl, lookup: publicLookup } };
    const first = await runTool({ ...opts, args: { url: "https://nextjs.org/docs" } });
    expect(asks).toEqual([]);
    expect(first.content).toContain("# Docs");
    const offset = Number(/\(more: offset (\d+)/.exec(first.content)?.[1]);
    expect(offset).toBeGreaterThan(0);
    const second = await runTool({ ...opts, args: { url: "https://nextjs.org/docs", offset } });
    expect(second.content).not.toContain("# Docs");
    expect(second.event).toMatchObject({ name: "read_url", note: `from ${offset}` });
  });

  it("asks for other hosts and remembers always per host", async () => {
    const asks: PermissionRequest[] = [];
    const allows = new Set<string>();
    const opts = { ...base, allows, askPermission: async (request: PermissionRequest) => (asks.push(request), "always" as const), web: { fetchImpl, lookup: publicLookup } };
    const result = await runTool({ ...opts, args: { url: "https://blog.example/post" } });
    expect(result.content).toContain("post body");
    await runTool({ ...opts, args: { url: "https://blog.example/post" } });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ kind: "url", host: "blog.example" });
    expect(allows.has("read_url:blog.example")).toBe(true);
  });

  it("reports denials and bad URLs", async () => {
    const opts = { ...base, allows: new Set<string>(), askPermission: async () => "deny" as const, web: { fetchImpl, lookup: publicLookup } };
    expect((await runTool({ ...opts, args: { url: "https://blog.example/post" } })).content).toBe("The user denied reading blog.example.");
    expect((await runTool({ ...opts, args: { url: "not a url" } })).content).toContain("is not a valid URL");
  });
});
