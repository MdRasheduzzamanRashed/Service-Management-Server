// utils/notify.js
import { db } from "../db.js";

// OPTIONAL: if you want realtime socket push, uncomment next line and implement getIO
// import { getIO } from "../socket.js";

function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function normalizeRole(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const upper = s.toUpperCase().replace(/\s+/g, "_");
  const noUnderscore = upper.replace(/_/g, "");
  const map = {
    PROJECTMANAGER: "PROJECT_MANAGER",
    PROJECT_MANAGER: "PROJECT_MANAGER",
    PROCUREMENTOFFICER: "PROCUREMENT_OFFICER",
    PROCUREMENT_OFFICER: "PROCUREMENT_OFFICER",
    RESOURCEPLANNER: "RESOURCE_PLANNER",
    RESOURCE_PLANNER: "RESOURCE_PLANNER",
    SYSTEMADMIN: "SYSTEM_ADMIN",
    SYSTEM_ADMIN: "SYSTEM_ADMIN",
    ADMIN: "SYSTEM_ADMIN",
    SERVICEPROVIDER: "SERVICE_PROVIDER",
    SERVICE_PROVIDER: "SERVICE_PROVIDER",
  };
  return map[noUnderscore] || map[upper] || upper;
}

/**
 * Create notification
 * - uniqKey optional (prevents duplicates)
 * - toUsername OR toRole (or both)
 */
export async function createNotification({
  uniqKey = null,
  toUsername = null,
  toRole = null,
  type = "INFO",
  title = "Notification",
  message = "",
  requestId = null,
  meta = {},
}) {
  const now = new Date();

  const doc = {
    ...(uniqKey ? { uniqKey: String(uniqKey) } : {}),

    ...(toUsername ? { toUsername: normalizeUsername(toUsername) } : {}),
    ...(toRole ? { toRole: normalizeRole(toRole) } : {}),

    type: String(type || "INFO")
      .trim()
      .toUpperCase(),
    title: String(title || "Notification").trim(),
    message: String(message || "").trim(),

    ...(requestId ? { requestId: String(requestId) } : {}),
    meta: meta && typeof meta === "object" ? meta : {},

    createdAt: now,
    read: false,
  };

  // must have at least one target
  if (!doc.toUsername && !doc.toRole) return null;

  // idempotent insert
  if (doc.uniqKey) {
    await db
      .collection("notifications")
      .updateOne(
        { uniqKey: doc.uniqKey },
        { $setOnInsert: doc },
        { upsert: true },
      );
  } else {
    await db.collection("notifications").insertOne(doc);
  }

  // OPTIONAL realtime push
  // const io = getIO?.();
  // if (io) {
  //   if (doc.toUsername) io.to(`user:${doc.toUsername}`).emit("notification:new", doc);
  //   if (doc.toRole) io.to(`role:${doc.toRole}`).emit("notification:new", doc);
  // }

  return doc;
}
