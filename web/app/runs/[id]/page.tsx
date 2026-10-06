import { notFound } from "next/navigation";
import { Studio } from "@/components/Studio";
import { ApiError } from "@/server/http";
import { logTail } from "@/server/jobs";
import { listKits } from "@/server/library";
import { readRun } from "@/server/runs";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await readRun(id).catch((err: unknown) => {
    if (err instanceof ApiError && err.code === "not_found") notFound();
    throw err;
  });
  return <Studio initial={run} initialLog={await logTail(id)} kits={await listKits()} />;
}
