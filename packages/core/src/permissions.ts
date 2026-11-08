export type PermissionRequest =
  | { kind: "shell"; command: string; summary: string }
  | { kind: "edit"; path: string; summary: string }
  | { kind: "outside"; path: string; summary: string };

export type PermissionDecision = "allow" | "always" | "deny";

export function permissionKey(request: PermissionRequest): string {
  if (request.kind === "shell") return `shell:${request.command}`;
  if (request.kind === "edit") return "edit:project";
  return `outside:${request.path}`;
}
