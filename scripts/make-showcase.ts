/**
 * npm run make:showcase -- <runId> --slug <name> [--runs <dir>]: publishes a finished run for the landing page
 * (Phase 4 spec §6.1). Free: it reads the run and calls no provider. Writes web/public/showcase/<name>/ with
 * the media made small, `props.json` (what the player is given), `receipt.json` (what the run cost, from its
 * ledger) and `poster.jpg`.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Caption } from "@remotion/captions";
import { FPS, outputSize } from "../src/config.js";
import { publications, receiptOf, republish, slugOf } from "../src/deploy/showcase.js";
import { loadManifest } from "../src/manifest/store.js";
import { ffmpeg } from "../src/media/ffmpeg.js";
import { buildRenderProps } from "../src/stages/build-render-props.js";
import { paths } from "../src/stages/paths.js";

/** The page shows a video about a phone wide: half the render's size is more than it needs. */
const WIDTH = 540;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const runId = argv.find((a, i) => !a.startsWith("--") && !["--slug", "--runs"].includes(argv[i - 1] ?? ""));
  if (!runId) {
    console.error("usage: npm run make:showcase -- <runId> --slug <name> [--runs <dir>]");
    process.exit(2);
  }
  const slug = slugOf(value("--slug"));
  const dir = join(resolve(value("--runs") ?? process.env.RUNS_DIR ?? "runs"), runId);
  const manifest = await loadManifest(dir);
  if (!manifest.final) throw new Error(`run ${runId} is not finished: there is nothing to show yet`);

  const captions = JSON.parse(await readFile(join(dir, paths.captions), "utf8")) as Caption[];
  const { props, files } = buildRenderProps(
    manifest,
    { dir, fontsDir: resolve("assets/fonts"), sfxDir: resolve("assets/sfx"), fps: FPS, size: outputSize(manifest.request.aspect) },
    captions,
  );
  const out = resolve("web/public/showcase", slug);
  await rm(out, { recursive: true, force: true });
  const pubs = publications(Object.keys(files));
  for (const pub of pubs) {
    const from = files[pub.from];
    const to = join(out, pub.to);
    await mkdir(dirname(to), { recursive: true });
    if (pub.how === "video") {
      // no sound track (the narration and music are the player's own), and seekable from the first byte
      await ffmpeg(["-i", from, "-an", "-vf", `scale=${WIDTH}:-2`, "-c:v", "libx264", "-preset", "slow", "-crf", "29", "-pix_fmt", "yuv420p", "-g", String(FPS), "-movflags", "+faststart", to]);
    } else if (pub.how === "picture") {
      // a still is zoomed and panned by the player: it keeps more of its size than a clip
      await ffmpeg(["-i", from, "-vf", `scale=${WIDTH * 1.5}:-2`, "-q:v", "4", to]);
    } else if (pub.how === "narration") {
      await ffmpeg(["-i", from, "-c:a", "libmp3lame", "-b:a", "96k", to]);
    } else await copyFile(from, to);
  }
  // the poster: the finished video a moment after the hook's zoom has landed
  await ffmpeg(["-ss", "1.5", "-i", join(dir, manifest.final.path), "-frames:v", "1", "-vf", `scale=${WIDTH}:-2`, "-q:v", "4", join(out, "poster.jpg")]);

  const receipt = receiptOf(manifest.ledger, manifest.models);
  await writeFile(join(out, "props.json"), `${JSON.stringify(republish(props, pubs))}\n`);
  await writeFile(
    join(out, "receipt.json"),
    `${JSON.stringify({ runId, title: manifest.script?.title ?? "", topic: manifest.request.topic, seconds: Math.round(manifest.final.duration * 10) / 10, scenes: manifest.scenes.length, madeOn: manifest.createdAt.slice(0, 10), ...receipt }, null, 2)}\n`,
  );
  console.log(`${slug}: ${pubs.length} files, $${receipt.totalUsd.toFixed(4)} (${receipt.lines.map((l) => `${l.label.toLowerCase()} $${l.usd.toFixed(4)}`).join(", ")})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
