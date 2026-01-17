import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

// GET /notifications
router.get("/notifications", authMiddleware, async (req, res) => {
  try {
    const role = req.user.role;

    const notifications = await db
      .collection("notifications")
      .find({ roles: role })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ notifications });
  } catch (err) {
    console.error("Notifications error:", err);
    return res.status(500).json({ error: "Error fetching notifications" });
  }
});

export default router;
