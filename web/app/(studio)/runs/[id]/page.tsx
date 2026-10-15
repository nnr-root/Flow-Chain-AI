import { notFound } from "next/navigation";
import { Studio } from "@/components/Studio";
import { publishingOn } from "@/lib/publishing";
import { ApiError } from "@/server/http";
import { shownLog } from "@/server/jobs";
import { listKits } from "@/server/library";
import { forUser } from "@/server/page";
import { readRun } from "@/server/runs";
import { nativeVoices, offeredLanguages, voiceNames } from "@/server/voices";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // something that is not this user's does not exist
  const data = await forUser(async () => {
    const run = await readRun(id).catch((err: unknown) => {
      if (err instanceof ApiError && err.code === "not_found") return null;
      throw err;
    });
    // what a version in another language may be in, and spoken by (phase 8 spec §4)
    return run && { run, log: await shownLog(id), kits: await listKits(), versions: { languages: offeredLanguages(), voices: nativeVoices(), names: voiceNames() } };
  });
  if (!data) notFound();
  return <Studio initial={data.run} initialLog={data.log} kits={data.kits} publishing={publishingOn()} versions={data.versions} />;
}
