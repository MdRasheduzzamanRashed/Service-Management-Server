// routes/requests.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

/**
 * STATUS FLOW:
 * PM: DRAFT (create/edit/delete) -> submit-for-review -> IN_REVIEW
 * RP: IN_REVIEW -> rp-approve -> APPROVED_FOR_SUBMISSION
 * RP: IN_REVIEW -> rp-reject  -> REJECTED
 * PM: APPROVED_FOR_SUBMISSION -> submit-for-bidding -> BIDDING
 */
const STATUS = {
  DRAFT: "DRAFT",
  IN_REVIEW: "IN_REVIEW",
  APPROVED_FOR_SUBMISSION: "APPROVED_FOR_SUBMISSION",
  BIDDING: "BIDDING",
  REJECTED: "REJECTED",
};

/* ================================
   AUTH HELPERS
   Requires headers:
   - x-user-role
   - x-username   (needed for "my requests" + ownership checks)
================================== */

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

function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

function getUser(req) {
  const role = normalizeRole(req.headers["x-user-role"]);
  if (!role) return { error: "Missing x-user-role" };

  const username = normalizeUsername(req.headers["x-username"]);
  const userId = String(req.headers["x-user-id"] || "").trim();

  return { role, username, userId };
}

function canReadAll(role) {
  return (
    role === "PROJECT_MANAGER" ||
    role === "PROCUREMENT_OFFICER" ||
    role === "RESOURCE_PLANNER" ||
    role === "SYSTEM_ADMIN"
  );
}

function isPM(role) {
  return role === "PROJECT_MANAGER";
}

function isRP(role) {
  return role === "RESOURCE_PLANNER";
}

function parseId(idStr) {
  try {
    return new ObjectId(idStr);
  } catch {
    return null;
  }
}

function isOwner(doc, user) {
  const u = normalizeUsername(user?.username);
  const id = String(user?.userId || "").trim();

  const docU = normalizeUsername(doc?.createdBy);
  const docId = String(doc?.createdById || "").trim();

  return (!!u && docU && u === docU) || (!!id && docId && id === docId);
}


/* ================================
   CREATE (PM only) -> DRAFT
================================== */
// POST /api/requests
router.post("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can create requests" });
    }

    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const body = req.body || {};
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const doc = {
      ...body,
      status: STATUS.DRAFT,

      createdBy: user.username, // ✅ username
      createdById: user.userId, // ✅ user _id (string)

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

/* ================================
   LIST
   - PM/RP/PO/System can read
   - supports:
     ?status=IN_REVIEW
     ?view=my   (PM only -> returns only own)
================================== */
// GET /api/requests
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!canReadAll(user.role)) {
      return res.status(403).json({ error: "Not allowed to view requests." });
    }

    const status = String(req.query.status || "").trim();
    const view = String(req.query.view || "")
      .trim()
      .toLowerCase();

    const query = {};
    if (status) query.status = status;

    // ✅ My Requests (PM only)
    if (view === "my") {
      if (!isPM(user.role)) {
        return res
          .status(403)
          .json({ error: "Only PROJECT_MANAGER can use view=my" });
      }

      const ors = [];
      if (user.username) ors.push({ createdBy: user.username });
      if (user.userId) ors.push({ createdById: user.userId });

      if (ors.length === 0) {
        return res
          .status(401)
          .json({ error: "Missing x-username or x-user-id" });
      }

      query.$or = ors;
    }


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

/* ================================
   GET ONE
   - PM can read own, and also read all (as your rule)
   - For simplicity: all allowed roles can read any.
   - If you want PM only own, uncomment the owner check.
================================== */
// GET /api/requests/:id
router.get("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!canReadAll(user.role)) {
      return res.status(403).json({ error: "Not allowed to view requests." });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    // OPTIONAL: If you want PM to view ONLY own details:
    // if (isPM(user.role) && !isOwner(doc, user.username)) {
    //   return res.status(403).json({ error: "Not allowed" });
    // }

    return res.json(doc);
  } catch (e) {
    console.error("Load request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   UPDATE (PM only, only own, only DRAFT)
================================== */
// PUT /api/requests/:id
router.put("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can update requests" });
    }

    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (!isOwner(existing, user))
      return res.status(403).json({ error: "Not allowed" });


    if (String(existing.status || "").toUpperCase() !== STATUS.DRAFT) {
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

/* ================================
   DELETE (PM only, only own, only DRAFT)
================================== */
// DELETE /api/requests/:id
router.delete("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can delete requests" });
    }

    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (!isOwner(existing, user.username)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (String(existing.status || "").toUpperCase() !== STATUS.DRAFT) {
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

/* ================================
   TRANSITIONS
================================== */

/**
 * PM: DRAFT -> IN_REVIEW
 * POST /api/requests/:id/submit-for-review
 */
router.post("/:id/submit-for-review", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can submit for review" });
    }
    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!isOwner(doc, user.username)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (String(doc.status || "").toUpperCase() !== STATUS.DRAFT) {
      return res
        .status(403)
        .json({ error: "Only DRAFT can be submitted for review" });
    }

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.IN_REVIEW,
          submittedAt: new Date(),
          submittedBy: user.username,
          updatedAt: new Date(),
        },
      },
    );

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("submit-for-review error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * RP: IN_REVIEW -> APPROVED_FOR_SUBMISSION
 * POST /api/requests/:id/rp-approve
 */
router.post("/:id/rp-approve", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isRP(user.role)) {
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can approve" });
    }
    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (String(doc.status || "").toUpperCase() !== STATUS.IN_REVIEW) {
      return res
        .status(403)
        .json({ error: "Only IN_REVIEW requests can be approved" });
    }

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.APPROVED_FOR_SUBMISSION,
          rpApprovedAt: new Date(),
          rpApprovedBy: user.username,
          updatedAt: new Date(),
        },
      },
    );

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("rp-approve error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * RP: IN_REVIEW -> REJECTED
 * POST /api/requests/:id/rp-reject
 * body: { reason?: string }
 */
router.post("/:id/rp-reject", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isRP(user.role)) {
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can reject" });
    }
    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (String(doc.status || "").toUpperCase() !== STATUS.IN_REVIEW) {
      return res
        .status(403)
        .json({ error: "Only IN_REVIEW requests can be rejected" });
    }

    const reason = String(req.body?.reason || "").trim();

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.REJECTED,
          rpRejectedAt: new Date(),
          rpRejectedBy: user.username,
          rpRejectReason: reason,
          updatedAt: new Date(),
        },
      },
    );

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("rp-reject error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * PM: APPROVED_FOR_SUBMISSION -> BIDDING
 * POST /api/requests/:id/submit-for-bidding
 */
router.post("/:id/submit-for-bidding", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can submit for bidding" });
    }
    if (!user.username) {
      return res.status(401).json({ error: "Missing x-username" });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!isOwner(doc, user.username)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (
      String(doc.status || "").toUpperCase() !== STATUS.APPROVED_FOR_SUBMISSION
    ) {
      return res
        .status(403)
        .json({ error: "Only APPROVED_FOR_SUBMISSION can go to BIDDING" });
    }

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.BIDDING,
          biddingStartedAt: new Date(),
          biddingStartedBy: user.username,
          updatedAt: new Date(),
        },
      },
    );

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("submit-for-bidding error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
