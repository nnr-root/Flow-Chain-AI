// Test fixture: takes the run lock for argv[2], reports "locked", then waits until it is killed.
import { withRunLock } from "../../src/manifest/store.js";

await withRunLock(process.argv[2], async () => {
  process.stdout.write("locked\n");
  await new Promise<never>(() => setInterval(() => {}, 1000));
});
