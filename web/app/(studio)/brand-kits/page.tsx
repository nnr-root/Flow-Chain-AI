import { CAPTION_STYLES } from "@src/media/remotion/styles";
import { KitForm } from "@/components/KitForm";
import { Panel } from "@/components/ui";
import { listKits } from "@/server/library";
import { forUser } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page() {
  const kits = await forUser(listKits);
  return (
    <div className="space-y-10">
      <h1 className="display text-[clamp(2.4rem,1.6rem+3vw,3.4rem)] leading-[0.95]">Brand kits</h1>
      <Panel title="Your kits">
        {kits.length === 0 ? (
          <p className="text-[0.95rem] text-graphite">No kits yet. A kit puts your logo, font and colours on a video, and can fix its characters.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="kits">
            {kits.map((k) => (
              <li key={k.slug}>
                <div className="grid h-24 place-items-center rounded-[2px] bg-stage">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/brand-kits/${k.slug}/logo`} alt={`${k.name} logo`} className="max-h-16 max-w-full" />
                </div>
                <p className="mt-2 text-[0.95rem] font-semibold">{k.name}</p>
                <p className="text-[0.85rem] text-graphite">
                  {[k.hasFont && "font", k.hasCharacters && "characters", k.hasPortrait && "portrait"].filter(Boolean).join(", ") || "logo only"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <KitForm defaultFont={CAPTION_STYLES.hormozi.font} />
    </div>
  );
}
