import express from "express";
import { db } from "../db.js";

const router = express.Router();

/* ============================================================
   GET ALL SKILLS
============================================================ */
router.get("/api/skills", async (req, res) => {
  try {
    const skills = await db
      .collection("skills")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(skills);
  } catch (err) {
    console.error("Load skills error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
