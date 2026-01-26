import express from "express";
import { db } from "../db.js";

const router = express.Router();

/* =========================
   No-cache (recommended)
========================= */
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

/* =========================
   Auth helpers
========================= */
function normalizeRole(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const upper = s.toUpperCase().replace(/\s+/g, "_");
  const noUnderscore = upper.replace(/_/g, "");
  const map = {
    PROJECTMANAGER: "PROJECT_MANAGER",
    PROJECT_MANAGER: "PROJECT_MANAGER",
    PROCUREMENTOFFICER: "PROCUREMENT_OFFICER",
    PROCUREMENT_OFFICER: "PROCUREMENT_OFFICER",
    RESOURCEPLANNER: "RESOURCE_PLANNER",
    RESOURCE_PLANNER: "RESOURCE_PLANNER",
    SYSTEMADMIN: "SYSTEM_ADMIN",
    SYSTEM_ADMIN: "SYSTEM_ADMIN",
    ADMIN: "SYSTEM_ADMIN",
    SERVICEPROVIDER: "SERVICE_PROVIDER",
    SERVICE_PROVIDER: "SERVICE_PROVIDER",
  };
  return map[noUnderscore] || map[upper] || upper;
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

function isAdmin(role) {
  return role === "SYSTEM_ADMIN";
}
function isPM(role) {
  return role === "PROJECT_MANAGER";
}
function isPO(role) {
  return role === "PROCUREMENT_OFFICER"; // ✅ evaluator after swap
}
function isRP(role) {
  return role === "RESOURCE_PLANNER"; // ✅ ordering after swap
}
function isSP(role) {
  return role === "SERVICE_PROVIDER";
}

/* =========================
   Access checks
========================= */

/**
 * Strict rules:
 * - Admin: always allowed
 * - PO: allowed (evaluator)
 * - PM: allowed only for own requests
 * - RP: allowed only when request is in ordering stage (SENT_TO_PO / ORDERED)
 * - SP: allowed only for their own offers
 */
async function canReadOffersForRequest({ user, requestId }) {
  if (isAdmin(user.role)) return { ok: true };

  // Must have username for any non-admin logic
  if (!user.username) return { ok: false, error: "Missing x-username" };

  // Load request to enforce PM/RP restrictions
  const reqDoc = await db.collection("requests").findOne(
    { _id: requestId }, // note: requestId is string id, requests._id is ObjectId in your system
    { projection: { createdBy: 1, status: 1 } },
  );

  // If requests are stored as ObjectId and requestId is string,
  // above query will fail. So we also try string match via _id string conversion:
  // We'll do the correct approach below using aggregation.
  // This helper returns a "reqMeta" object.

  return { ok: false, error: "Internal: use getRequestMeta()" };
}

/**
 * ✅ Robust: get request meta by requestId (string form of ObjectId)
 * because offers.requestId stores string while requests._id is ObjectId
 */
async function getRequestMetaByStringId(requestIdStr) {
  const arr = await db
    .collection("requests")
    .aggregate([
      { $match: { $expr: { $eq: [{ $toString: "$_id" }, requestIdStr] } } },
      { $project: { createdBy: 1, status: 1 } },
      { $limit: 1 },
    ])
    .toArray();

  return arr?.[0] || null;
}

function isOrderingStage(status) {
  const st = String(status || "").toUpperCase();
  return st === "SENT_TO_PO" || st === "ORDERED";
}

/* =========================
   ✅ MAIN: GET /api/offers?requestId=...
========================= */
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const requestId = String(req.query.requestId || "").trim();
    if (!requestId) return res.status(400).json({ error: "requestId missing" });

    // ✅ Admin can read
    if (isAdmin(user.role)) {
      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ data: offers });
    }

    // ✅ everyone else must have username
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    // ✅ PO (evaluator) can read offers for evaluation
    if (isPO(user.role)) {
      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ data: offers });
    }

    // Need request meta for PM and RP restrictions
    const reqMeta = await getRequestMetaByStringId(requestId);
    if (!reqMeta) return res.status(404).json({ error: "Request not found" });

    // ✅ PM: only their own requests
    if (isPM(user.role)) {
      if (
        normalizeUsername(reqMeta.createdBy) !==
        normalizeUsername(user.username)
      )
        return res.status(403).json({ error: "Not allowed" });

      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();

      return res.json({ data: offers });
    }

    // ✅ RP (ordering): only when request is in ordering stage
    if (isRP(user.role)) {
      if (!isOrderingStage(reqMeta.status)) {
        return res.status(403).json({
          error:
            "Not allowed (ordering role can view offers only in ordering stage)",
          status: String(reqMeta.status || ""),
        });
      }

      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();

      return res.json({ data: offers });
    }

    // ✅ Service Provider: only their own offers
    if (isSP(user.role)) {
      const me = normalizeUsername(user.username);
      const offers = await db
        .collection("offers")
        .find({ requestId, providerUsername: me })
        .sort({ createdAt: -1 })
        .toArray();

      return res.json({ data: offers });
    }

    return res.status(403).json({ error: "Not allowed" });
  } catch (e) {
    console.error("offers list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   ✅ ALIAS: GET /api/offers/by-request/:requestId
========================= */
router.get("/by-request/:requestId", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const requestId = String(req.params.requestId || "").trim();
    if (!requestId) return res.status(400).json({ error: "requestId missing" });

    // Reuse same logic by internally calling the main handler pattern
    // (keep it simple here: duplicate minimal logic)

    if (isAdmin(user.role)) {
      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ data: offers });
    }

    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    if (isPO(user.role)) {
      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ data: offers });
    }

    const reqMeta = await getRequestMetaByStringId(requestId);
    if (!reqMeta) return res.status(404).json({ error: "Request not found" });

    if (isPM(user.role)) {
      if (
        normalizeUsername(reqMeta.createdBy) !==
        normalizeUsername(user.username)
      )
        return res.status(403).json({ error: "Not allowed" });

      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ data: offers });
    }

    if (isRP(user.role)) {
      if (!isOrderingStage(reqMeta.status)) {
        return res.status(403).json({
          error:
            "Not allowed (ordering role can view offers only in ordering stage)",
          status: String(reqMeta.status || ""),
        });
      }

      const offers = await db
        .collection("offers")
        .find({ requestId })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ data: offers });
    }

    if (isSP(user.role)) {
      const me = normalizeUsername(user.username);
      const offers = await db
        .collection("offers")
        .find({ requestId, providerUsername: me })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ data: offers });
    }

    return res.status(403).json({ error: "Not allowed" });
  } catch (e) {
    console.error("offers by-request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
