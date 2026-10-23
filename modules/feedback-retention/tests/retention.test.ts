// Feedback older than 90 days loses what its sender gave (text, email, page, screenshot) in the daily
// retention run, recorded like an admin erasure; newer feedback and the handling record stay.
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { server } from "../server.ts";

const T = tag();
installModules([server]);
after(async () => { await closeDb(); });

test("feedback is erased after 90 days, once, and newer feedback is kept", async () => {
  const dir = path.join(config.dataDir, "feedback-screenshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `old-${T}.png`), "png");
  const [old] = await sql`INSERT INTO feedback (content, email, page_url, screenshot_key, source_hash, status, created_at)
    VALUES (${`旧反馈 ${T}`}, ${`old-${T}@example.com`}, '/all', ${`local:old-${T}.png`}, ${`old:${T}`}, 'resolved', now() - interval '91 days') RETURNING id`;
  const [recent] = await sql`INSERT INTO feedback (content, email, source_hash, created_at)
    VALUES (${`新反馈 ${T}`}, ${`new-${T}@example.com`}, ${`new:${T}`}, now() - interval '89 days') RETURNING id`;

  const first: Record<string, unknown> = await dailyRetention();
  assert.ok(Number(first.erasedFeedback) >= 1);
  const [erased] = await sql`SELECT content, email, page_url, screenshot_key, status FROM feedback WHERE id = ${old!.id}`;
  assert.deepEqual({ ...erased }, { content: "（已按要求删除）", email: null, page_url: null, screenshot_key: null, status: "resolved" });
  assert.equal(existsSync(path.join(dir, `old-${T}.png`)), false);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action = 'feedback.erase' AND subject = ${`feedback:${old!.id}`} AND actor = 'retention:feedback'`).length, 1);
  const [kept] = await sql`SELECT content, email FROM feedback WHERE id = ${recent!.id}`;
  assert.deepEqual({ ...kept }, { content: `新反馈 ${T}`, email: `new-${T}@example.com` });

  await dailyRetention();
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`feedback:${old!.id}`}`).length, 1, "an erased row is not erased again");
});
