import type { Finding, FindingStatus, SecurityState, Severity } from "./store.js";

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const STATUS_ORDER: Record<FindingStatus, number> = {
  confirmed: 0,
  open: 1,
  needs_review: 2,
  fixed: 3,
  wont_fix: 4,
  false_positive: 5,
  duplicate: 6,
};
const STATUS_LABEL: Record<FindingStatus, string> = {
  open: "open",
  confirmed: "confirmed",
  needs_review: "needs review",
  false_positive: "false positive",
  fixed: "fixed",
  duplicate: "duplicate",
  wont_fix: "won't fix",
};

const ALWAYS_NOT_CHECKED = [
  "Hosting, cloud, and network configuration",
  "Third-party services and their settings",
  "Anything that can't be seen from the code or reproduced on localhost",
];

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.priority ?? 99) - (b.priority ?? 99) ||
      Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
}

export function statusLabel(status: FindingStatus): string {
  return STATUS_LABEL[status];
}

export function location(finding: Finding): string {
  if (!finding.file) return finding.folder ? `${finding.folder}/` : "project";
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function findingBlock(finding: Finding): string {
  const lines = [
    `### ${finding.id}: ${finding.title}`,
    "",
    `**${statusLabel(finding.status)}** · ${finding.category} · \`${location(finding)}\`${finding.source === "diff" ? " · from diff review" : ""}${finding.chain ? ` · chain: ${finding.chain}` : ""}`,
    "",
    `**Risk:** ${finding.risk}`,
    "",
    `**Fix:** ${finding.fix}`,
  ];
  if (finding.evidence) lines.push("", "**Evidence:**", "", quote(finding.evidence));
  return lines.join("\n");
}

export function renderReport(state: SecurityState, threatModel: string): string {
  const visible = sortFindings(state.findings.filter((finding) => finding.status !== "duplicate"));
  const active = visible.filter((finding) => !["fixed", "false_positive", "wont_fix"].includes(finding.status));
  const count = (severity: Severity) => active.filter((finding) => finding.severity === severity).length;
  const duplicates = state.findings.length - visible.length;

  const out = [
    "# Security report",
    "",
    `Written by CoderBaba on ${state.updatedAt.slice(0, 16).replace("T", " ")} UTC. This file lists weaknesses in your app, so don't commit it to a public repository.`,
    "",
    "## Summary",
    "",
    active.length
      ? `${active.length} open finding${active.length === 1 ? "" : "s"}: ${count("high")} high, ${count("medium")} medium, ${count("low")} low.`
      : "No open findings.",
  ];
  const fixed = visible.filter((finding) => finding.status === "fixed").length;
  const falsePositives = visible.filter((finding) => finding.status === "false_positive").length;
  const extras = [
    fixed ? `${fixed} fixed` : "",
    falsePositives ? `${falsePositives} ruled out as false positive${falsePositives === 1 ? "" : "s"}` : "",
    duplicates ? `${duplicates} duplicate${duplicates === 1 ? "" : "s"} merged` : "",
  ].filter(Boolean);
  if (extras.length) out.push("", `Also: ${extras.join(", ")}.`);
  if (active.length) out.push("", "Next: `/security validate` to reproduce findings on localhost, then `/security fix <id>`.");

  const code = visible.filter((finding) => finding.category !== "dependency");
  for (const severity of ["high", "medium", "low"] as const) {
    const group = code.filter((finding) => finding.severity === severity);
    if (!group.length) continue;
    out.push("", `## ${severity[0]!.toUpperCase()}${severity.slice(1)}`, "", group.map(findingBlock).join("\n\n"));
  }

  const chains = new Map<string, Finding[]>();
  for (const finding of visible) {
    if (!finding.chain) continue;
    chains.set(finding.chain, [...(chains.get(finding.chain) ?? []), finding]);
  }
  if (chains.size) {
    out.push("", "## Attack chains", "");
    for (const [label, members] of chains) out.push(`- **${label}:** ${members.map((finding) => finding.id).join(" + ")}`);
  }

  const deps = visible.filter((finding) => finding.category === "dependency");
  out.push("", "## Dependency audit", "");
  out.push(deps.length ? deps.map(findingBlock).join("\n\n") : "No vulnerable dependencies recorded.");

  if (threatModel) out.push("", "## Threat model", "", threatModel);

  out.push("", "## Not checked", "", [...state.notChecked, ...ALWAYS_NOT_CHECKED].map((item) => `- ${item}`).join("\n"));
  out.push("", "This review is automated. It doesn't replace a professional security audit or penetration test.");
  return `${out.join("\n")}\n`;
}

/** Plain-text table for /security status. */
export function statusTable(findings: Finding[]): string {
  const visible = sortFindings(findings.filter((finding) => finding.status !== "duplicate"));
  if (!visible.length) return "No findings yet. Type /security to scan this project.";
  return visible
    .map((finding) => `${finding.id.padEnd(4)} ${finding.severity.padEnd(6)} ${statusLabel(finding.status).padEnd(14)} ${finding.title}  (${location(finding)})`)
    .join("\n");
}
