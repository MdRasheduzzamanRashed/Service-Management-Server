import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

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

function canReadOffers(role) {
  return (
    role === "RESOURCE_PLANNER" ||
    role === "PROJECT_MANAGER" ||
    role === "PROCUREMENT_OFFICER" ||
    role === "SYSTEM_ADMIN"
  );
}

// ✅ GET /api/offers/by-request/:requestId
router.get("/by-request/:requestId", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadOffers(user.role))
      return res.status(403).json({ error: "Not allowed" });

    const requestId = String(req.params.requestId || "").trim();
    if (!requestId) return res.status(400).json({ error: "requestId missing" });

    const offers = await db
      .collection("offers")
      .find({ requestId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ data: offers });
  } catch (e) {
    console.error("offers by-request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
