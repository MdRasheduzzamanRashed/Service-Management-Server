// routes/requests.js
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
    SYSTEMADMINISTRATOR: "SYSTEM_ADMIN",
    SYSTEM_ADMINISTRATOR: "SYSTEM_ADMIN",
  };

  return map[noUnderscore] || map[upper] || upper;
}

function getUser(req) {
  const role = normalizeRole(req.headers["x-user-role"]);
  if (!role) return { error: "Missing x-user-role" };
  return { role };
}

function canReadAll(role) {
  return (
    role === "PROJECT_MANAGER" ||
    role === "PROCUREMENT_OFFICER" ||
    role === "RESOURCE_PLANNER" ||
    role === "SYSTEM_ADMIN"
  );
}

function canCreate(role) {
  return role === "PROJECT_MANAGER";
}

// POST /api/requests
router.post("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!canCreate(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can create requests" });
    }

    const body = req.body || {};
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const doc = {
      ...body,
      status: "DRAFT",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("requests").insertOne(doc);
    return res.json({ success: true, id: result.insertedId });
  } catch (e) {
    console.error("Create request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/requests
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!canReadAll(user.role)) {
      return res.status(403).json({ error: "Not allowed to view requests." });
    }

    const status = (req.query.status || "").toString().trim();
    const query = status ? { status } : {};

    const list = await db
      .collection("requests")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("List requests error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/requests/:id
router.get("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!canReadAll(user.role)) {
      return res.status(403).json({ error: "Not allowed to view requests." });
    }

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    return res.json(doc);
  } catch (e) {
    console.error("Load request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/requests/:id
router.put("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!canCreate(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can update requests" });
    }

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (String(existing.status || "").toUpperCase() !== "DRAFT") {
      return res
        .status(403)
        .json({ error: "Only DRAFT requests can be edited" });
    }

    await db
      .collection("requests")
      .updateOne({ _id: id }, { $set: { ...req.body, updatedAt: new Date() } });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("Update request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/requests/:id
router.delete("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!canCreate(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can delete requests" });
    }

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (String(existing.status || "").toUpperCase() !== "DRAFT") {
      return res
        .status(403)
        .json({ error: "Only DRAFT requests can be deleted" });
    }

    await db.collection("requests").deleteOne({ _id: id });
    return res.json({ success: true });
  } catch (e) {
    console.error("Delete request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
