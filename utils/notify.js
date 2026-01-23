// utils/notify.js
import { db } from "../db.js";

function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

export async function createNotification({
  uniqKey,
  toUsername,
  toRole,
  type = "REQUEST_STATUS",
  title = "Notification",
  message = "",
  requestId = null,
  meta = {},
}) {
  const now = new Date();

  const doc = {
    uniqKey: uniqKey || null,
    toUsername: toUsername ? normalizeUsername(toUsername) : null,
    toRole: toRole || null,
    type,
    title,
    message,
    requestId: requestId ? String(requestId) : null,
    meta,
    createdAt: now,
    read: false,
  };

  // ✅ idempotent if uniqKey exists (prevents duplicate spam)
  if (doc.uniqKey) {
    await db
      .collection("notifications")
      .updateOne(
        { uniqKey: doc.uniqKey },
        { $setOnInsert: doc },
        { upsert: true },
      );
    return;
  }

  await db.collection("notifications").insertOne(doc);
}
