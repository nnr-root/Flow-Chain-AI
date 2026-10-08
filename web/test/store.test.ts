import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectStore, storeSettings } from "@/server/store/s3";
import { cleanCache, INDEX, isStored, keys, restoreFolder, storeFolder } from "@/server/store/sync";
import { hasDocker, startStore, type TestStore } from "./minio";

const USER = "11111111-2222-4333-8444-555555555555";
const RUN = "20261007-120000-abc123";

describe("where the studio's bucket is", () => {
  it("is nowhere without STUDIO_BUCKET, R2 by default, and refuses half a configuration", () => {
    expect(storeSettings({})).toBeNull();
    expect(storeSettings({ STUDIO_BUCKET: "studio", R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" })).toEqual({
      endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "studio", accessKeyId: "id", secretAccessKey: "secret",
    });
    // its own keys win over the pipeline's
    expect(storeSettings({ STUDIO_BUCKET: "studio", R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", STUDIO_R2_ACCESS_KEY_ID: "own" })?.accessKeyId).toBe("own");
    expect(() => storeSettings({ STUDIO_BUCKET: "studio" })).toThrow("the R2 account and keys are not");
  });

  it("gives every user a prefix of their own", () => {
    expect(keys.run(USER, RUN)).toBe(`users/${USER}/runs/${RUN}/`);
    expect(keys.brandKits(USER)).toBe(`users/${USER}/brand-kits/`);
    expect(keys.music(USER)).toBe(`users/${USER}/music/`);
  });
});

describe.skipIf(!hasDocker())("store and restore against an S3-compatible store", () => {
  let minio: TestStore;
  let store: ObjectStore;
  let root: string;
  beforeAll(async () => {
    minio = await startStore();
    store = new ObjectStore(minio.settings);
    root = await mkdtemp(join(tmpdir(), "fc-store-"));
  });
  afterAll(() => minio?.stop());

  const folder = async (name: string, files: Record<string, string | Buffer>) => {
    const dir = join(root, name);
    for (const [file, body] of Object.entries(files)) {
      await mkdir(join(dir, file, ".."), { recursive: true });
      await writeFile(join(dir, file), body);
    }
    return dir;
  };

  it("stores a run folder, sends only what changed the next time, and leaves working files behind", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const dir = await folder("a", { "manifest.json": "{}", "final.mp4": big, "images/keyframe_01.png": "png", "render/bundle.js": "work", ".lock": "123", "job.log": "line\n" });
    const prefix = keys.run(USER, RUN);
    expect(await storeFolder(store, dir, prefix)).toBe(4);
    expect((await store.list(prefix)).map((o) => [o.key.slice(prefix.length), o.size]).sort()).toEqual([
      ["final.mp4", big.length], ["images/keyframe_01.png", 3], ["job.log", 5], ["manifest.json", 2],
    ]);
    expect(await isStored(dir)).toBe(true);
    expect(await storeFolder(store, dir, prefix)).toBe(0);

    await writeFile(join(dir, "manifest.json"), '{"changed":true}');
    expect(await isStored(dir)).toBe(false);
    expect(await storeFolder(store, dir, prefix)).toBe(1);
    // another user's prefix holds nothing of this
    expect(await store.list(keys.run("99999999-2222-4333-8444-555555555555", RUN))).toEqual([]);
  });

  it("restores a folder that is gone, byte for byte, and fetches nothing it already has", async () => {
    const big = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
    const dir = await folder("b", { "manifest.json": '{"run":1}', "clips/scene 01.mp4": big });
    const prefix = keys.run(USER, "20261007-120000-abc124");
    await storeFolder(store, dir, prefix);
    await rm(dir, { recursive: true });

    expect(await restoreFolder(store, prefix, dir)).toBe(2);
    expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe('{"run":1}');
    expect((await readFile(join(dir, "clips/scene 01.mp4")).then((b) => b.equals(big)))).toBe(true);
    expect(await restoreFolder(store, prefix, dir)).toBe(0);
    // what came from the bucket is not sent back to it
    expect(await storeFolder(store, dir, prefix)).toBe(0);

    await rm(join(dir, "manifest.json"));
    expect(await restoreFolder(store, prefix, dir)).toBe(1);
  });

  it("never replaces a file that is here: what is on this disk is at least as new as what was stored", async () => {
    const dir = await folder("newer", { "manifest.json": '{"bought":["script"]}', "narration.wav": "voice" });
    const prefix = keys.run(USER, "20261007-120000-abc130");
    await storeFolder(store, dir, prefix);
    // a job ran since (its store failed): the manifest here knows more than the stored one
    await writeFile(join(dir, "manifest.json"), '{"bought":["script","clips"]}');
    await rm(join(dir, "narration.wav"));
    expect(await restoreFolder(store, prefix, dir)).toBe(1);
    expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe('{"bought":["script","clips"]}');
    expect(await readFile(join(dir, "narration.wav"), "utf8")).toBe("voice");
  });

  it("fetches the manifest last, so a restore that is cut off never leaves a folder that looks like a whole run", async () => {
    const dir = await folder("cut", { "manifest.json": "{}", "a-first.wav": "1", "zz-last.mp4": "2" });
    const prefix = keys.run(USER, "20261007-120000-abc131");
    await storeFolder(store, dir, prefix);
    await rm(dir, { recursive: true });
    // the store fails on the last media file
    const flaky = new ObjectStore(minio.settings);
    const real = flaky.getToFile.bind(flaky);
    const order: string[] = [];
    flaky.getToFile = async (key, path) => {
      order.push(key.slice(prefix.length));
      if (key.endsWith("zz-last.mp4")) throw new Error("the connection dropped");
      return real(key, path);
    };
    await expect(restoreFolder(flaky, prefix, dir)).rejects.toThrow("the connection dropped");
    expect(order).toEqual(["a-first.wav", "zz-last.mp4"]);
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
    // tried again, it is finished, and only then is the manifest there
    expect(await restoreFolder(store, prefix, dir)).toBe(2);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });

  it("runs one restore of a folder at a time: a second asker gets the first one's result", async () => {
    const dir = await folder("twice", { "manifest.json": "{}", "final.mp4": Buffer.alloc(500_000, 3) });
    const prefix = keys.run(USER, "20261007-120000-abc132");
    await storeFolder(store, dir, prefix);
    await rm(dir, { recursive: true });
    const [one, two, three] = await Promise.all([restoreFolder(store, prefix, dir), restoreFolder(store, prefix, dir), restoreFolder(store, prefix, dir)]);
    expect([one, two, three]).toEqual([2, 2, 2]);
    expect((await readFile(join(dir, "final.mp4"))).length).toBe(500_000);
  });

  it("stores a file with its type, so a link to it plays instead of downloading", async () => {
    const dir = await folder("typed", { "final.mp4": "v", "manifest.json": "{}" });
    const prefix = keys.run(USER, "20261007-120000-abc133");
    await storeFolder(store, dir, prefix);
    expect((await fetch(await store.link(`${prefix}final.mp4`))).headers.get("content-type")).toBe("video/mp4");
    expect((await fetch(await store.link(`${prefix}manifest.json`))).headers.get("content-type")).toBe("application/json");
  });

  it("never writes outside the folder, whatever the bucket holds", async () => {
    const dir = await folder("c", { "manifest.json": "{}" });
    const prefix = keys.run(USER, "20261007-120000-abc125");
    const evil = await folder("evil", { payload: "x" });
    await store.putFile(`${prefix}../../escaped.txt`, join(evil, "payload"));
    await store.putFile(`${prefix}ok.txt`, join(evil, "payload"));
    expect(await restoreFolder(store, prefix, dir)).toBe(1);
    expect(existsSync(join(dir, "ok.txt"))).toBe(true);
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
  });

  it("links to one stored file for a short time, with range requests (the Player seeks)", async () => {
    const dir = await folder("d", { "final.mp4": "0123456789" });
    const prefix = keys.run(USER, "20261007-120000-abc126");
    await storeFolder(store, dir, prefix);
    const url = await store.link(`${prefix}final.mp4`);
    expect(url).toContain("X-Amz-Expires=300");
    expect(await (await fetch(url)).text()).toBe("0123456789");
    const part = await fetch(url, { headers: { range: "bytes=2-5" } });
    expect([part.status, await part.text()]).toEqual([206, "2345"]);
    // without its signature, or for another file, the link is worth nothing
    expect((await fetch(url.replace(/X-Amz-Signature=[0-9a-f]+/, "X-Amz-Signature=00"))).status).toBe(403);
    expect((await fetch(url.replace("final.mp4", "manifest.json"))).status).toBe(403);
    expect((await fetch(url.split("?")[0])).status).toBe(403);
    const expired = await store.link(`${prefix}final.mp4`, 1);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(expired)).status).toBe(403);
  });

  it("frees disk only of runs that are wholly stored and long untouched", async () => {
    const runs = join(root, "cache");
    const old = new Date(Date.now() - 20 * 86_400_000);
    const make = async (runId: string, opts: { stored: boolean; aged: boolean; locked?: boolean }) => {
      const dir = join(runs, USER, runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.json"), "{}");
      if (opts.locked) await writeFile(join(dir, ".lock"), "1");
      if (opts.aged) await utimes(join(dir, "manifest.json"), old, old);
      if (opts.stored) await storeFolder(store, dir, keys.run(USER, runId));
      if (opts.aged && opts.stored) await utimes(join(dir, INDEX), old, old);
      return dir;
    };
    const gone = await make("20261001-120000-aaaaaa", { stored: true, aged: true });
    const recent = await make("20261001-120000-bbbbbb", { stored: true, aged: false });
    const unstored = await make("20261001-120000-cccccc", { stored: false, aged: true });
    const locked = await make("20261001-120000-dddddd", { stored: true, aged: true, locked: true });
    await mkdir(join(runs, "not-a-user", "20261001-120000-eeeeee"), { recursive: true });

    expect(await cleanCache(runs, 14)).toEqual(["20261001-120000-aaaaaa"]);
    expect([gone, recent, unstored, locked].map((d) => existsSync(d))).toEqual([false, true, true, true]);
    // and it comes back whole
    expect(await restoreFolder(store, keys.run(USER, "20261001-120000-aaaaaa"), gone)).toBe(1);
  });
});
