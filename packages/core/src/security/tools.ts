import type { ExtraTools } from "../agent.js";
import type { ToolEvent } from "../tools.js";
import { FINDING_STATUSES, SEVERITIES, type Finding, type FindingStatus, type SecurityStore, type Severity } from "./store.js";

export const SECURITY_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "save_threat_model",
      description:
        "Save the project's threat model: app folders, entry points and routes, how auth works, data stores, secret names (never values), and trust boundaries. Replaces the previous one.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Markdown, under 80 lines." },
          not_checked: { type: "array", items: { type: "string" }, description: "Things you can't see from the code, such as hosting settings." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "record_finding",
      description:
        "Record one security finding you verified by reading the code. Only record real issues an attacker could reach; skip style nits. Never include secret values.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short, such as 'Notes API has no auth check'." },
          severity: { type: "string", enum: [...SEVERITIES] },
          category: {
            type: "string",
            description: "injection, auth, access-control, secrets, config, xss, ssrf, crypto, validation, dependency, or other.",
          },
          folder: { type: "string", description: "App folder relative to the project, such as server. Empty for the root." },
          file: { type: "string", description: "File relative to the project." },
          line: { type: "number" },
          risk: { type: "string", description: "What an attacker could do, in plain words." },
          fix: { type: "string", description: "The concrete change that fixes it." },
          chain: { type: "string", description: "Optional label shared with other findings that combine into one attack." },
        },
        required: ["title", "severity", "category", "risk", "fix"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_finding",
      description:
        "Update a recorded finding: its status after validating or fixing it, evidence (the command you ran and a short response excerpt), severity, duplicate_of, chain, or priority.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Finding id, such as S3." },
          status: { type: "string", enum: [...FINDING_STATUSES] },
          severity: { type: "string", enum: [...SEVERITIES] },
          evidence: { type: "string" },
          duplicate_of: { type: "string", description: "Id of the finding this one repeats. Also set status duplicate." },
          chain: { type: "string" },
          priority: { type: "number", description: "1 is the most urgent." },
        },
        required: ["id"],
      },
    },
  },
];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function describeFinding(finding: Finding): string {
  const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
  return `${finding.id} ${finding.severity}: ${finding.title}${where}`;
}

export type SecurityToolOptions = {
  source?: Finding["source"];
  /** Called after every change so the caller can refresh what the user sees. */
  onChange?: () => void;
};

export function securityTools(store: SecurityStore, opts: SecurityToolOptions = {}): ExtraTools {
  const done = (content: string, event: ToolEvent) => {
    opts.onChange?.();
    return { content, event };
  };
  return {
    definitions: SECURITY_TOOL_DEFINITIONS,
    async run(name, args) {
      if (name === "save_threat_model") {
        const text = str(args.text);
        if (!text) return { content: "text is required.", event: { name, denied: true } };
        const notChecked = Array.isArray(args.not_checked) ? args.not_checked.filter((item): item is string => typeof item === "string") : [];
        await store.saveThreatModel(text, notChecked);
        return done("Threat model saved.", { name, note: "threat model saved" });
      }
      if (name === "record_finding") {
        const title = str(args.title);
        const severity = oneOf<Severity>(args.severity, SEVERITIES);
        const risk = str(args.risk);
        const fix = str(args.fix);
        if (!title || !severity || !risk || !fix) {
          return { content: "title, severity (high, medium, or low), risk, and fix are required.", event: { name, denied: true } };
        }
        const { finding, existing } = await store.record({
          title,
          severity,
          category: str(args.category) ?? "other",
          folder: str(args.folder)?.replace(/\/+$/, "") ?? "",
          file: str(args.file),
          line: num(args.line),
          risk,
          fix,
          chain: str(args.chain),
          source: opts.source,
        });
        if (existing) return { content: `Already recorded as ${finding.id}.`, event: { name, note: `already ${finding.id}` } };
        return done(`Recorded ${describeFinding(finding)}.`, { name, note: describeFinding(finding) });
      }
      if (name === "update_finding") {
        const id = str(args.id);
        if (!id) return { content: "id is required.", event: { name, denied: true } };
        const status = oneOf<FindingStatus>(args.status, FINDING_STATUSES);
        const duplicateOf = str(args.duplicate_of);
        const finding = await store.update(id, {
          status: status ?? (duplicateOf ? "duplicate" : undefined),
          severity: oneOf<Severity>(args.severity, SEVERITIES),
          evidence: str(args.evidence),
          duplicateOf,
          chain: str(args.chain),
          priority: num(args.priority),
        });
        if (!finding) return { content: `There is no finding ${id}.`, event: { name, denied: true } };
        return done(`Updated ${finding.id}: ${finding.status}.`, { name, note: `${finding.id} ${finding.status.replace("_", " ")}` });
      }
      return { content: `Unknown tool ${name}`, event: { name, denied: true } };
    },
  };
}
