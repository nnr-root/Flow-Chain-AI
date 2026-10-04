import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { COMPOSITION_ID, RenderProps } from "./props.js";

/** The bundle entry point (registerRoot). Bundled by Remotion's webpack, never imported by Node code. */
export const ENTRY_POINT = resolve(import.meta.dirname, "index.ts");

export type RenderVideoOptions = {
  props: RenderProps;
  /** Published path (relative, as used in props) → absolute source file. */
  files: Record<string, string>;
  /** Working folder for this render: `public/` (staged files) and `bundle/` are recreated inside it. */
  workDir: string;
  /** Output MP4 (video + mixed audio, before the loudness pass). */
  out: string;
  concurrency?: number | null;
  log?: (message: string) => void;
};

/** Hard-links the files into the public folder (copies them when linking is impossible, e.g. across disks). */
async function stage(publicDir: string, files: Record<string, string>): Promise<void> {
  await rm(publicDir, { recursive: true, force: true });
  for (const [rel, src] of Object.entries(files)) {
    const dest = join(publicDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await link(src, dest).catch(() => copyFile(src, dest));
  }
}

export async function renderVideo(opts: RenderVideoOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const inputProps = RenderProps.parse(opts.props);
  const publicDir = join(opts.workDir, "public");
  const outDir = join(opts.workDir, "bundle");
  await stage(publicDir, opts.files);
  await rm(outDir, { recursive: true, force: true });

  log("render: bundling the composition");
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    publicDir,
    outDir,
    enableCaching: true,
    // The codebase imports TypeScript files with ".js" extensions (NodeNext); teach webpack the same.
    webpackOverride: (config) => ({
      ...config,
      resolve: { ...config.resolve, extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
    }),
  });

  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
  let lastLogged = -1;
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: "h264",
    crf: 18,
    pixelFormat: "yuv420p",
    x264Preset: "medium",
    audioCodec: "aac",
    audioBitrate: "192k",
    enforceAudioTrack: true,
    imageFormat: "jpeg",
    jpegQuality: 90,
    concurrency: opts.concurrency ?? null,
    outputLocation: opts.out,
    onProgress: ({ progress }) => {
      const step = Math.floor(progress * 10);
      if (step > lastLogged) {
        lastLogged = step;
        log(`render: ${step * 10}%`);
      }
    },
  });
}

/** Directory of the composition source; its contents are part of the render cache key. */
export const ENGINE_DIR = import.meta.dirname;

let engineHashMemo: string | undefined;

/** sha256 over every file of the composition source (path + content), so editing the engine re-renders. */
export async function engineHash(): Promise<string> {
  if (engineHashMemo) return engineHashMemo;
  const hash = createHash("sha256");
  const entries = (await readdir(ENGINE_DIR, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  for (const file of entries) {
    hash.update(relative(ENGINE_DIR, file));
    hash.update(await readFile(file));
  }
  engineHashMemo = hash.digest("hex");
  return engineHashMemo;
}
