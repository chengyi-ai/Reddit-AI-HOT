// Reddit 热榜: counts are stored for recent Reddit posts by their post id, and the list shows listed posts
// of the window, most upvoted first.
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadRedditHot, redditPostId, refreshRedditVotes, server, type PostCounts } from "../server.ts";

const T = tag();
const SOURCE = `reddit-test-${T}`;
installModules([server]);
after(async () => { await closeDb(); });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at)
    VALUES (${SOURCE}, 'r/Test', 'rss', 'T2', 'editorial', ${sql.json({ feedUrl: "https://www.reddit.com/r/Test/top/.rss" })}, '2100-01-01')`;
});

/** A published Reddit post with post id `post`, `hours` old. */
async function post(post: string, hours: number): Promise<string> {
  const id = `${T}-${post}`;
  const at = new Date(Date.now() - hours * 3600_000);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://www.reddit.com/r/Test/comments/${post}/some_title/`}, ${`Post ${post}`}, ${at}, ${at}, ${at})`;
  const [a] = await sql`SELECT revision FROM articles WHERE id = ${id}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${id}, ${a!.revision}, 'rule', 'pass', 'tool', ${`帖子 ${post}`}, '一条帖子。', 70, false, ${sql.json({ scope: "single" })})`;
  await publishArticle(id);
  return id;
}

test("post ids come from Reddit comment pages only", () => {
  assert.equal(redditPostId("https://www.reddit.com/r/ClaudeAI/comments/1XL69KI/title/"), "1xl69ki");
  assert.equal(redditPostId("https://old.reddit.com/r/x/comments/abc12"), "abc12");
  assert.equal(redditPostId("https://www.reddit.com/r/ClaudeAI/"), null);
  assert.equal(redditPostId("https://example.org/r/x/comments/abc12/"), null);
});

test("recent posts get their counts; the list orders listed posts of the window by upvotes", async () => {
  const a = `a${T}`.slice(0, 12), b = `b${T}`.slice(0, 12), old = `c${T}`.slice(0, 12);
  const idA = await post(a, 2);
  const idB = await post(b, 5);
  const idOld = await post(old, 72);

  const asked: string[][] = [];
  const counts: Record<string, PostCounts> = { [a]: { id: a, score: 120, comments: 8 }, [b]: { id: b, score: 4471, comments: 89 }, [old]: { id: old, score: 9000, comments: 1 } };
  const lookup = async (ids: string[]) => { asked.push(ids); return ids.flatMap((id) => (counts[id] ? [counts[id]!] : [])); };
  await refreshRedditVotes(lookup);

  // Posts older than 48 hours are not looked up again.
  assert.ok(asked.flat().includes(a) && asked.flat().includes(b));
  assert.ok(!asked.flat().includes(old));
  const stored = await sql`SELECT article_id, score, comments FROM reddit_votes WHERE article_id IN ${sql([idA, idB, idOld])} ORDER BY article_id`;
  assert.deepEqual(stored.map((r) => [r.article_id, r.score, r.comments]), [[idA, 120, 8], [idB, 4471, 89]]);

  // Counts move with the next run.
  counts[a] = { id: a, score: 5000, comments: 300 };
  await refreshRedditVotes(lookup);
  const day = (await loadRedditHot("day")).entries.filter((e) => e.item.id.startsWith(T));
  assert.deepEqual(day.map((e) => [e.item.id, e.votes, e.comments]), [[idA, 5000, 300], [idB, 4471, 89]]);
  assert.equal(day[0]!.item.title, `帖子 ${a}`);

  // A withdrawn post leaves the list.
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${idA}`;
  const after = (await loadRedditHot("day")).entries.filter((e) => e.item.id.startsWith(T));
  assert.deepEqual(after.map((e) => e.item.id), [idB]);
});
