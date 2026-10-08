import { notFound } from "next/navigation";
import { Studio } from "@/components/Studio";
import { ApiError } from "@/server/http";
import { logTail } from "@/server/jobs";
import { listKits } from "@/server/library";
import { forUser } from "@/server/page";
import { readRun } from "@/server/runs";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // something that is not this user's does not exist
  const data = await forUser(async () => {
    const run = await readRun(id).catch((err: unknown) => {
      if (err instanceof ApiError && err.code === "not_found") return null;
      throw err;
    });
    return run && { run, log: await logTail(id), kits: await listKits() };
  });
  if (!data) notFound();
  return <Studio initial={data.run} initialLog={data.log} kits={data.kits} />;
}
