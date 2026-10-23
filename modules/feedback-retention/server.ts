// Feedback is kept 90 days (site/pages/privacy.md): the daily retention run then erases what the sender
// gave us (text, email, page, screenshot) the way an admin erasure does, keeping the handling record.
import { sql } from "@aihot/backend/db";
import { eraseFeedback } from "@aihot/backend/admin/feedback";
import type { ServerModule } from "@aihot/backend/modules";

export const FEEDBACK_KEEP_DAYS = 90;

async function eraseExpiredFeedback(now: Date): Promise<Record<string, unknown>> {
  const before = new Date(now.getTime() - FEEDBACK_KEEP_DAYS * 86400_000);
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM feedback
    WHERE created_at < ${before} AND (email IS NOT NULL OR page_url IS NOT NULL OR screenshot_key IS NOT NULL OR content <> '（已按要求删除）')
    ORDER BY id`;
  for (const r of rows) await eraseFeedback(Number(r.id), `保存满 ${FEEDBACK_KEEP_DAYS} 天，自动删除`, "retention:feedback");
  return { erasedFeedback: rows.length };
}

export const server: ServerModule = {
  name: "feedback-retention",
  retention: eraseExpiredFeedback,
};
