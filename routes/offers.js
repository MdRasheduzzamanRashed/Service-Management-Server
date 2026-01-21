// routes/offers.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

const OFFER_STATUS = {
  SUBMITTED: "SUBMITTED",
  RECOMMENDED: "RECOMMENDED",
  ORDERED: "ORDERED",
};

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
  // you already use x-user-role / x-username in requests.js
  const role = normalizeRole(req.headers["x-user-role"]);
  const username = normalizeUsername(req.headers["x-username"]);
  return { role, username };
}
function isSP(role) {
  return role === "SERVICE_PROVIDER";
}
function isRP(role) {
  return role === "RESOURCE_PLANNER";
}
function isPM(role) {
  return role === "PROJECT_MANAGER";
}
function isPO(role) {
  return role === "PROCUREMENT_OFFICER";
}
function canReadOffers(role) {
  return isPM(role) || isRP(role) || isPO(role) || isSP(role);
}
function parseId(idStr) {
  try {
    return new ObjectId(idStr);
  } catch {
    return null;
  }
}

/**
 * POST /api/offers
 * SP submits an offer for a bidding request
 * body: { requestId, price, currency, deliveryDays, note, rolesProvided: [...] }
 */
router.post("/", async (req, res) => {
  try {
    const { role, username } = getUser(req);
    if (!role) return res.status(401).json({ error: "Missing x-user-role" });
    if (!isSP(role))
      return res
        .status(403)
        .json({ error: "Only SERVICE_PROVIDER can submit offers" });
    if (!username) return res.status(401).json({ error: "Missing x-username" });

    const body = req.body || {};
    const requestId = parseId(body.requestId);
    if (!requestId) return res.status(400).json({ error: "Invalid requestId" });

    const reqDoc = await db.collection("requests").findOne({ _id: requestId });
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });

    const status = String(reqDoc.status || "").toUpperCase();
    if (status !== "BIDDING")
      return res.status(403).json({ error: "Request is not in BIDDING" });

    const offer = {
      requestId: String(reqDoc._id),
      spUsername: username,
      price: Number(body.price || 0),
      currency: body.currency || "EUR",
      deliveryDays: Number(body.deliveryDays || 0),
      note: String(body.note || ""),
      rolesProvided: Array.isArray(body.rolesProvided)
        ? body.rolesProvided
        : [],
      status: OFFER_STATUS.SUBMITTED,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("offers").insertOne(offer);
    return res.json({ success: true, id: result.insertedId });
  } catch (e) {
    console.error("Submit offer error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/offers?requestId=...
 * RP/PM/PO can see all offers for a request
 * SP can see their own offers
 */
router.get("/", async (req, res) => {
  try {
    const { role, username } = getUser(req);
    if (!role) return res.status(401).json({ error: "Missing x-user-role" });
    if (!canReadOffers(role))
      return res.status(403).json({ error: "Not allowed" });

    const requestId = String(req.query.requestId || "").trim();
    if (!requestId)
      return res.status(400).json({ error: "requestId is required" });

    const query = { requestId };
    if (isSP(role)) query.spUsername = username; // SP only sees own offers

    const list = await db
      .collection("offers")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
    return res.json(list);
  } catch (e) {
    console.error("List offers error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/offers/:id/recommend
 * RP recommends an offer (also updates request to RECOMMENDED)
 * body: { requestId }
 */
router.post("/:id/recommend", async (req, res) => {
  try {
    const { role, username } = getUser(req);
    if (!role) return res.status(401).json({ error: "Missing x-user-role" });
    if (!isRP(role))
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can recommend" });
    if (!username) return res.status(401).json({ error: "Missing x-username" });

    const offerId = parseId(req.params.id);
    if (!offerId) return res.status(400).json({ error: "Invalid offer id" });

    const offer = await db.collection("offers").findOne({ _id: offerId });
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    const requestId = parseId(offer.requestId);
    if (!requestId)
      return res.status(400).json({ error: "Offer has invalid requestId" });

    // mark offer recommended
    await db
      .collection("offers")
      .updateOne(
        { _id: offerId },
        {
          $set: {
            status: OFFER_STATUS.RECOMMENDED,
            updatedAt: new Date(),
            recommendedAt: new Date(),
            recommendedBy: username,
          },
        },
      );

    // update request status -> RECOMMENDED + recommendedOfferId
    await db
      .collection("requests")
      .updateOne(
        { _id: requestId },
        {
          $set: {
            status: "RECOMMENDED",
            recommendedOfferId: String(offerId),
            recommendedAt: new Date(),
            recommendedBy: username,
            updatedAt: new Date(),
          },
        },
      );

    return res.json({ success: true });
  } catch (e) {
    console.error("Recommend offer error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
