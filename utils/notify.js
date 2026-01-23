// utils/notify.js
import { db } from "../db.js";

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

function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

/**
 * createNotification({ uniqKey?, toUsername?, toRole?, type, title, message, requestId })
 * - If uniqKey provided -> idempotent (upsert)
 * - else -> insert new
 */
export async function createNotification(payload = {}) {
  const now = new Date();

  const doc = {
    uniqKey: payload.uniqKey || null,
    toUsername: payload.toUsername
      ? normalizeUsername(payload.toUsername)
      : null,
    toRole: payload.toRole ? normalizeRole(payload.toRole) : null,
    type: String(payload.type || "INFO"),
    title: String(payload.title || "Notification"),
    message: String(payload.message || ""),
    requestId: payload.requestId ? String(payload.requestId) : null,
    createdAt: now,
    read: false,
  };

  // remove null fields to keep DB clean
  Object.keys(doc).forEach((k) => doc[k] == null && delete doc[k]);

  if (doc.uniqKey) {
    await db
      .collection("notifications")
      .updateOne(
        { uniqKey: doc.uniqKey },
        { $setOnInsert: doc },
        { upsert: true },
      );
    return { ok: true, upsert: true };
  }

  await db.collection("notifications").insertOne(doc);
  return { ok: true, insert: true };
}
