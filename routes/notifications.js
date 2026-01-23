import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

/* =========================
   No-cache for API
========================= */
router.use((req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

/* =========================
   Helpers
========================= */
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

function getUser(req) {
  const role = normalizeRole(req.headers["x-user-role"]);
  if (!role) return { error: "Missing x-user-role" };
  const username = normalizeUsername(req.headers["x-username"]);
  return { role, username };
}

function parseId(idStr) {
  try {
    return new ObjectId(String(idStr));
  } catch {
    return null;
  }
}

/* =========================
   GET /api/notifications
   Query:
   - page, limit
   - unreadOnly=true
========================= */
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit || 30) || 30),
    );
    const skip = (page - 1) * limit;

    const unreadOnly =
      String(req.query.unreadOnly || "").toLowerCase() === "true";

    // user receives:
    // - direct notifications: toUsername
    // - role notifications: toRole
    const match = {
      $or: [
        ...(user.username
          ? [{ toUsername: normalizeUsername(user.username) }]
          : []),
        { toRole: user.role },
      ],
    };

    if (unreadOnly) match.read = false;

    const total = await db.collection("notifications").countDocuments(match);

    const list = await db
      .collection("notifications")
      .find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    return res.json({
      data: list,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (e) {
    console.error("notifications list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   GET /api/notifications/unread-count
========================= */
router.get("/unread-count", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const match = {
      read: false,
      $or: [
        ...(user.username
          ? [{ toUsername: normalizeUsername(user.username) }]
          : []),
        { toRole: user.role },
      ],
    };

    const count = await db.collection("notifications").countDocuments(match);
    return res.json({ unreadCount: count });
  } catch (e) {
    console.error("unread-count error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   POST /api/notifications/:id/read
========================= */
router.post("/:id/read", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid notification id" });

    // ensure ownership by role/username
    const doc = await db.collection("notifications").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Not found" });

    const can =
      (doc.toRole && normalizeRole(doc.toRole) === user.role) ||
      (doc.toUsername && normalizeUsername(doc.toUsername) === user.username);

    if (!can) return res.status(403).json({ error: "Not allowed" });

    await db
      .collection("notifications")
      .updateOne({ _id: id }, { $set: { read: true, readAt: new Date() } });

    return res.json({ success: true });
  } catch (e) {
    console.error("mark read error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   POST /api/notifications/read-all
========================= */
router.post("/read-all", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const match = {
      read: false,
      $or: [
        ...(user.username ? [{ toUsername: user.username }] : []),
        { toRole: user.role },
      ],
    };

    const r = await db.collection("notifications").updateMany(match, {
      $set: { read: true, readAt: new Date() },
    });

    return res.json({ success: true, modified: r.modifiedCount || 0 });
  } catch (e) {
    console.error("read-all error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
