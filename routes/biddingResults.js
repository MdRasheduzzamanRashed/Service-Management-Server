// routes/biddingResults.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

function parseId(idStr) {
  try {
    return new ObjectId(idStr);
  } catch {
    return null;
  }
}

/**
 * POST /api/bidding/results
 * Mock endpoint for "other team" to send best offers.
 * body: { requestId, maxOffers, bestOffers: [...] }
 */
router.post("/results", async (req, res) => {
  try {
    const body = req.body || {};
    const requestIdObj = parseId(body.requestId);
    if (!requestIdObj)
      return res.status(400).json({ error: "Invalid requestId" });

    const reqDoc = await db
      .collection("requests")
      .findOne({ _id: requestIdObj });
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });

    const maxOffers = Number(body.maxOffers ?? reqDoc.maxOffers ?? 3);
    const bestOffers = Array.isArray(body.bestOffers)
      ? body.bestOffers.slice(0, maxOffers)
      : [];

    const doc = {
      requestId: String(reqDoc._id),
      maxOffers,
      bestOffers,
      receivedAt: new Date(),
    };

    // upsert one result per request
    await db
      .collection("bidding_results")
      .updateOne(
        { requestId: String(reqDoc._id) },
        { $set: doc },
        { upsert: true },
      );

    return res.json({ success: true });
  } catch (e) {
    console.error("Bidding results error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/bidding/results/:requestId
 */
router.get("/results/:requestId", async (req, res) => {
  try {
    const requestIdObj = parseId(req.params.requestId);
    if (!requestIdObj)
      return res.status(400).json({ error: "Invalid requestId" });

    const doc = await db
      .collection("bidding_results")
      .findOne({ requestId: String(requestIdObj) });
    return res.json(doc || null);
  } catch (e) {
    console.error("Get bidding results error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
