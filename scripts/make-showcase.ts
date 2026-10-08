/**
 * npm run make:showcase -- <runId> --slug <name> [--runs <dir>]: publishes a finished run for the landing page
 * (Phase 4 spec §6.1). Free: it reads the run and calls no provider. Writes web/public/showcase/<name>/ with
 * the media made small, `props.json` (what the player is given), `looks.json` (every look a visitor can give
 * it), `receipt.json` (what the run cost, from its ledger) and `poster.jpg`.
 */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { FPS, outputSize } from "../src/config.js";
import { publications, receiptOf, republish, slugOf } from "../src/deploy/showcase.js";
import { looksOf } from "../src/deploy/showcase-looks.js";
import { loadManifest } from "../src/manifest/store.js";
import { ffmpeg } from "../src/media/ffmpeg.js";

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

  const fontsDir = resolve("assets/fonts");
  const sfxDir = resolve("assets/sfx");
  // the video as made, and every look the page lets a visitor give it: all by the studio's own preview function
  const { props, looks, files } = looksOf(manifest, { dir, fontsDir, sfxDir, fps: FPS, size: outputSize(manifest.request.aspect) });
  const out = resolve("web/public/showcase", slug);
  const sharedOut = resolve("web/public/showcase/_shared");
  await rm(out, { recursive: true, force: true });
  const pubs = publications(Object.keys(files));
  // the bundled caption fonts and sound effects are the same for every video: kept once, beside the videos
  const shared = pubs.filter((pub) => [fontsDir, sfxDir].some((d) => files[pub.from].startsWith(d + sep))).map((pub) => pub.to);
  for (const pub of pubs) {
    const from = files[pub.from];
    const to = join(shared.includes(pub.to) ? sharedOut : out, pub.to);
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
  await writeFile(join(out, "looks.json"), `${JSON.stringify({ ...republish(looks, pubs), shared })}\n`);
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
