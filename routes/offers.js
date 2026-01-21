// routes/offers.js
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
  const role = normalizeRole(req.headers["x-user-role"]);
  const username = normalizeUsername(req.headers["x-username"]);
  return { role, username };
}
function parseId(v) {
  try {
    return new ObjectId(String(v));
  } catch {
    return null;
  }
}

function isSP(role) {
  return role === "SERVICE_PROVIDER";
}
function canReadAll(role) {
  return (
    role === "PROJECT_MANAGER" ||
    role === "PROCUREMENT_OFFICER" ||
    role === "RESOURCE_PLANNER" ||
    role === "SYSTEM_ADMIN"
  );
}

/**
 * ✅ SP submits an offer to a bidding request
 * POST /api/offers
 * body: { requestId, providerName?, price?, currency?, deliveryDays?, rolesProvided:[...], notes? }
 */
router.post("/", async (req, res) => {
  try {
    const user = getUser(req);

    if (!isSP(user.role)) {
      return res
        .status(403)
        .json({ error: "Only SERVICE_PROVIDER can submit offers" });
    }
    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const body = req.body || {};
    const requestId = parseId(body.requestId);
    if (!requestId) return res.status(400).json({ error: "Invalid requestId" });

    const request = await db.collection("requests").findOne({ _id: requestId });
    if (!request) return res.status(404).json({ error: "Request not found" });

    const st = String(request.status || "").toUpperCase();
    if (st !== "BIDDING") {
      return res
        .status(403)
        .json({
          error: "Offers can be submitted only when request is BIDDING",
        });
    }

    // ✅ minimal validation: rolesProvided must exist
    const rolesProvided = Array.isArray(body.rolesProvided)
      ? body.rolesProvided
      : [];
    if (rolesProvided.length === 0) {
      return res
        .status(400)
        .json({ error: "rolesProvided is required (array)" });
    }

    const offerDoc = {
      requestId: String(request._id),
      requestTitle: request.title || "",
      providerUsername: user.username,
      providerName: String(body.providerName || user.username),
      rolesProvided,
      price: body.price ?? null,
      currency: body.currency || "EUR",
      deliveryDays: body.deliveryDays ?? null,
      notes: body.notes || "",
      status: "SUBMITTED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const r = await db.collection("offers").insertOne(offerDoc);
    return res.json({ success: true, id: r.insertedId });
  } catch (e) {
    console.error("offers post error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * ✅ list offers of a request (RP/PM/PO/Admin)
 * GET /api/offers?requestId=...
 */
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (!canReadAll(user.role)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const requestId = String(req.query.requestId || "").trim();
    if (!requestId)
      return res.status(400).json({ error: "requestId is required" });

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

/**
 * ✅ SP: list my offers
 * GET /api/offers/my
 */
router.get("/my", async (req, res) => {
  try {
    const user = getUser(req);
    if (!isSP(user.role))
      return res.status(403).json({ error: "Only SERVICE_PROVIDER" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const list = await db
      .collection("offers")
      .find({ providerUsername: user.username })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("offers my error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
