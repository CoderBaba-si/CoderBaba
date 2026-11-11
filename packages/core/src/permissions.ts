export type PermissionRequest =
  | { kind: "shell"; command: string; summary: string }
  | { kind: "edit"; path: string; summary: string; config?: boolean }
  | { kind: "outside"; path: string; summary: string }
  | { kind: "url"; host: string; summary: string }
  | { kind: "download"; what: string; summary: string };

export type PermissionDecision = "allow" | "always" | "deny";

/** Edits to CoderBaba's own allow-list files ask every time, even after "always". */
export const CONFIG_EDIT_KEY = "edit:coderbaba-config";

export function permissionKey(request: PermissionRequest): string {
  if (request.kind === "shell") return `shell:${request.command}`;
  if (request.kind === "edit") return request.config ? CONFIG_EDIT_KEY : "edit:project";
  if (request.kind === "url") return `read_url:${request.host}`;
  if (request.kind === "download") return `download:${request.what}`;
  return `outside:${request.path}`;
}
