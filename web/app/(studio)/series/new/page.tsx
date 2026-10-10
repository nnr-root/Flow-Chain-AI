import { PRESETS } from "@src/presets";
import { NewVideoForm } from "@/components/NewVideoForm";
import { studioHealth } from "@/server/jobs";
import { listKits, listMusic } from "@/server/library";
import { accountsOnly, forUser } from "@/server/page";

export const dynamic = "force-dynamic";

/** Setting up a series: the new-video form's choices, saved instead of spent (phase 6 spec §3). */
export default async function Page() {
  accountsOnly();
  const presets = Object.values(PRESETS).map((p) => ({ name: p.name, label: p.label, description: p.description }));
  const data = await forUser(async () => ({ health: await studioHealth(), kits: await listKits(), tracks: await listMusic() }));
  return <NewVideoForm {...data} presets={presets} series />;
}
