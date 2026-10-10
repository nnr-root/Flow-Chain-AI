import { NewVideoForm } from "@/components/NewVideoForm";
import { styleCards } from "@/lib/styles";
import { studioHealth } from "@/server/jobs";
import { listKits, listMusic } from "@/server/library";
import { forUser } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ topic?: string | string[] }> }) {
  // a topic typed on the landing page comes along in the address: the form starts with it
  const given = (await searchParams).topic;
  const topic = (typeof given === "string" ? given : "").slice(0, 500);
  const presets = styleCards();
  const data = await forUser(async () => ({ health: await studioHealth(), kits: await listKits(), tracks: await listMusic() }));
  return <NewVideoForm {...data} presets={presets} topic={topic} />;
}
