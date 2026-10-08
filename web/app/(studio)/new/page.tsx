import { PRESETS } from "@src/presets";
import { NewVideoForm } from "@/components/NewVideoForm";
import { studioHealth } from "@/server/jobs";
import { listKits, listMusic } from "@/server/library";
import { forUser } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ topic?: string | string[] }> }) {
  // a topic typed on the landing page comes along in the address: the form starts with it
  const given = (await searchParams).topic;
  const topic = (typeof given === "string" ? given : "").slice(0, 500);
  const presets = Object.values(PRESETS).map((p) => ({ name: p.name, description: p.description, font: p.caption.font.family }));
  const data = await forUser(async () => ({ health: await studioHealth(), kits: await listKits(), tracks: await listMusic() }));
  return <NewVideoForm {...data} presets={presets} topic={topic} />;
}
