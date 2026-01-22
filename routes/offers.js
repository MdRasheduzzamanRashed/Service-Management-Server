// routes/offers.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

/* =========================
   Helpers
========================= */
function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function parseId(v) {
  try {
    return new ObjectId(String(v));
  } catch {
    return null;
  }
}

/* =========================================================
   ✅ GET ALL offers of a request
   GET /api/offers?requestId=...
========================================================= */
router.get("/", async (req, res) => {
  try {
    const requestId = String(req.query.requestId || "").trim();
    if (!requestId) {
      return res.status(400).json({ error: "requestId is required" });
    }

    const list = await db
      .collection("offers")
      .find({ requestId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("offers list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ✅ GET MY offers
   GET /api/offers/my
   (uses x-username only)
========================================================= */
router.get("/my", async (req, res) => {
  try {
    const username = normalizeUsername(req.headers["x-username"]);
    if (!username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const list = await db
      .collection("offers")
      .find({ providerUsername: username })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("offers my error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ✅ GET single offer
   GET /api/offers/:id
========================================================= */
router.get("/:id", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid offer id" });

    const offer = await db.collection("offers").findOne({ _id: id });
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    return res.json(offer);
  } catch (e) {
    console.error("offer get error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
