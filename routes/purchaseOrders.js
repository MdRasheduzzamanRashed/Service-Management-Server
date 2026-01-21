// routes/purchaseOrders.js
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
  return {
    role: normalizeRole(req.headers["x-user-role"]),
    username: normalizeUsername(req.headers["x-username"]),
  };
}
function isPO(role) {
  return role === "PROCUREMENT_OFFICER";
}
function parseId(idStr) {
  try {
    return new ObjectId(idStr);
  } catch {
    return null;
  }
}

/**
 * POST /api/purchase-orders
 * PO places order for recommended offer
 * body: { requestId, offerId }
 */
router.post("/", async (req, res) => {
  try {
    const { role, username } = getUser(req);
    if (!role) return res.status(401).json({ error: "Missing x-user-role" });
    if (!isPO(role))
      return res
        .status(403)
        .json({ error: "Only PROCUREMENT_OFFICER can order" });
    if (!username) return res.status(401).json({ error: "Missing x-username" });

    const body = req.body || {};
    const requestId = parseId(body.requestId);
    const offerId = parseId(body.offerId);

    if (!requestId || !offerId)
      return res.status(400).json({ error: "Invalid requestId/offerId" });

    const reqDoc = await db.collection("requests").findOne({ _id: requestId });
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });

    if (String(reqDoc.status || "").toUpperCase() !== "SENT_TO_PO") {
      return res.status(403).json({ error: "Request is not in SENT_TO_PO" });
    }

    const offer = await db.collection("offers").findOne({ _id: offerId });
    if (!offer) return res.status(404).json({ error: "Offer not found" });
    if (String(offer.requestId) !== String(requestId)) {
      return res
        .status(400)
        .json({ error: "Offer does not belong to request" });
    }

    const poDoc = {
      requestId: String(requestId),
      offerId: String(offerId),
      orderedBy: username,
      orderedAt: new Date(),
      totalPrice: offer.price || 0,
      currency: offer.currency || "EUR",
      status: "ORDERED",
    };

    const result = await db.collection("purchase_orders").insertOne(poDoc);

    // mark request ORDERED
    await db
      .collection("requests")
      .updateOne(
        { _id: requestId },
        {
          $set: {
            status: "ORDERED",
            orderedAt: new Date(),
            orderedBy: username,
            orderId: String(result.insertedId),
            updatedAt: new Date(),
          },
        },
      );

    // mark offer ORDERED
    await db
      .collection("offers")
      .updateOne(
        { _id: offerId },
        { $set: { status: "ORDERED", updatedAt: new Date() } },
      );

    return res.json({ success: true, orderId: result.insertedId });
  } catch (e) {
    console.error("Create PO error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
