import { PRESETS } from "@src/presets";
import { NewVideoForm } from "@/components/NewVideoForm";
import { studioHealth } from "@/server/jobs";
import { listKits, listMusic } from "@/server/library";
import { forUser } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page() {
  const presets = Object.values(PRESETS).map((p) => ({ name: p.name, description: p.description, font: p.caption.font.family }));
  const data = await forUser(async () => ({ health: await studioHealth(), kits: await listKits(), tracks: await listMusic() }));
  return <NewVideoForm {...data} presets={presets} />;
}
