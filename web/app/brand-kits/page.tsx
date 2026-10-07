import { CAPTION_STYLES } from "@src/media/remotion/styles";
import { KitForm } from "@/components/KitForm";
import { Panel } from "@/components/ui";
import { listKits } from "@/server/library";
import { forUser } from "@/server/page";

export const dynamic = "force-dynamic";

export default async function Page() {
  const kits = await forUser(listKits);
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Brand kits</h1>
      <Panel title="Your kits">
        {kits.length === 0 ? (
          <p className="text-sm text-dim">No kits yet. A kit puts your logo, font and colours on a video, and can fix its characters.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="kits">
            {kits.map((k) => (
              <li key={k.slug} className="rounded-lg border border-line p-3">
                <div className="grid h-20 place-items-center rounded bg-black/40">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/brand-kits/${k.slug}/logo`} alt={`${k.name} logo`} className="max-h-16 max-w-full" />
                </div>
                <p className="mt-2 text-sm font-medium">{k.name}</p>
                <p className="text-xs text-dim">
                  {[k.hasFont && "font", k.hasCharacters && "characters", k.hasPortrait && "portrait"].filter(Boolean).join(" · ") || "logo only"}
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
