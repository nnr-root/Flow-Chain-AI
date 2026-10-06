import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import type { Manifest } from "@src/manifest/schema";
import { draftSceneSvg, silentWav, VIRTUAL } from "@src/studio/draft-media";
import { ApiError } from "./http";
import { type Preview, propsOptions } from "./runs";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".json": "application/json",
};

/** Run files shown outside the Player (thumbnails, the finished video, the chain sheet). */
const EXTRAS = [/^final\.mp4$/, /^chain\.png$/, /^images\/keyframe_\d{2}\.png$/, /^images\/reference\.png$/];

/**
 * The file behind a published path: only what this run's own props publish (so a music file or a bundled font
 * outside the run folder is reachable exactly when the run uses it), plus a short list of run outputs.
 */
export function resolvePublished(runDirPath: string, published: string, preview: Preview | null): string {
  // own properties only: "constructor" or "__proto__" are not published files
  const fromProps = preview && Object.hasOwn(preview.files, published) ? preview.files[published] : undefined;
  if (typeof fromProps === "string" && fromProps) return fromProps;
  if (EXTRAS.some((re) => re.test(published))) return join(runDirPath, published);
  throw new ApiError("not_found", `no file ${published} in this run`);
}

const headers = (type: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "content-type": type,
  // an uploaded SVG is only ever an image here; sandboxing stops it running script if opened directly
  ...(type === "image/svg+xml" ? { "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
  "x-content-type-options": "nosniff",
  ...extra,
});

/** A draft's stand-ins are generated, never stored. */
function virtualFile(source: string, m: Manifest, runId: string, totalSec: number): Response {
  const what = source.slice(VIRTUAL.length);
  if (what === "silence") return new Response(new Uint8Array(silentWav(totalSec)), { headers: headers("audio/wav", { "cache-control": "no-store" }) });
  const scene = /^scene:(\d+)$/.exec(what);
  if (scene && Number(scene[1]) < m.scenes.length) {
    const svg = draftSceneSvg(m, Number(scene[1]), propsOptions(m, runId).size);
    return new Response(svg, { headers: headers("image/svg+xml", { "cache-control": "no-store" }) });
  }
  throw new ApiError("not_found", "no such draft file");
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes; null when it cannot be satisfied. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? null : { start, end };
}

/** Serves one published path, with byte ranges (browsers need them to seek in video and audio). */
export async function serveFile(req: Request, source: string, m: Manifest, runId: string, preview: Preview | null): Promise<Response> {
  if (source.startsWith(VIRTUAL)) {
    const totalSec = preview ? preview.props.totalFrames / preview.props.fps : 1;
    return virtualFile(source, m, runId, totalSec);
  }
  return serveStatic(req, source);
}

/** A file on disk as a response: type by extension, revalidated every time, ranges honoured. */
export async function serveStatic(req: Request, source: string): Promise<Response> {
  let info;
  try {
    info = await stat(source);
  } catch {
    throw new ApiError("not_found", "that file is not there (yet)");
  }
  if (!info.isFile()) throw new ApiError("not_found", "not a file");
  const type = TYPES[extname(source).toLowerCase()] ?? "application/octet-stream";
  const etag = `"${info.size}-${Math.round(info.mtimeMs)}"`;
  // a reroll replaces a file under the same name, so the browser must always revalidate
  const base = headers(type, { "accept-ranges": "bytes", etag, "cache-control": "no-cache" });
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: base });
  const range = parseRange(req.headers.get("range"), info.size);
  if (range === null) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${info.size}` } });
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  const stream = info.size === 0 ? null : (Readable.toWeb(createReadStream(source, { start, end })) as ReadableStream);
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: { ...base, "content-length": String(info.size === 0 ? 0 : end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}) },
  });
}
