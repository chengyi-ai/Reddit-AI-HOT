// Reddit 热榜: the site's Reddit posts of a window, most upvoted first (server.ts loadRedditHot).
import { Link, useLoaderData } from "react-router";
import { cachedPage, loadOr404 } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import type { Screen } from "@aihot/web/components/shell/screens";
import { PhoneBar } from "../../../apps/web/app/components/shell/PhoneBar";
import { EmptyState } from "../../../apps/web/app/components/ui/Page";
import { REDDIT_HOT_API } from "../module.ts";
import type { RedditHotEntry, RedditWindow } from "../server.ts";

export const handle: Screen = { name: "Reddit 热榜" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

const TABS: Array<{ key: RedditWindow; label: string }> = [
  { key: "day", label: "24 小时" },
  { key: "48h", label: "48 小时" },
  { key: "week", label: "7 天" },
];

export async function loader({ request }: { request: Request }) {
  const asked = new URL(request.url).searchParams.get("window");
  const window = TABS.find((t) => t.key === asked)?.key ?? "day";
  const data = await loadOr404<{ window: RedditWindow; entries: RedditHotEntry[] }>(`${REDDIT_HOT_API}?window=${window}`, { signal: request.signal });
  return cachedPage(60, { data });
}

export function meta() {
  return pageMeta({ title: "Reddit 热榜", description: "本站收录的 Reddit 帖子，按点赞数排序。", path: "/reddit" });
}

/** 1234 → "1.2k". */
function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function Row({ e }: { e: RedditHotEntry }) {
  return (
    <li className="card card-hover relative flex gap-4 px-4 py-3.5">
      <div className="flex w-14 shrink-0 flex-col items-center pt-0.5">
        <span className="num text-[17px] font-bold leading-none text-accent">▲ {compact(e.votes)}</span>
        <span className="mt-1.5 text-[11.5px] text-ink-4">💬 {compact(e.comments)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[12px] text-ink-4">
          <span className="mono font-semibold text-ink-3">{String(e.rank).padStart(2, "0")}</span>
          <span className="truncate">{e.item.source.name}</span>
          {e.item.selected && <span className="shrink-0 text-accent">精选</span>}
        </div>
        <Link to={`/items/${e.item.id}`} className="mt-1 block text-[15.5px] font-semibold leading-snug text-ink after:absolute after:inset-0 after:content-['']">
          {e.item.title}
        </Link>
        {e.item.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-3">{e.item.summary}</p>}
      </div>
    </li>
  );
}

export default function RedditHotPage() {
  const { data } = useLoaderData<typeof loader>();
  const label = TABS.find((t) => t.key === data.window)!.label;
  return (
    <div className="pb-10">
      <PhoneBar title="Reddit 热榜" large sub={`过去 ${label}，按点赞数排序`} />
      <header className="hidden pb-4 pt-1 lg:block">
        <h1 className="text-[24px] font-bold leading-[1.3] tracking-[-0.01em] text-ink lg:text-[26px]">Reddit 热榜</h1>
        <p className="mt-1.5 text-[13.5px] text-ink-3">本站收录的 Reddit 帖子，按点赞数排序。点赞数来自 Arctic Shift 存档，有几小时延迟。</p>
      </header>
      <nav className="mb-4 flex gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.key === "day" ? "/reddit" : `/reddit?window=${t.key}`}
            className={`rounded-full px-3.5 py-1.5 text-[13px] ${t.key === data.window ? "bg-accent text-accent-contrast" : "bg-surface-2 text-ink-3"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {data.entries.length === 0 ? (
        <div className="card rounded-sheet">
          <EmptyState title="还没有点赞数据">每半小时更新一次，稍后再来看。</EmptyState>
        </div>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {data.entries.map((e) => <Row key={e.item.id} e={e} />)}
        </ol>
      )}
    </div>
  );
}
