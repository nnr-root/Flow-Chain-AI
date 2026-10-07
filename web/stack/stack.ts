import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* What the whole-stack test's setup, teardown and spec share. */
export const web = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repo = join(web, "..");
/** The stack's data folder: fixture runs, uploads, Redis's file. Under web/.e2e, so it is git-ignored. */
export const data = join(web, ".e2e/stack");
export const runs = join(data, "runs");
export const PORT = 8088;
/** The stack's public name in the test: not a loopback name, so the host rule is met the way a server meets it. */
export const HOST = "studio.test";
export const USER = "studio";
/** Not a secret: this login protects a throwaway stack on this machine for the length of one test run. */
export const PASSWORD = "stack-test-password";
export const PROJECT = "flowchain-stacktest";
export const compose = ["compose", "-p", PROJECT, "--env-file", join(data, "compose.env"), "-f", join(repo, "deploy/compose.yaml"), "-f", join(repo, "deploy/compose.test.yaml")];

/**
 * The environment every `docker compose` call of the test gets. Compose lets a variable from the shell beat the
 * env file, so a developer's own DATA_DIR or WORKER_ENV_FILE would point the test stack — whose worker clears
 * run locks at start — at real data. None of the stack's settings may come from the shell.
 */
const OWN = ["STUDIO_HOST", "STUDIO_SITE", "STUDIO_USER", "STUDIO_PASSWORD_HASH", "DATA_DIR", "WORKER_ENV_FILE", "WORKER_CONCURRENCY", "STACK_PORT", "PROXY_HTTP_PORT", "PROXY_HTTPS_PORT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"];
export const composeEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !OWN.includes(name))) as NodeJS.ProcessEnv;
