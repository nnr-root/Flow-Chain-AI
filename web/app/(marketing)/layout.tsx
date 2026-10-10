import { Motion } from "@/components/site/Motion";

/** The pages anyone may read. Their springs follow the visitor's own "reduce motion" setting. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <div data-surface="site"><Motion>{children}</Motion></div>;
}
