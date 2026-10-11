import { NewVideoForm } from "@/components/NewVideoForm";
import { styleCards } from "@/lib/styles";
import { nativeVoices, voiceNames } from "@/server/voices";
import { studioHealth } from "@/server/jobs";
import { listKits, listMusic } from "@/server/library";
import { accountsOnly, forUser } from "@/server/page";

export const dynamic = "force-dynamic";

/** Setting up a series: the new-video form's choices, saved instead of spent (phase 6 spec §3). */
export default async function Page() {
  accountsOnly();
  const presets = styleCards();
  const data = await forUser(async () => ({ health: await studioHealth(), kits: await listKits(), tracks: await listMusic() }));
  return <NewVideoForm {...data} presets={presets} voices={nativeVoices()} voiceNames={voiceNames()} series />;
}
