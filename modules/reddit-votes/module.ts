// Reddit 热榜: collected Reddit posts ordered by their upvotes (server.ts keeps the counts).
import { defineModule } from "@aihot/contracts/modules";

export const REDDIT_HOT_API = "/api/site/reddit-hot";

export const module = defineModule({
  name: "reddit-votes",
  pages: [{ path: "reddit", file: "web/page.tsx" }],
  apiPaths: [/^\/api\/site\/reddit-hot$/],
});

/** 1234 → "1.2k". */
export function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
