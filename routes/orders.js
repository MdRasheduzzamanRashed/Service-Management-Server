// routes/orders.js
import express from "express";
import { ObjectId } from "mongodb";
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

function parseId(v) {
  try {
    return new ObjectId(String(v));
  } catch {
    return null;
  }
}

/**
 * ✅ Swapped workflow:
 * ORDERING role is RESOURCE_PLANNER
 */
function isOrderingRole(role) {
  return role === "RESOURCE_PLANNER";
}
function isPM(role) {
  return role === "PROJECT_MANAGER";
}
function isAdmin(role) {
  return role === "SYSTEM_ADMIN";
}

/* =========================================================
   ✅ GET MY ORDERS (Ordering role only => RP)
   GET /api/orders/my
========================================================= */
router.get("/my", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isOrderingRole(user.role)) {
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can view My Orders" });
    }

    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const me = normalizeUsername(user.username);

    const list = await db
      .collection("purchase_orders")
      .find({ orderedBy: me })
      .sort({ orderedAt: -1, createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("orders/my error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ✅ LIST ORDERS (restricted)
   GET /api/orders?requestId=...
   - Admin: can list all (or filtered)
   - PM: only orders for requests createdBy = PM
   - RP (ordering): only their own orders
========================================================= */
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const role = user.role;
    const me = normalizeUsername(user.username);

    const requestId = String(req.query.requestId || "").trim();

    // Base filter (optional by requestId)
    const baseQuery = {};
    if (requestId) baseQuery.requestId = requestId;

    // ✅ Admin can view everything
    if (isAdmin(role)) {
      const list = await db
        .collection("purchase_orders")
        .find(baseQuery)
        .sort({ orderedAt: -1, createdAt: -1 })
        .toArray();
      return res.json(list);
    }

    // ✅ Ordering role (RP): only their own orders
    if (isOrderingRole(role)) {
      const q = { ...baseQuery, orderedBy: me };
      const list = await db
        .collection("purchase_orders")
        .find(q)
        .sort({ orderedAt: -1, createdAt: -1 })
        .toArray();
      return res.json(list);
    }

    // ✅ PM: only orders for PM's own requests
    if (isPM(role)) {
      // If your purchase_orders already store pmUsername, use it (faster):
      // const qFast = { ...baseQuery, pmUsername: me };
      // const list = await db.collection("purchase_orders").find(qFast).sort({ orderedAt: -1, createdAt: -1 }).toArray();
      // return res.json(list);

      // Otherwise: derive allowed requestIds (works with your current schema)
      const myRequests = await db
        .collection("requests")
        .find({ createdBy: me }, { projection: { _id: 1 } })
        .toArray();

      const myRequestIds = myRequests.map((r) => String(r._id));

      // If requestId was provided, ensure PM owns that request
      if (requestId && !myRequestIds.includes(requestId)) {
        return res.status(403).json({ error: "Not allowed" });
      }

      const q = { ...baseQuery };
      q.requestId = requestId
        ? requestId
        : { $in: myRequestIds.length ? myRequestIds : ["__none__"] };

      const list = await db
        .collection("purchase_orders")
        .find(q)
        .sort({ orderedAt: -1, createdAt: -1 })
        .toArray();

      return res.json(list);
    }

    // ❌ PO and others: blocked
    return res.status(403).json({ error: "Not allowed" });
  } catch (e) {
    console.error("orders list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ✅ GET SINGLE ORDER (restricted)
   GET /api/orders/:id
   - Admin: any
   - RP: only if orderedBy == me
   - PM: only if request belongs to PM
========================================================= */
router.get("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const role = user.role;
    const me = normalizeUsername(user.username);

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid order id" });

    const doc = await db.collection("purchase_orders").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Order not found" });

    // ✅ Admin: allow
    if (isAdmin(role)) return res.json(doc);

    // ✅ RP: only own order
    if (isOrderingRole(role)) {
      if (normalizeUsername(doc.orderedBy) !== me) {
        return res.status(403).json({ error: "Not allowed" });
      }
      return res.json(doc);
    }

    // ✅ PM: only if PM owns the request
    if (isPM(role)) {
      const reqId = String(doc.requestId || "").trim();
      if (!reqId) return res.status(403).json({ error: "Not allowed" });

      const rid = parseId(reqId);
      if (!rid) return res.status(403).json({ error: "Not allowed" });

      const reqDoc = await db
        .collection("requests")
        .findOne({ _id: rid }, { projection: { createdBy: 1 } });

      if (!reqDoc) return res.status(403).json({ error: "Not allowed" });
      if (normalizeUsername(reqDoc.createdBy) !== me) {
        return res.status(403).json({ error: "Not allowed" });
      }

      return res.json(doc);
    }

    // ❌ PO and others: blocked
    return res.status(403).json({ error: "Not allowed" });
  } catch (e) {
    console.error("order get error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
