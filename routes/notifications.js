import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

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

function parseId(idStr) {
  try {
    return new ObjectId(idStr);
  } catch {
    return null;
  }
}

/**
 * GET /api/notifications
 * Returns notifications for:
 *  - user (toUsername)
 *  - or role-wide (roles: [ROLE])
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    const username = normalizeUsername(req.user?.username);

    // ✅ supports both personal + role notifications
    const query = {
      $or: [
        { toUsername: username },
        { roles: role }, // optional for global/role announcements
      ],
    };

    const notifications = await db
      .collection("notifications")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    return res.json({ notifications });
  } catch (err) {
    console.error("Notifications error:", err);
    return res.status(500).json({ error: "Error fetching notifications" });
  }
});

/**
 * GET /api/notifications/unread-count
 */
router.get("/unread-count", authMiddleware, async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    const username = normalizeUsername(req.user?.username);

    const query = {
      read: false,
      $or: [{ toUsername: username }, { roles: role }],
    };

    const count = await db.collection("notifications").countDocuments(query);
    return res.json({ unreadCount: count });
  } catch (err) {
    console.error("Unread count error:", err);
    return res.status(500).json({ error: "Error fetching unread count" });
  }
});

/**
 * POST /api/notifications/:id/read
 * Mark one as read
 */
router.post("/:id/read", authMiddleware, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const role = normalizeRole(req.user?.role);
    const username = normalizeUsername(req.user?.username);

    // ✅ only allow marking your own / your role notifications
    const query = {
      _id: id,
      $or: [{ toUsername: username }, { roles: role }],
    };

    await db.collection("notifications").updateOne(query, {
      $set: { read: true, readAt: new Date() },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Mark read error:", err);
    return res.status(500).json({ error: "Error updating notification" });
  }
});

export default router;
