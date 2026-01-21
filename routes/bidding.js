// routes/bidding.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

function parseId(v) {
  try {
    return new ObjectId(String(v));
  } catch {
    return null;
  }
}

/**
 * ✅ Mock endpoint used by another team
 * POST /api/bidding/results
 * body: { requestId, maxOffers, bestOffers }
 *
 * bestOffers example:
 * [
 *   { offerId, providerUsername, providerName, score, price, rolesProvided, notes }
 * ]
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

    const st = String(reqDoc.status || "").toUpperCase();
    if (!["BIDDING", "EXPIRED"].includes(st)) {
      return res
        .status(403)
        .json({
          error: "Can submit results only for BIDDING/EXPIRED requests",
        });
    }

    const maxOffers = Number(body.maxOffers ?? reqDoc.maxOffers ?? 3);
    const bestOffers = Array.isArray(body.bestOffers)
      ? body.bestOffers.slice(0, maxOffers)
      : [];

    const requestId = String(reqDoc._id);
    const uniqKey = `BIDDING_RESULT:${requestId}`;

    await db.collection("bidding_results").updateOne(
      { uniqKey },
      {
        $set: {
          uniqKey,
          requestId,
          maxOffers,
          bestOffers,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    // ✅ Move to evaluation state (optional but useful)
    await db
      .collection("requests")
      .updateOne(
        { _id: requestIdObj, status: st },
        { $set: { status: "BID_EVALUATION", updatedAt: new Date() } },
      );

    return res.json({
      success: true,
      requestId,
      maxOffers,
      count: bestOffers.length,
    });
  } catch (e) {
    console.error("bidding/results error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
