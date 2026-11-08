import { spawnSync } from "node:child_process";

if (!process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN) {
  console.log("NPM_TOKEN is not set; skipping publish.");
  process.exit(0);
}

const result = spawnSync("pnpm", ["exec", "changeset", "publish"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
