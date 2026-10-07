import { execFileSync } from "node:child_process";
import { compose, composeEnv, repo } from "./stack";

export default function teardown(): void {
  if (process.env.STACK_KEEP) return; // leave it up to look at
  execFileSync("docker", [...compose, "down", "-v", "--remove-orphans"], { cwd: repo, env: composeEnv(), stdio: ["ignore", "inherit", "inherit"] });
}
