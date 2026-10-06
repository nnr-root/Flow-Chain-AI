import { PRESETS } from "@src/presets";
import { NewVideoForm } from "@/components/NewVideoForm";
import { health } from "@/server/config";
import { listKits, listMusic } from "@/server/library";

export const dynamic = "force-dynamic";

export default async function Page() {
  const presets = Object.values(PRESETS).map((p) => ({ name: p.name, description: p.description, font: p.caption.font.family }));
  return <NewVideoForm health={health()} kits={await listKits()} tracks={await listMusic()} presets={presets} />;
}
