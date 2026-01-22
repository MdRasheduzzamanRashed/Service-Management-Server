import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

/* =========================
   Helpers
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

function parseId(v) {
  try {
    return new ObjectId(String(v));
  } catch {
    return null;
  }
}

function isPO(role) {
  return role === "PROCUREMENT_OFFICER";
}

function canReadOrders(role) {
  // You said only PO needs order button,
  // but PM/RP can still VIEW orders if you want.
  // If you want PO-only viewing, return isPO(role) only.
  return (
    role === "PROCUREMENT_OFFICER" ||
    role === "PROJECT_MANAGER" ||
    role === "RESOURCE_PLANNER" ||
    role === "SYSTEM_ADMIN"
  );
}

/* =========================================================
   ✅ GET MY ORDERS (PO only)
   GET /api/orders/my
========================================================= */
router.get("/my", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isPO(user.role))
      return res.status(403).json({ error: "Only PO can view My Orders" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const list = await db
      .collection("purchase_orders")
      .find({ orderedBy: user.username })
      .sort({ orderedAt: -1, createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("orders/my error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ✅ LIST ORDERS (optional)
   GET /api/orders?requestId=...
========================================================= */
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadOrders(user.role))
      return res.status(403).json({ error: "Not allowed" });

    const requestId = String(req.query.requestId || "").trim();

    const query = {};
    if (requestId) query.requestId = requestId;

    const list = await db
      .collection("purchase_orders")
      .find(query)
      .sort({ orderedAt: -1, createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("orders list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ✅ GET SINGLE ORDER
   GET /api/orders/:id
========================================================= */
router.get("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadOrders(user.role))
      return res.status(403).json({ error: "Not allowed" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid order id" });

    const doc = await db.collection("purchase_orders").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Order not found" });

    // If you want strict PO-only access:
    // if (isPO(user.role) && normalizeUsername(doc.orderedBy) !== user.username) return res.status(403).json({ error: "Not allowed" });

    return res.json(doc);
  } catch (e) {
    console.error("order get error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
