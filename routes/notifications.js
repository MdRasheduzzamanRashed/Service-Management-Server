import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

/**
 * GET /api/notifications
 * Returns notifications for the logged-in user (by username from JWT).
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const username = String(req.user?.username || "")
      .trim()
      .toLowerCase();
    if (!username) return res.status(401).json({ error: "Unauthorized" });

    const notifications = await db
      .collection("notifications")
      .find({ toUsername: username })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    return res.json({ notifications });
  } catch (err) {
    console.error("Notifications error:", err);
    return res.status(500).json({ error: "Error fetching notifications" });
  }
});

export default router;
