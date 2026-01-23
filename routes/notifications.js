// routes/notifications.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

function normalizeRole(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}
function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function getUser(req) {
  const role = normalizeRole(req.headers["x-user-role"]);
  const username = normalizeUsername(req.headers["x-username"]);
  if (!role) return { error: "Missing x-user-role" };
  return { role, username };
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseId(idStr) {
  try {
    return new ObjectId(String(idStr));
  } catch {
    return null;
  }
}

/**
 * Notifications model (recommended)
 * {
 *   _id,
 *   toUsername?: "john",
 *   toRole?: "PROCUREMENT_OFFICER",
 *   uniqKey?: "requestId:TYPE:extra", (optional for dedupe)
 *   type: "REQUEST_STATUS",
 *   title: "...",
 *   message: "...",
 *   requestId?: "...",
 *   meta?: { ... },
 *   read: false,
 *   createdAt,
 *   readAt?
 * }
 */

// ✅ GET /api/notifications
// Query: ?unreadOnly=1&page=1&limit=50
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const unreadOnly =
      String(req.query.unreadOnly || "").trim() === "1" ||
      String(req.query.unreadOnly || "")
        .trim()
        .toLowerCase() === "true";

    const page = clampInt(req.query.page, 1, 1, 1000000);
    const limit = clampInt(req.query.limit, 50, 1, 100);
    const skip = (page - 1) * limit;

    // ✅ user sees:
    // - notifications targeted to them by username
    // - notifications targeted to their role
    const match = {
      $and: [
        {
          $or: [
            user.username ? { toUsername: user.username } : null,
            { toRole: user.role },
          ].filter(Boolean),
        },
        unreadOnly ? { read: false } : {},
      ],
    };

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
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (e) {
    console.error("List notifications error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ POST /api/notifications/:id/read
router.post("/:id/read", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid notification id" });

    // ensure user can only mark their own/role notifications
    const match = {
      _id: id,
      $or: [
        user.username ? { toUsername: user.username } : null,
        { toRole: user.role },
      ].filter(Boolean),
    };

    const now = new Date();
    await db.collection("notifications").updateOne(match, {
      $set: { read: true, readAt: now },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("Mark read error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ POST /api/notifications/read-all
router.post("/read-all", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const now = new Date();

    const match = {
      $or: [
        user.username ? { toUsername: user.username } : null,
        { toRole: user.role },
      ].filter(Boolean),
      read: false,
    };

    const r = await db.collection("notifications").updateMany(match, {
      $set: { read: true, readAt: now },
    });

    return res.json({ success: true, modified: r.modifiedCount || 0 });
  } catch (e) {
    console.error("Read all error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
