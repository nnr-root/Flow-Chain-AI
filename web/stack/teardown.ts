import { execFileSync } from "node:child_process";
import { compose, repo } from "./stack";

export default function teardown(): void {
  if (process.env.STACK_KEEP) return; // leave it up to look at
  execFileSync("docker", [...compose, "down", "-v", "--remove-orphans"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
}
