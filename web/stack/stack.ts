import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* What the whole-stack test's setup, teardown and spec share. */
export const web = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repo = join(web, "..");
/** The stack's data folder: fixture runs, uploads, Redis's file. Under web/.e2e, so it is git-ignored. */
export const data = join(web, ".e2e/stack");
export const runs = join(data, "runs");
export const PORT = 8088;
export const USER = "studio";
/** Not a secret: this login protects a throwaway stack on this machine for the length of one test run. */
export const PASSWORD = "stack-test-password";
export const PROJECT = "flowchain-stacktest";
export const compose = ["compose", "-p", PROJECT, "--env-file", join(data, "compose.env"), "-f", join(repo, "deploy/compose.yaml"), "-f", join(repo, "deploy/compose.test.yaml")];
