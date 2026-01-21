// routes/mockOffers.js
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

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[rand(0, arr.length - 1)];
}

function computeScore({ priceTotal, deliveryDays, experienceYears }) {
  // Higher is better (you can adjust weights)
  const priceScore = 100000 / Math.max(priceTotal, 1); // cheaper => higher
  const deliveryScore = 100 / Math.max(deliveryDays, 1); // faster => higher
  const expScore = Math.min(experienceYears, 15) * 3; // more exp => higher
  return Math.round(priceScore * 0.55 + deliveryScore * 0.25 + expScore * 0.2);
}

function buildMockOffer({
  requestId,
  supplierName,
  currency = "EUR",
  roles = [],
}) {
  const deliveryDays = rand(3, 20);
  const experienceYears = rand(2, 12);

  // create a simple cost from roles if present
  const baseDayRate = rand(450, 950);
  const manDays =
    roles.reduce((sum, r) => sum + Number(r?.manDays || 0), 0) || rand(10, 60);
  const priceTotal = baseDayRate * manDays;

  const score = computeScore({ priceTotal, deliveryDays, experienceYears });

  return {
    requestId: String(requestId),
    supplierName,
    currency,
    deliveryDays,
    experienceYears,
    dayRate: baseDayRate,
    manDays,
    priceTotal,
    score,
    status: "SUBMITTED", // SUBMITTED | SHORTLISTED | REJECTED
    createdAt: new Date(),
  };
}

/**
 * ✅ Generate offers (once) for a BIDDING request
 * X = request.maxOffers (fallback to 5)
 * We generate more than X, then select top X as "SHORTLISTED"
 */
async function ensureOffersForRequest(requestDoc) {
  const requestId = String(requestDoc._id);

  // already exist?
  const existing = await db
    .collection("mock_offers")
    .find({ requestId })
    .sort({ score: -1 })
    .toArray();

  if (existing.length) return existing;

  const X =
    Number(requestDoc.maxOffers || 0) > 0 ? Number(requestDoc.maxOffers) : 5;

  const suppliers = [
    "Alpha Solutions GmbH",
    "BluePeak Consulting",
    "Nordic Talent Group",
    "SoftBridge Partners",
    "PrimeIT Europe",
    "Vertex Staffing",
    "GreenWave Systems",
    "CoreOps Experts",
    "NovaTech Services",
    "CloudSprint Agency",
  ];

  // create more candidates than X, then take best X
  const candidateCount = Math.max(X + 4, 8);

  const offers = Array.from({ length: candidateCount }).map(() =>
    buildMockOffer({
      requestId,
      supplierName: pick(suppliers),
      roles: Array.isArray(requestDoc.roles) ? requestDoc.roles : [],
    }),
  );

  // sort by score desc
  offers.sort((a, b) => b.score - a.score);

  // mark top X as SHORTLISTED
  offers.forEach((o, idx) => {
    o.status = idx < X ? "SHORTLISTED" : "REJECTED";
    o.rank = idx + 1;
  });

  await db.collection("mock_offers").insertMany(offers);

  return await db
    .collection("mock_offers")
    .find({ requestId })
    .sort({ score: -1 })
    .toArray();
}

// ✅ GET /api/mock-offers/requests/:requestId/best
// returns { requestId, maxOffers, bestOffers }
router.get("/requests/:requestId/best", async (req, res) => {
  try {
    const id = parseId(req.params.requestId);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const requestDoc = await db.collection("requests").findOne({ _id: id });
    if (!requestDoc) return res.status(404).json({ error: "Request not found" });

    const st = String(requestDoc.status || "").toUpperCase();
    if (st !== "BIDDING") {
      return res
        .status(403)
        .json({ error: "Offers are available only when request is BIDDING" });
    }

    const all = await ensureOffersForRequest(requestDoc);

    const maxOffers =
      Number(requestDoc.maxOffers || 0) > 0 ? Number(requestDoc.maxOffers) : 5;

    const bestOffers = all
      .filter((o) => o.status === "SHORTLISTED")
      .sort((a, b) => b.score - a.score)
      .slice(0, maxOffers);

    return res.json({
      requestId: String(requestDoc._id),
      maxOffers,
      bestOffers,
    });
  } catch (e) {
    console.error("best offers error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});


/**
 * ✅ GET /api/mock-offers/requests/:requestId/offers
 * returns all generated offers
 */
router.get("/requests/:requestId/offers", async (req, res) => {
  try {
    const id = parseId(req.params.requestId);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const requestDoc = await db.collection("requests").findOne({ _id: id });
    if (!requestDoc)
      return res.status(404).json({ error: "Request not found" });

    const requestId = String(requestDoc._id);

    const list = await db
      .collection("mock_offers")
      .find({ requestId })
      .sort({ score: -1 })
      .toArray();

    return res.json({ requestId, offers: list });
  } catch (e) {
    console.error("list offers error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * ✅ POST /api/mock-offers/requests/:requestId/generate
 * Force-regenerate (deletes old and creates fresh)
 */
router.post("/requests/:requestId/generate", async (req, res) => {
  try {
    const id = parseId(req.params.requestId);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const requestDoc = await db.collection("requests").findOne({ _id: id });
    if (!requestDoc)
      return res.status(404).json({ error: "Request not found" });

    const st = String(requestDoc.status || "").toUpperCase();
    if (st !== "BIDDING") {
      return res
        .status(403)
        .json({ error: "Can generate offers only when request is BIDDING" });
    }

    const requestId = String(requestDoc._id);
    await db.collection("mock_offers").deleteMany({ requestId });

    const all = await ensureOffersForRequest(requestDoc);

    return res.json({
      success: true,
      requestId,
      generated: all.length,
      maxOffers: Number(requestDoc.maxOffers || 0) || 5,
    });
  } catch (e) {
    console.error("generate offers error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
