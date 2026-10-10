import { PRESETS } from "@src/presets";
import pictures from "@/content/style-pictures.json";
import type { StyleCard } from "@/components/StylePicker";

/**
 * The styles as the form shows them: each with the picture made in it, where one has been made
 * (`npm run make:styles` writes the pictures and the list of them; a style not on the list is shown by name).
 */
export function styleCards(): StyleCard[] {
  const made = new Set<string>(pictures.styles);
  return Object.values(PRESETS).map((p) => ({ name: p.name, label: p.label, description: p.description, image: made.has(p.name) ? `/styles/${p.name}.jpg` : null }));
}
