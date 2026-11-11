import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, BrowserType } from "playwright-core";
import { runShell } from "./tools.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOAD_TIMEOUT_MS = 15_000;
const TEXT_WAIT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 600_000;
const MAX_MESSAGES = 20;
const MAX_TEXT = 3_000;

export type BrowserKind = "Chrome" | "Edge" | "Chromium";

/** Launches one headless browser per session: installed Chrome or Edge first, then a Chromium that Playwright downloaded. */
export class BrowserSession {
  private browser?: Browser;
  private launching?: Promise<Browser | undefined>;
  kind?: BrowserKind;

  constructor(private readonly loadChromium: () => Promise<BrowserType> = defaultChromium) {}

  async get(): Promise<Browser | undefined> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser | undefined> {
    let chromium: BrowserType;
    try {
      chromium = await this.loadChromium();
    } catch {
      return undefined;
    }
    const attempts: { kind: BrowserKind; channel?: string }[] = [
      { kind: "Chrome", channel: "chrome" },
      { kind: "Edge", channel: "msedge" },
      { kind: "Chromium" },
    ];
    for (const attempt of attempts) {
      try {
        const browser = await chromium.launch({ headless: true, channel: attempt.channel, timeout: 30_000 });
        this.browser = browser;
        this.kind = attempt.kind;
        browser.on("disconnected", () => {
          if (this.browser === browser) this.browser = undefined;
        });
        return browser;
      } catch {
        // try the next one
      }
    }
    return undefined;
  }

  /** Download Playwright's Chromium with the playwright-core version this package uses. */
  async install(onOutput?: (chunk: string) => void): Promise<{ ok: boolean; output: string }> {
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "cli.js");
    const result = await runShell(`node "${cli}" install chromium`, process.cwd(), { timeoutMs: INSTALL_TIMEOUT_MS, onOutput });
    return { ok: result.code === 0 && !result.timedOut, output: result.output };
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }
}

async function defaultChromium(): Promise<BrowserType> {
  const playwright = await import("playwright-core");
  return playwright.chromium;
}

export function isLocalPageUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export type PageCheck = {
  url: string;
  status?: number;
  title: string;
  consoleMessages: string[];
  pageErrors: string[];
  failedRequests: string[];
  text: string;
  waitedFor?: { text: string; found: boolean };
  screenshot?: string;
};

function pushLimited(list: string[], item: string): void {
  if (list.length < MAX_MESSAGES && !list.includes(item)) list.push(item);
}

/** Load a local page headlessly and collect what a person would notice: errors, failed requests, and visible text. */
export async function checkPage(browser: Browser, opts: { url: string; waitForText?: string; screenshotPath?: string }): Promise<PageCheck> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    const type = message.type();
    if (type === "error" || type === "warning") pushLimited(consoleMessages, `${type}: ${message.text()}`);
  });
  page.on("pageerror", (error) => pushLimited(pageErrors, error.message));
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "failed";
    if (reason.includes("ERR_ABORTED")) return;
    pushLimited(failedRequests, `${request.method()} ${request.url()} (${reason})`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) pushLimited(failedRequests, `${response.status()} ${response.request().method()} ${response.url()}`);
  });

  try {
    const started = Date.now();
    const response = await page.goto(opts.url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: Math.max(1_000, LOAD_TIMEOUT_MS - (Date.now() - started)) }).catch(() => undefined);
    let waitedFor: PageCheck["waitedFor"];
    if (opts.waitForText) {
      const found = await page
        .getByText(opts.waitForText)
        .first()
        .waitFor({ timeout: TEXT_WAIT_MS })
        .then(() => true)
        .catch(() => false);
      waitedFor = { text: opts.waitForText, found };
    }
    const title = await page.title().catch(() => "");
    const text = ((await page.innerText("body").catch(() => "")) || "").replace(/\n{3,}/g, "\n\n").trim();
    if (opts.screenshotPath) await page.screenshot({ path: opts.screenshotPath });
    return {
      url: page.url(),
      status: response?.status(),
      title,
      consoleMessages,
      pageErrors,
      failedRequests,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text,
      waitedFor,
      screenshot: opts.screenshotPath,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function problemCount(check: PageCheck): number {
  const consoleErrors = check.consoleMessages.filter((message) => message.startsWith("error:")).length;
  const badStatus = check.status !== undefined && check.status >= 400 ? 1 : 0;
  const missingText = check.waitedFor && !check.waitedFor.found ? 1 : 0;
  return consoleErrors + check.pageErrors.length + check.failedRequests.length + badStatus + missingText;
}

export function describePageCheck(check: PageCheck): string {
  const lines = [`${check.url}${check.status !== undefined ? ` (HTTP ${check.status})` : ""}${check.title ? `, title "${check.title}"` : ""}`];
  if (check.waitedFor) lines.push(check.waitedFor.found ? `Found "${check.waitedFor.text}".` : `Did not find "${check.waitedFor.text}" within ${TEXT_WAIT_MS / 1000}s.`);
  const section = (label: string, items: string[]) => {
    if (items.length) lines.push(`${label}:\n${items.map((item) => `- ${item}`).join("\n")}`);
  };
  section("Uncaught errors", check.pageErrors);
  section("Console errors and warnings", check.consoleMessages);
  section("Failed requests", check.failedRequests);
  if (!check.pageErrors.length && !check.consoleMessages.length && !check.failedRequests.length) lines.push("No console errors, page errors, or failed requests.");
  if (check.screenshot) lines.push(`Screenshot saved to ${check.screenshot}.`);
  lines.push(`Visible text:\n${check.text || "(the page shows no text)"}`);
  return lines.join("\n");
}
