// Reddit 热榜. Reddit's RSS carries no upvotes and its anonymous JSON is refused, so the counts come from
// the Arctic Shift archive (arctic-shift.photon-reddit.com), which keeps re-reading posts for a while after
// they appear. Every half hour the posts of the last 48 hours are looked up again; older ones keep their
// last counts. When the archive is down the list keeps the counts it has.
import type { FastifyInstance } from "fastify";
import { sql } from "@aihot/backend/db";
import { guardedFetch, requireOk } from "@aihot/backend/lib/http-fetch";
import type { ServerModule } from "@aihot/backend/modules";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "@aihot/backend/publication/items";
import { listedCondition } from "@aihot/backend/publication/scope";
import { REDDIT_HOT_API } from "./module.ts";

/** Posts younger than this are looked up again on every run. */
export const REFRESH_HOURS = 48;
/** Arctic Shift answers up to 500 ids at a time. */
const BATCH = 500;
const LIST_LIMIT = 50;

export const WINDOWS = { day: 24, "48h": 48, week: 168 } as const;
export type RedditWindow = keyof typeof WINDOWS;

export interface PostCounts {
  id: string;
  score: number;
  comments: number;
}

/** The base-36 post id of a Reddit comments page ("…/r/ClaudeAI/comments/1xl69ki/…"), else null. */
export function redditPostId(url: string): string | null {
  return /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]{1,12})(?:\/|$)/i.exec(url)?.[1]?.toLowerCase() ?? null;
}

export async function arcticShiftCounts(ids: string[]): Promise<PostCounts[]> {
  const url = `https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${ids.join(",")}&fields=id,score,num_comments`;
  const res = requireOk(await guardedFetch(url, { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 }), "arctic shift");
  const json = JSON.parse(res.text()) as { data?: Array<{ id?: string; score?: number; num_comments?: number }> };
  return (json.data ?? [])
    .filter((p) => typeof p.id === "string" && Number.isFinite(p.score))
    .map((p) => ({ id: p.id!.toLowerCase(), score: Math.round(p.score!), comments: Math.round(p.num_comments ?? 0) }));
}

/** Looks up the counts of recent Reddit posts and stores them. */
export async function refreshRedditVotes(lookup: (ids: string[]) => Promise<PostCounts[]> = arcticShiftCounts): Promise<Record<string, unknown>> {
  const rows = await sql<{ id: string; url: string }[]>`
    SELECT id, url FROM articles
    WHERE url ~* '^https://(www\\.|old\\.)?reddit\\.com/r/[^/]+/comments/'
      AND coalesce(published_at, discovered_at) > now() - make_interval(hours => ${REFRESH_HOURS})`;
  const byPost = new Map<string, string[]>();
  for (const r of rows) {
    const post = redditPostId(r.url);
    if (post) byPost.set(post, [...(byPost.get(post) ?? []), r.id]);
  }
  const posts = [...byPost.keys()];
  let found = 0;
  for (let i = 0; i < posts.length; i += BATCH) {
    for (const c of await lookup(posts.slice(i, i + BATCH))) {
      for (const articleId of byPost.get(c.id) ?? []) {
        await sql`
          INSERT INTO reddit_votes (article_id, post_id, score, comments, checked_at)
          VALUES (${articleId}, ${c.id}, ${c.score}, ${c.comments}, now())
          ON CONFLICT (article_id) DO UPDATE SET score = EXCLUDED.score, comments = EXCLUDED.comments, checked_at = now()`;
        found += 1;
      }
    }
  }
  return { posts: posts.length, updated: found };
}

export interface RedditHotEntry {
  rank: number;
  votes: number;
  comments: number;
  item: ReturnType<typeof toFeedItemSummary>;
}

/** Listed Reddit posts of the window, most upvoted first. */
export async function loadRedditHot(window: RedditWindow, now = new Date()): Promise<{ window: RedditWindow; entries: RedditHotEntry[] }> {
  const rows = await sql<Array<ItemRow & { votes: number; vote_comments: number }>>`
    SELECT ${ITEM_COLUMNS}, rv.score AS votes, rv.comments AS vote_comments
    ${ITEM_FROM}
    JOIN reddit_votes rv ON rv.article_id = p.article_id
    WHERE ${listedCondition(now)}
      AND coalesce(p.published_at, p.discovered_at) > ${now}::timestamptz - make_interval(hours => ${WINDOWS[window]})
    ORDER BY rv.score DESC, p.article_id
    LIMIT ${LIST_LIMIT}`;
  return { window, entries: rows.map((r, i) => ({ rank: i + 1, votes: Number(r.votes), comments: Number(r.vote_comments), item: toFeedItemSummary(r) })) };
}

function http(app: FastifyInstance) {
  app.get(REDDIT_HOT_API, async (req, reply) => {
    const asked = (req.query as { window?: string }).window ?? "day";
    const window: RedditWindow = asked in WINDOWS ? (asked as RedditWindow) : "day";
    return reply.header("Cache-Control", "public, max-age=60, s-maxage=60").send(await loadRedditHot(window));
  });
}

/** Counts of articles that are gone. */
async function dropOrphans(): Promise<Record<string, unknown>> {
  const gone = await sql`DELETE FROM reddit_votes rv WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.id = rv.article_id)`;
  return { redditVotesDropped: gone.count };
}

export const server: ServerModule = {
  name: "reddit-votes",
  http,
  schedules: [{ name: "reddit.votes", cron: "10,40 * * * *", run: () => refreshRedditVotes() }],
  retention: dropOrphans,
};
