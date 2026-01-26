import express from "express";
import { db } from "../db.js";

const router = express.Router();

/* =========================
   No-cache
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
   Helpers
========================= */
function normalizeRole(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const upper = s.toUpperCase().replace(/\s+/g, "_");
  const noUnderscore = upper.replace(/_/g, "");

  const map = {
    PROCUREMENTOFFICER: "PROCUREMENT_OFFICER",
    PROCUREMENT_OFFICER: "PROCUREMENT_OFFICER",
    SYSTEMADMIN: "SYSTEM_ADMIN",
    SYSTEM_ADMIN: "SYSTEM_ADMIN",
    ADMIN: "SYSTEM_ADMIN",
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

function canUse(role) {
  return role === "PROCUREMENT_OFFICER" || role === "SYSTEM_ADMIN";
}

const COLL = "po_evaluations";

/* =========================
   Core handlers (shared)
========================= */
async function handleGet(req, res) {
  const user = getUser(req);
  if (user.error) return res.status(401).json({ error: user.error });
  if (!canUse(user.role)) return res.status(403).json({ error: "Not allowed" });

  const requestId = String(req.params.requestId || "").trim();
  if (!requestId) return res.status(400).json({ error: "requestId missing" });

  const doc = await db.collection(COLL).findOne({ requestId });
  return res.json(doc || null);
}

async function handlePost(req, res) {
  const user = getUser(req);
  if (user.error) return res.status(401).json({ error: user.error });
  if (!canUse(user.role)) return res.status(403).json({ error: "Not allowed" });

  if (!user.username)
    return res.status(401).json({ error: "Missing x-username" });

  const requestId = String(req.params.requestId || "").trim();
  if (!requestId) return res.status(400).json({ error: "requestId missing" });

  const now = new Date();
  const body = req.body || {};

  const doc = {
    requestId,
    savedBy: user.username, // PO username
    weights: body.weights || { price: 0.6, delivery: 0.25, quality: 0.15 },
    comment: String(body.comment || ""),
    recommendedOfferId: String(body.recommendedOfferId || ""),
    offers: Array.isArray(body.offers) ? body.offers : [],
    updatedAt: now,
  };

  await db
    .collection(COLL)
    .updateOne(
      { requestId },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

  const saved = await db.collection(COLL).findOne({ requestId });
  return res.json({ success: true, data: saved });
}

/* =========================
   ✅ NEW ROUTES: /api/po-evaluations/:requestId
========================= */
router.get("/po/:requestId", async (req, res) => {
  try {
    return await handleGet(req, res);
  } catch (e) {
    console.error("po-evaluations get error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/po/:requestId", async (req, res) => {
  try {
    return await handlePost(req, res);
  } catch (e) {
    console.error("po-evaluations save error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   ✅ BACKWARD COMPAT (old routes still work)
   /api/rp-evaluations/:requestId  -> uses po_evaluations
========================= */
router.get("/:requestId", async (req, res) => {
  try {
    return await handleGet(req, res);
  } catch (e) {
    console.error("legacy rp-evaluations get error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/:requestId", async (req, res) => {
  try {
    return await handlePost(req, res);
  } catch (e) {
    console.error("legacy rp-evaluations save error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
