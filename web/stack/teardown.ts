import { execFileSync } from "node:child_process";
import { compose, composeEnv, repo } from "./stack";

export default function teardown(): void {
  if (process.env.STACK_KEEP) return; // leave it up to look at
  // (the database is started by one test under its profile: named here, or it would be left running)
  execFileSync("docker", [...compose, "--profile", "accounts", "down", "-v", "--remove-orphans"], { cwd: repo, env: composeEnv(), stdio: ["ignore", "inherit", "inherit"] });
}
