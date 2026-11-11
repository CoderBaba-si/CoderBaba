import dns from "node:dns/promises";
import net from "node:net";

/** Documentation hosts read_url may fetch without asking. */
export const DOCS_HOSTS = new Set([
  "nextjs.org",
  "react.dev",
  "vite.dev",
  "docs.djangoproject.com",
  "www.django-rest-framework.org",
  "django-rest-framework.org",
  "developer.mozilla.org",
  "nodejs.org",
  "expressjs.com",
  "mongoosejs.com",
  "tailwindcss.com",
  "docs.python.org",
  "pypi.org",
  "registry.npmjs.org",
  "www.npmjs.com",
  "raw.githubusercontent.com",
  "docs.astral.sh",
  "github.com",
]);

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_CHARS = 20_000;

export type Lookup = (hostname: string) => Promise<string[]>;

const defaultLookup: Lookup = async (hostname) => (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Loopback, private, link-local, carrier-grade NAT, multicast, and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]!);
  if (lower === "::" || lower === "::1") return true;
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

/** Why a host may not be fetched, or undefined when it is a public address. */
export async function blockedHost(hostname: string, lookup: Lookup = defaultLookup): Promise<string | undefined> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = "is a local or private address; check local pages with curl or check_page";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return `${host} ${local}`;
  if (net.isIP(host)) return isPrivateAddress(host) ? `${host} ${local}` : undefined;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return `${host} could not be found`;
  }
  if (!addresses.length) return `${host} could not be found`;
  return addresses.some(isPrivateAddress) ? `${host} ${local}` : undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]!.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""));
}

/** Readable text from HTML: main content when marked, headings, lists, code blocks, and links kept. */
export function htmlToText(html: string, baseUrl?: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/i, "");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body) ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body);
  if (main && stripTags(main[1]!).trim().length > 200) body = main[1]!;
  else body = body.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "");

  const blocks: string[] = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    blocks.push(stripTags(inner.replace(/<br\s*\/?>/gi, "\n")).replace(/^\n+|\s+$/g, ""));
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });
  body = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${stripTags(inner).trim()}\n`)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const text = stripTags(inner).trim();
      if (!text) return "";
      if (href.startsWith("#") || href.startsWith("javascript:")) return text;
      let target = href;
      try {
        target = new URL(decodeEntities(href), baseUrl).toString();
      } catch {
        return text;
      }
      return target === text ? text : `${text} (${target})`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => `\`${stripTags(inner)}\``)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|dd|dt|header)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ");
  let text = stripTags(body)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `\`\`\`\n${blocks[Number(index)]}\n\`\`\``);
  const heading = title ? `${stripTags(title).trim()}\n\n` : "";
  return `${heading}${text}`;
}

export type FetchedPage = { url: string; status: number; contentType: string; text: string; truncated: boolean };

export type FetchOptions = { fetchImpl?: typeof fetch; lookup?: Lookup; timeoutMs?: number; maxBytes?: number };

async function readLimited(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** Fetch a public page, re-checking the host on every redirect. Throws with a readable message. */
export async function fetchPublicPage(input: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${input} is not a valid URL.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http and https URLs can be read, not ${url.protocol}`);
      if (url.username || url.password) throw new Error("URLs with a username or password can't be read.");
      const blocked = await blockedHost(url.hostname, opts.lookup);
      if (blocked) throw new Error(`Can't read ${url.toString()}: ${blocked}.`);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "CoderBaba (+https://coderbaba.si)", accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
        });
      } catch {
        throw new Error(controller.signal.aborted ? `Reading ${url.toString()} timed out.` : `Could not reach ${url.hostname}.`);
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
        url = new URL(response.headers.get("location")!, url);
        continue;
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const { text: raw, truncated } = await readLimited(response, opts.maxBytes ?? MAX_BYTES);
      let text: string;
      if (contentType.includes("html") || (!contentType && /^\s*<(!doctype|html)/i.test(raw))) text = htmlToText(raw, url.toString());
      else if (contentType.includes("json")) {
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
      } else if (!contentType || contentType.startsWith("text/") || contentType.includes("xml") || contentType.includes("javascript")) text = raw;
      else throw new Error(`${url.toString()} is ${contentType}, which read_url can't show.`);
      return { url: url.toString(), status: response.status, contentType, text, truncated };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** One slice of a page, with a pointer to the next slice. */
export function pageSlice(text: string, offset = 0, size = PAGE_CHARS): string {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  const end = Math.min(text.length, start + size);
  const slice = text.slice(start, end);
  return end < text.length ? `${slice}\n\n(more: offset ${end} of ${text.length})` : slice;
}

export function isDocsHost(hostname: string): boolean {
  return DOCS_HOSTS.has(hostname.toLowerCase());
}
