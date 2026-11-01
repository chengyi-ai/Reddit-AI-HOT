// Reddit 热榜: collected Reddit posts ordered by their upvotes (server.ts keeps the counts).
import { defineModule } from "@aihot/contracts/modules";

export const REDDIT_HOT_API = "/api/site/reddit-hot";

export const module = defineModule({
  name: "reddit-votes",
  pages: [{ path: "reddit", file: "web/page.tsx" }],
  apiPaths: [/^\/api\/site\/reddit-hot$/],
});
