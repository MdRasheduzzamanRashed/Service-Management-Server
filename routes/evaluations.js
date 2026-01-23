import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";
import { createNotification } from "../utils/notify.js";

const router = express.Router();

/* no-cache */
router.use((req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

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
  const role = normalizeRole(req.headers["x-user-role"]);
  if (!role) return { error: "Missing x-user-role" };
  const username = normalizeUsername(req.headers["x-username"]);
  return { role, username };
}
function parseId(idStr) {
  try {
    return new ObjectId(String(idStr));
  } catch {
    return null;
  }
}

/**
 * GET /api/rp-evaluations/:requestId
 * RP/PM/PO/Admin can read
 */
router.get("/:requestId", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const role = user.role;
    const canRead =
      role === "RESOURCE_PLANNER" ||
      role === "PROJECT_MANAGER" ||
      role === "PROCUREMENT_OFFICER" ||
      role === "SYSTEM_ADMIN";

    if (!canRead) return res.status(403).json({ error: "Not allowed" });

    const requestId = String(req.params.requestId || "").trim();
    if (!requestId) return res.status(400).json({ error: "requestId missing" });

    const doc = await db.collection("rp_evaluations").findOne({ requestId });
    return res.json(doc || null);
  } catch (e) {
    console.error("GET rp evaluation error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/rp-evaluations/:requestId
 * RP only: create/update evaluation
 * body: { weights, offers, comment, recommendedOfferId }
 */
router.post("/:requestId", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (user.role !== "RESOURCE_PLANNER")
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can evaluate" });

    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const requestId = String(req.params.requestId || "").trim();
    if (!requestId) return res.status(400).json({ error: "requestId missing" });

    const body = req.body || {};
    const weights = body.weights || {
      price: 0.6,
      delivery: 0.25,
      quality: 0.15,
    };
    const offers = Array.isArray(body.offers) ? body.offers : [];
    const comment = String(body.comment || "").trim();
    const recommendedOfferId = String(body.recommendedOfferId || "").trim();

    // Validate recommendedOfferId exists in offers list if provided
    if (
      recommendedOfferId &&
      !offers.some((o) => String(o.offerId) === recommendedOfferId)
    ) {
      return res
        .status(400)
        .json({ error: "recommendedOfferId must exist in offers list" });
    }

    const now = new Date();

    const doc = {
      requestId,
      rpUsername: normalizeUsername(user.username),
      weights: {
        price: Number(weights.price ?? 0.6),
        delivery: Number(weights.delivery ?? 0.25),
        quality: Number(weights.quality ?? 0.15),
      },
      offers: offers.map((o) => ({
        offerId: String(o.offerId || "").trim(),
        providerUsername: String(o.providerUsername || "").trim(),
        price: o.price ?? null,
        currency: o.currency || "EUR",
        deliveryDays: o.deliveryDays ?? null,

        // evaluation fields
        scorePrice: Number(o.scorePrice ?? 0),
        scoreDelivery: Number(o.scoreDelivery ?? 0),
        scoreQuality: Number(o.scoreQuality ?? 0),
        totalScore: Number(o.totalScore ?? 0),

        notes: String(o.notes || "").trim(),
      })),
      comment,
      recommendedOfferId: recommendedOfferId || null,
      updatedAt: now,
    };

    // Upsert (1 evaluation per request)
    const existing = await db
      .collection("rp_evaluations")
      .findOne({ requestId });
    if (!existing) doc.createdAt = now;

    await db
      .collection("rp_evaluations")
      .updateOne(
        { requestId },
        { $set: doc, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );

    // Optional: notify PM that RP updated evaluation (not recommendation yet)
    await createNotification({
      uniqKey: `${requestId}:RP_EVAL_UPDATED`,
      toRole: "PROJECT_MANAGER",
      type: "RP_EVALUATION",
      title: "RP evaluation updated",
      message: `RP updated evaluation for request ${requestId}.`,
      requestId,
    });

    const saved = await db.collection("rp_evaluations").findOne({ requestId });
    return res.json({ success: true, data: saved });
  } catch (e) {
    console.error("POST rp evaluation error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
