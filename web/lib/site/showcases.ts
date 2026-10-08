import type { Making, Receipt } from "@src/deploy/showcase";
import type { Looks } from "@src/deploy/showcase-looks";
import type { RenderProps } from "@src/media/remotion/props";
import clockmakerLooks from "@/public/showcase/clockmaker/looks.json";
import clockmakerMaking from "@/public/showcase/clockmaker/making.json";
import clockmakerProps from "@/public/showcase/clockmaker/props.json";
import clockmakerReceipt from "@/public/showcase/clockmaker/receipt.json";
import productLooks from "@/public/showcase/product-photos/looks.json";
import productMaking from "@/public/showcase/product-photos/making.json";
import productProps from "@/public/showcase/product-photos/props.json";
import productReceipt from "@/public/showcase/product-photos/receipt.json";
import robotLooks from "@/public/showcase/robot-painter/looks.json";
import robotMaking from "@/public/showcase/robot-painter/making.json";
import robotProps from "@/public/showcase/robot-painter/props.json";
import robotReceipt from "@/public/showcase/robot-painter/receipt.json";

/*
 * The videos the landing page shows: real runs, published by `npm run make:showcase` into public/showcase/.
 * To add one, run that command and list it here. (The files are JSON written by the command and checked by
 * web/test/showcase.test.ts against the player's own schema, which is why they are taken at their word here.)
 */
export type ShowcaseReceipt = Receipt & { runId: string; title: string; topic: string; seconds: number; scenes: number; madeOn: string };
export type Showcase = {
  slug: string;
  props: RenderProps;
  looks: Looks & { shared: string[] };
  receipt: ShowcaseReceipt;
  making: Making;
};

const showcase = (slug: string, props: unknown, looks: unknown, receipt: unknown, making: unknown): Showcase => ({
  slug, props: props as RenderProps, looks: looks as Showcase["looks"], receipt: receipt as ShowcaseReceipt, making: making as Making,
});

/** The event a part of the page sends to have the hero's Stage play one of the videos (its slug as detail). */
export const SHOW_EVENT = "flowchain:show";

/** In the order the page offers them; the first is the one a visitor meets. */
export const SHOWCASES: Showcase[] = [
  showcase("clockmaker", clockmakerProps, clockmakerLooks, clockmakerReceipt, clockmakerMaking),
  showcase("product-photos", productProps, productLooks, productReceipt, productMaking),
  showcase("robot-painter", robotProps, robotLooks, robotReceipt, robotMaking),
];
