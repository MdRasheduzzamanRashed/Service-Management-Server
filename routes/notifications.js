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
 * Personal + role-based notifications
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const username = normalizeUsername(req.user.username);

    const query = {
      $or: [
        { toUsername: username }, // ✅ personal
        { roles: role }, // ✅ role-wide (optional)
      ],
    };

    const notifications = await db
      .collection("notifications")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json({ notifications });
  } catch (err) {
    console.error("Notifications error:", err);
    res.status(500).json({ error: "Error fetching notifications" });
  }
});

/**
 * GET /api/notifications/unread-count
 */
router.get("/unread-count", authMiddleware, async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    const username = normalizeUsername(req.user.username);

    const count = await db.collection("notifications").countDocuments({
      read: false,
      $or: [{ toUsername: username }, { roles: role }],
    });

    res.json({ unreadCount: count });
  } catch (err) {
    console.error("Unread count error:", err);
    res.status(500).json({ error: "Error fetching unread count" });
  }
});

/**
 * POST /api/notifications/:id/read
 */
router.post("/:id/read", authMiddleware, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });

    const role = normalizeRole(req.user.role);
    const username = normalizeUsername(req.user.username);

    const result = await db.collection("notifications").updateOne(
      {
        _id: id,
        $or: [{ toUsername: username }, { roles: role }],
      },
      {
        $set: { read: true, readAt: new Date() },
      },
    );

    if (!result.matchedCount) {
      return res.status(403).json({ error: "Not allowed" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Error updating notification" });
  }
});

export default router;
