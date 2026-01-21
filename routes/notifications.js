import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

// GET /api/notifications
router.get("/", authMiddleware, async (req, res) => {
  try {
    const role = String(req.user.role || "")
      .trim()
      .toUpperCase();
    const username = String(req.user.username || "")
      .trim()
      .toLowerCase();

    const query = {
      $or: [
        username ? { toUsername: username } : null,
        role ? { toRole: role } : null,
      ].filter(Boolean),
    };

    const notifications = await db
      .collection("notifications")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    return res.json(notifications);
  } catch (err) {
    console.error("Notifications error:", err);
    return res.status(500).json({ error: "Error fetching notifications" });
  }
});

export default router;
