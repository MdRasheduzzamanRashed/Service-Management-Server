import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

const TEST_MODE = String(process.env.TEST_MODE || "").toLowerCase() === "true";

function scoreOffer(o) {
  const price = Number(o.price ?? 1e12); // missing price => very bad
  const days = Number(o.deliveryDays ?? 1e6); // missing days => bad
  return price * 0.7 + days * 0.3;
}

function rolesMatch(reqDoc, offer) {
  const reqRoles = Array.isArray(reqDoc.roles) ? reqDoc.roles : [];
  const offered = Array.isArray(offer.rolesProvided) ? offer.rolesProvided : [];

  const need = reqRoles
    .map((r) => String(r?.roleName || "").trim())
    .filter(Boolean);

  const have = new Set(
    offered.map((r) => String(r?.roleName || "").trim()).filter(Boolean),
  );

  return need.every((x) => have.has(x));
}

function mustBePMorSystem(req) {
  const role = String(req.headers["x-user-role"] || "").toUpperCase();
  return ["PROJECT_MANAGER", "SYSTEM_ADMIN"].includes(role);
}

// ✅ close bidding + compute best offers (real)
router.post("/:requestId/close", async (req, res) => {
  try {
    const requestId = String(req.params.requestId || "").trim();
    const rid = new ObjectId(requestId);

    const reqDoc = await db.collection("requests").findOne({ _id: rid });
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });

    const maxOffers = Number(reqDoc.maxOffers ?? 0);
    if (!maxOffers || maxOffers <= 0) {
      return res.status(400).json({ error: "maxOffers is not set on request" });
    }

    const offers = await db.collection("offers").find({ requestId }).toArray();
    const valid = offers.filter((o) => rolesMatch(reqDoc, o));

    const best = valid
      .slice()
      .sort((a, b) => scoreOffer(a) - scoreOffer(b))
      .slice(0, maxOffers);

    const bestIds = best.map((x) => x._id);

    if (bestIds.length) {
      await db
        .collection("offers")
        .updateMany(
          { _id: { $in: bestIds } },
          { $set: { status: "SHORTLISTED", updatedAt: new Date() } },
        );
    }

    await db.collection("requests").updateOne(
      { _id: rid },
      {
        $set: {
          status: "BID_EVALUATION",
          bidEvaluationAt: new Date(),
          shortlistedOfferIds: bestIds.map(String),
          updatedAt: new Date(),
        },
      },
    );

    return res.json({
      success: true,
      picked: best.length,
      maxOffers,
      bestOffers: best,
    });
  } catch (e) {
    console.error("close bidding error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ TEST ONLY: skip bidding by generating mock offers + shortlist best
router.post("/:requestId/skip", async (req, res) => {
  try {
    if (!TEST_MODE) {
      return res.status(403).json({ error: "TEST_MODE is disabled" });
    }
    if (!mustBePMorSystem(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const requestId = String(req.params.requestId || "").trim();
    const rid = new ObjectId(requestId);

    const reqDoc = await db.collection("requests").findOne({ _id: rid });
    if (!reqDoc) return res.status(404).json({ error: "Request not found" });

    const maxOffers = Number(reqDoc.maxOffers ?? 3);
    const make = Number(req.body?.make ?? Math.max(maxOffers + 2, 5));

    const now = new Date();
    const docs = Array.from({ length: make }).map((_, i) => ({
      requestId,
      providerUsername: `mock_sp_${i + 1}`,
      price: 5000 + i * 200,
      currency: "EUR",
      deliveryDays: 10 + i,
      rolesProvided: (reqDoc.roles || []).map((r) => ({
        roleName: r.roleName,
        domain: r.domain,
        technology: r.technology,
        experienceLevel: r.experienceLevel,
        manDays: r.manDays,
        onsiteDays: r.onsiteDays,
      })),
      notes: "Mock offer for testing",
      status: "SUBMITTED",
      createdAt: now,
      updatedAt: now,
    }));

    await db.collection("offers").insertMany(docs);

    // pick best
    const offers = await db.collection("offers").find({ requestId }).toArray();
    const valid = offers.filter((o) => rolesMatch(reqDoc, o));

    const best = valid
      .slice()
      .sort((a, b) => scoreOffer(a) - scoreOffer(b))
      .slice(0, maxOffers);

    const bestIds = best.map((x) => x._id);

    if (bestIds.length) {
      await db
        .collection("offers")
        .updateMany(
          { _id: { $in: bestIds } },
          { $set: { status: "SHORTLISTED", updatedAt: new Date() } },
        );
    }

    await db.collection("requests").updateOne(
      { _id: rid },
      {
        $set: {
          status: "BID_EVALUATION",
          bidEvaluationAt: new Date(),
          shortlistedOfferIds: bestIds.map(String),
          updatedAt: new Date(),
        },
      },
    );

    return res.json({
      success: true,
      createdMockOffers: make,
      picked: best.length,
      maxOffers,
      bestOffers: best,
    });
  } catch (e) {
    console.error("skip bidding error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
