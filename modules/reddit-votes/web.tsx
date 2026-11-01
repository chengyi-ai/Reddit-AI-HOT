// Reddit 热榜 in the navigation: the desktop sidebar and the 我的 page.
import { defineWebModule } from "@aihot/web/modules";
import { IconFlame } from "../../apps/web/app/components/icons";

export const web = defineWebModule({
  name: "reddit-votes",
  sidebar: { section: "Reddit", items: [{ to: "/reddit", label: "Reddit 热榜", icon: IconFlame }] },
  tools: [{ to: "/reddit", label: "Reddit 热榜", icon: <IconFlame size={20} /> }],
});
