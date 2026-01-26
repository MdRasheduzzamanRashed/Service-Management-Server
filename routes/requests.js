// routes/requests.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";
import { createNotification } from "../utils/notify.js";

const router = express.Router();

/**
 * ✅ SWAPPED RESPONSIBILITIES (as you requested)
 *
 * STATUS FLOW:
 * PM: DRAFT -> IN_REVIEW
 * PO: IN_REVIEW -> APPROVED_FOR_SUBMISSION or REJECTED        ✅ (was RP)
 * PM: APPROVED_FOR_SUBMISSION -> BIDDING
 * SYSTEM: BIDDING -> EXPIRED (auto)
 * AUTO: BIDDING -> BID_EVALUATION (when offersCount >= maxOffers)
 * PO: BID_EVALUATION -> RECOMMENDED (select best offer)       ✅ (was RP)
 * PM: RECOMMENDED -> SENT_TO_PO
 * RP: SENT_TO_PO -> ORDERED                                  ✅ (was PO)
 */
const STATUS = {
  DRAFT: "DRAFT",
  IN_REVIEW: "IN_REVIEW",
  APPROVED_FOR_SUBMISSION: "APPROVED_FOR_SUBMISSION",
  BIDDING: "BIDDING",
  BID_EVALUATION: "BID_EVALUATION",
  RECOMMENDED: "RECOMMENDED",
  SENT_TO_PO: "SENT_TO_PO",
  ORDERED: "ORDERED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
};

/* =========================
   Enterprise: No-cache for API
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
   Helpers (Auth + IDs)
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
  return { role, username };
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

/**
 * ✅ Role mapping AFTER swap:
 * - Reviewer (approve/reject IN_REVIEW): Procurement Officer (PO)
 * - Evaluator (recommend offer in BID_EVALUATION): Procurement Officer (PO)
 * - Ordering (ORDER after SENT_TO_PO): Resource Planner (RP)
 */
const ROLE_REVIEWER = "PROCUREMENT_OFFICER";
const ROLE_EVALUATOR = "PROCUREMENT_OFFICER";
const ROLE_ORDERING = "RESOURCE_PLANNER";

function isReviewer(role) {
  return role === ROLE_REVIEWER;
}
function isEvaluator(role) {
  return role === ROLE_EVALUATOR;
}
function isOrderingRole(role) {
  return role === ROLE_ORDERING;
}

function parseId(idStr) {
  try {
    return new ObjectId(String(idStr));
  } catch {
    return null;
  }
}

function isOwner(doc, username) {
  if (!username) return false;
  return normalizeUsername(doc?.createdBy) === normalizeUsername(username);
}

/* =========================
   Pagination helpers
========================= */
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* =========================
   Expiry helpers
========================= */
function computeBiddingEndsAt(doc) {
  if (!doc?.biddingStartedAt) return null;
  const days = Number(doc?.biddingCycleDays ?? 7);
  const start = new Date(doc.biddingStartedAt);
  if (Number.isNaN(start.getTime())) return null;
  const ends = new Date(start);
  ends.setDate(ends.getDate() + (Number.isFinite(days) ? days : 7));
  return ends;
}

async function ensureExpiredIfDue(doc) {
  if (!doc) return doc;

  const st = String(doc.status || "").toUpperCase();
  if (st !== STATUS.BIDDING) return doc;

  const endsAt = computeBiddingEndsAt(doc);
  if (!endsAt) return doc;

  const now = new Date();
  if (now < endsAt) return doc;

  if (String(doc.status || "").toUpperCase() === STATUS.EXPIRED) return doc;

  await db
    .collection("requests")
    .updateOne(
      { _id: doc._id, status: STATUS.BIDDING },
      { $set: { status: STATUS.EXPIRED, expiredAt: now, updatedAt: now } },
    );

  if (doc.createdBy) {
    const requestId = String(doc._id);
    await createNotification({
      uniqKey: `${requestId}:EXPIRED`,
      toUsername: doc.createdBy,
      type: "REQUEST_EXPIRED",
      title: "Request expired",
      message: `Your request "${doc.title || "Untitled"}" has expired after the bidding cycle.`,
      requestId,
    });
  }

  return await db.collection("requests").findOne({ _id: doc._id });
}

/* =========================
   Offers helpers (enterprise)
========================= */
async function autoCompleteBiddingIfEnoughOffers(reqDoc) {
  if (!reqDoc) return reqDoc;

  const st = String(reqDoc.status || "").toUpperCase();
  const requestId = String(reqDoc._id);

  const offersCount =
    typeof reqDoc.offersCount === "number"
      ? reqDoc.offersCount
      : await db.collection("offers").countDocuments({ requestId });

  if (st !== STATUS.BIDDING) return { ...reqDoc, offersCount };

  const maxOffers = Number(reqDoc.maxOffers ?? 0);
  if (!maxOffers || maxOffers <= 0) return { ...reqDoc, offersCount };

  if (offersCount >= maxOffers) {
    const now = new Date();

    await db.collection("requests").updateOne(
      { _id: reqDoc._id, status: STATUS.BIDDING },
      {
        $set: {
          status: STATUS.BID_EVALUATION,
          bidEvaluationAt: now,
          updatedAt: now,
        },
      },
    );

    if (reqDoc.createdBy) {
      await createNotification({
        uniqKey: `${requestId}:AUTO_TO_BID_EVAL_PM`,
        toUsername: reqDoc.createdBy,
        type: "REQUEST_STATUS",
        title: "Bidding completed",
        message: `Your request "${reqDoc.title || "Untitled"}" moved to BID_EVALUATION (offers reached max).`,
        requestId,
      });
    }

    await createNotification({
      uniqKey: `${requestId}:AUTO_TO_BID_EVAL_EVALUATOR`,
      toRole: ROLE_EVALUATOR,
      type: "REQUEST_STATUS",
      title: "Requests ready for evaluation",
      message: `Request "${reqDoc.title || "Untitled"}" is now in BID_EVALUATION.`,
      requestId,
    });

    return { ...reqDoc, status: STATUS.BID_EVALUATION, offersCount };
  }

  return { ...reqDoc, offersCount };
}

/* =========================
   Aggregation: attach offersCount fast
========================= */
function addOffersCountPipeline(match) {
  return [
    { $match: match || {} },
    {
      $lookup: {
        from: "offers",
        let: { rid: { $toString: "$_id" } },
        pipeline: [
          { $match: { $expr: { $eq: ["$requestId", "$$rid"] } } },
          { $project: { _id: 1 } },
        ],
        as: "__offers",
      },
    },
    { $addFields: { offersCount: { $size: "$__offers" } } },
    { $project: { __offers: 0 } },
  ];
}

/* ================================
   CREATE (PM only) -> DRAFT
================================== */
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
      createdBy: normalizeUsername(user.username),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("requests").insertOne(doc);

    await createNotification({
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Request created",
      message: `You created a new request "${doc.title || "Untitled"}" (DRAFT).`,
      requestId: String(result.insertedId),
    });

    return res.json({ success: true, id: String(result.insertedId) });
  } catch (e) {
    console.error("Create request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   LIST (admin/pm/rp/po)
   Returns: { data, meta }
================================== */
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadAll(user.role)) {
      return res.status(403).json({ error: "Not allowed to view requests." });
    }

    const status = String(req.query.status || "")
      .trim()
      .toUpperCase();
    const view = String(req.query.view || "")
      .trim()
      .toLowerCase();
    const q = String(req.query.q || "").trim();

    const page = clampInt(req.query.page, 1, 1, 1000000);
    const limit = clampInt(req.query.limit, 50, 1, 100);
    const skip = (page - 1) * limit;

    const match = {};
    if (status) match.status = status;

    if (view === "my") {
      if (!isPM(user.role)) {
        return res
          .status(403)
          .json({ error: "Only PROJECT_MANAGER can use view=my" });
      }
      if (!user.username) {
        return res.status(401).json({ error: "Missing x-username" });
      }
      match.createdBy = normalizeUsername(user.username);
    }

    if (q) {
      const safe = escapeRegex(q);
      const rx = new RegExp(safe, "i");
      match.$or = [
        { title: rx },
        { projectId: rx },
        { projectName: rx },
        { contractSupplier: rx },
        { createdBy: rx },
        { type: rx },
        { performanceLocation: rx },
      ];
    }

    const total = await db.collection("requests").countDocuments(match);

    const pipeline = [
      ...addOffersCountPipeline(match),
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const list = await db.collection("requests").aggregate(pipeline).toArray();

    const enhanced = await Promise.all(
      (list || []).map(async (r) => {
        const afterExpire = await ensureExpiredIfDue(r);
        const afterAuto = await autoCompleteBiddingIfEnoughOffers(afterExpire);
        return afterAuto;
      }),
    );

    return res.json({
      data: enhanced,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (e) {
    console.error("List requests error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   LIST BIDDING (Public)
================================== */
router.get("/bidding", async (req, res) => {
  try {
    const match = { status: STATUS.BIDDING };

    const pipeline = [
      ...addOffersCountPipeline(match),
      {
        $project: {
          title: 1,
          status: 1,
          createdAt: 1,
          biddingStartedAt: 1,
          biddingCycleDays: 1,
          maxOffers: 1,
          roles: 1,
          requiredLanguages: 1,
          mustHaveCriteria: 1,
          niceToHaveCriteria: 1,
          performanceLocation: 1,
          startDate: 1,
          endDate: 1,
          projectId: 1,
          projectName: 1,
          offersCount: 1,
        },
      },
      { $sort: { biddingStartedAt: -1, createdAt: -1 } },
    ];

    const list = await db.collection("requests").aggregate(pipeline).toArray();
    if (!list.length) return res.json({ data: [], meta: { total: 0 } });

    const enhanced = await Promise.all(
      list.map(async (r) => {
        const afterExpire = await ensureExpiredIfDue(r);
        const afterAuto = await autoCompleteBiddingIfEnoughOffers(afterExpire);
        return afterAuto;
      }),
    );

    return res.json({ data: enhanced, meta: { total: enhanced.length } });
  } catch (e) {
    console.error("Public bidding error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   LIST BID_EVALUATION
================================== */
router.get("/bid-evaluation", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadAll(user.role))
      return res.status(403).json({ error: "Not allowed" });

    const pipeline = [
      ...addOffersCountPipeline({ status: STATUS.BID_EVALUATION }),
      { $sort: { bidEvaluationAt: -1, createdAt: -1 } },
    ];

    const list = await db.collection("requests").aggregate(pipeline).toArray();
    return res.json({ data: list, meta: { total: list.length } });
  } catch (e) {
    console.error("bid-evaluation list error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   GET ONE
================================== */
router.get("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadAll(user.role)) {
      return res.status(403).json({ error: "Not allowed to view requests." });
    }

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const pipeline = [...addOffersCountPipeline({ _id: id }), { $limit: 1 }];

    const arr = await db.collection("requests").aggregate(pipeline).toArray();
    const doc = arr?.[0];
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const afterExpire = await ensureExpiredIfDue(doc);
    const afterAuto = await autoCompleteBiddingIfEnoughOffers(afterExpire);

    return res.json(afterAuto);
  } catch (e) {
    console.error("Load request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   UPDATE (PM own + DRAFT only)
================================== */
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

    if (!isOwner(existing, user.username))
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
   DELETE (PM own + DRAFT only)
================================== */
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

    if (!isOwner(existing, user.username))
      return res.status(403).json({ error: "Not allowed" });

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

// PM: DRAFT -> IN_REVIEW
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
    if (!isOwner(doc, user.username))
      return res.status(403).json({ error: "Not allowed" });

    if (String(doc.status || "").toUpperCase() !== STATUS.DRAFT) {
      return res
        .status(403)
        .json({ error: "Only DRAFT can be submitted for review" });
    }

    const now = new Date();

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.IN_REVIEW,
          submittedAt: now,
          submittedBy: normalizeUsername(user.username),
          updatedAt: now,
        },
      },
    );

    await createNotification({
      uniqKey: `${String(id)}:SUBMITTED_FOR_REVIEW_REVIEWER`,
      toRole: ROLE_REVIEWER,
      type: "REQUEST_STATUS",
      title: "New request in review",
      message: `Request "${doc.title || "Untitled"}" submitted for review.`,
      requestId: String(id),
    });

    await createNotification({
      uniqKey: `${String(id)}:SUBMITTED_FOR_REVIEW_PM`,
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Submitted for review",
      message: `Your request "${doc.title || "Untitled"}" is now IN_REVIEW.`,
      requestId: String(id),
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("submit-for-review error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Reviewer (swapped): IN_REVIEW -> APPROVED_FOR_SUBMISSION
router.post("/:id/rp-approve", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isReviewer(user.role)) {
      return res
        .status(403)
        .json({ error: `Only ${ROLE_REVIEWER} can approve` });
    }

    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (String(doc.status || "").toUpperCase() !== STATUS.IN_REVIEW) {
      return res
        .status(403)
        .json({ error: "Only IN_REVIEW requests can be approved" });
    }

    const now = new Date();

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.APPROVED_FOR_SUBMISSION,
          rpApprovedAt: now,
          rpApprovedBy: normalizeUsername(user.username),
          updatedAt: now,
        },
      },
    );

    await createNotification({
      uniqKey: `${String(id)}:REVIEW_APPROVED`,
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Request approved",
      message: `Your request "${doc.title || "Untitled"}" was approved for submission.`,
      requestId: String(id),
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("rp-approve error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Reviewer (swapped): IN_REVIEW -> REJECTED
router.post("/:id/rp-reject", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isReviewer(user.role)) {
      return res
        .status(403)
        .json({ error: `Only ${ROLE_REVIEWER} can reject` });
    }

    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

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
    const now = new Date();

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.REJECTED,
          rpRejectedAt: now,
          rpRejectedBy: normalizeUsername(user.username),
          rpRejectReason: reason,
          updatedAt: now,
        },
      },
    );

    await createNotification({
      uniqKey: `${String(id)}:REVIEW_REJECTED`,
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Request rejected",
      message: `Your request "${doc.title || "Untitled"}" was rejected. ${
        reason ? `Reason: ${reason}` : ""
      }`.trim(),
      requestId: String(id),
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("rp-reject error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// PM: APPROVED_FOR_SUBMISSION -> BIDDING
router.post("/:id/submit-for-bidding", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can submit for bidding" });
    }
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });
    if (!isOwner(doc, user.username))
      return res.status(403).json({ error: "Not allowed" });

    if (
      String(doc.status || "").toUpperCase() !== STATUS.APPROVED_FOR_SUBMISSION
    ) {
      return res
        .status(403)
        .json({ error: "Only APPROVED_FOR_SUBMISSION can go to BIDDING" });
    }

    const now = new Date();

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.BIDDING,
          biddingStartedAt: now,
          biddingStartedBy: normalizeUsername(user.username),
          updatedAt: now,
        },
      },
    );

    await createNotification({
      uniqKey: `${String(id)}:BIDDING_OPEN_SP`,
      toRole: "SERVICE_PROVIDER",
      type: "REQUEST_STATUS",
      title: "New bidding request",
      message: `New request "${doc.title || "Untitled"}" is open for bidding.`,
      requestId: String(id),
    });

    await createNotification({
      uniqKey: `${String(id)}:BIDDING_OPEN_PM`,
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Bidding started",
      message: `Your request "${doc.title || "Untitled"}" is now BIDDING.`,
      requestId: String(id),
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("submit-for-bidding error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// PM: EXPIRED -> APPROVED_FOR_SUBMISSION
router.post("/:id/reactivate", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can reactivate" });
    }
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });
    if (!isOwner(doc, user.username))
      return res.status(403).json({ error: "Not allowed" });

    if (String(doc.status || "").toUpperCase() !== STATUS.EXPIRED) {
      return res
        .status(403)
        .json({ error: "Only EXPIRED requests can be reactivated" });
    }

    const now = new Date();

    await db.collection("requests").updateOne(
      { _id: id, status: STATUS.EXPIRED },
      {
        $set: {
          status: STATUS.APPROVED_FOR_SUBMISSION,
          reactivatedAt: now,
          reactivatedBy: normalizeUsername(user.username),
          updatedAt: now,
        },
        $unset: {
          biddingStartedAt: "",
          biddingStartedBy: "",
          expiredAt: "",
        },
      },
    );

    await createNotification({
      uniqKey: `${String(id)}:REACTIVATED`,
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Request reactivated",
      message: `Your request "${doc.title || "Untitled"}" was reactivated to APPROVED_FOR_SUBMISSION.`,
      requestId: String(id),
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("reactivate error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   ✅ Evaluator swapped: BID_EVALUATION -> RECOMMENDED
   Supports BOTH routes:
   - POST /api/requests/:id/po-recommend-offer (new, matches frontend)
================================== */
async function recommendOfferHandler(req, res) {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isEvaluator(user.role)) {
      return res
        .status(403)
        .json({ error: `Only ${ROLE_EVALUATOR} can recommend` });
    }
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    let doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    doc = await ensureExpiredIfDue(doc);
    doc = await autoCompleteBiddingIfEnoughOffers(doc);

    const st = String(doc.status || "").toUpperCase();
    if (st !== STATUS.BID_EVALUATION) {
      return res
        .status(403)
        .json({ error: "Only BID_EVALUATION can be recommended" });
    }

    const offerId = String(req.body?.offerId || "").trim();
    if (!offerId) return res.status(400).json({ error: "offerId is required" });

    const offerObjId = parseId(offerId);
    if (!offerObjId) return res.status(400).json({ error: "Invalid offerId" });

    const offer = await db.collection("offers").findOne({ _id: offerObjId });
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    if (String(offer.requestId) !== String(doc._id)) {
      return res
        .status(403)
        .json({ error: "Offer does not belong to this request" });
    }

    const now = new Date();

    // reset previously recommended offer(s)
    await db
      .collection("offers")
      .updateMany(
        { requestId: String(doc._id), status: "RECOMMENDED" },
        { $set: { status: "SUBMITTED", updatedAt: now } },
      );

    // mark selected offer as recommended
    await db
      .collection("offers")
      .updateOne(
        { _id: offerObjId },
        { $set: { status: "RECOMMENDED", updatedAt: now } },
      );

    // update request status
    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.RECOMMENDED,
          recommendedOfferId: String(offerObjId),
          recommendedAt: now,
          recommendedBy: normalizeUsername(user.username),
          updatedAt: now,
        },
      },
    );

    // notify PM owner
    await createNotification({
      uniqKey: `${String(id)}:RECOMMENDED_PM`,
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Offer recommended",
      message: `Request "${doc.title || "Untitled"}" is now RECOMMENDED.`,
      requestId: String(id),
    });

    // notify ordering role (RP)
    await createNotification({
      uniqKey: `${String(id)}:RECOMMENDED_ORDERING_ROLE`,
      toRole: ROLE_ORDERING,
      type: "REQUEST_STATUS",
      title: "Upcoming order request",
      message: `Request "${doc.title || "Untitled"}" is RECOMMENDED (PM may send for ordering soon).`,
      requestId: String(id),
    });

    const updatedRequest = await db.collection("requests").findOne({ _id: id });
    const updatedOffers = await db
      .collection("offers")
      .find({ requestId: String(doc._id) })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({
      success: true,
      request: updatedRequest,
      offers: updatedOffers,
    });
  } catch (e) {
    console.error("recommend-offer error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}

// ✅ new route (matches frontend)
router.post("/:id/po-recommend-offer", recommendOfferHandler);

/* ================================
   PM: RECOMMENDED -> SENT_TO_PO
================================== */
router.post("/:id/send-to-po", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isPM(user.role))
      return res.status(403).json({ error: "Only PROJECT_MANAGER" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });
    if (!isOwner(doc, user.username))
      return res.status(403).json({ error: "Not allowed" });

    if (String(doc.status || "").toUpperCase() !== STATUS.RECOMMENDED) {
      return res
        .status(403)
        .json({ error: "Only RECOMMENDED can be sent to PO" });
    }

    const now = new Date();

    await db.collection("requests").updateOne(
      { _id: id, status: STATUS.RECOMMENDED },
      {
        $set: {
          status: STATUS.SENT_TO_PO,
          sentToPoAt: now,
          sentToPoBy: normalizeUsername(user.username),
          updatedAt: now,
        },
      },
    );

    // swapped: notify ordering role (RP)
    await createNotification({
      uniqKey: `${String(id)}:SENT_TO_PO`,
      toRole: ROLE_ORDERING,
      type: "REQUEST_SENT_TO_PO",
      title: "New request for ordering",
      message: `A request "${doc.title || "Untitled"}" is ready for ordering.`,
      requestId: String(doc._id),
    });

    await createNotification({
      uniqKey: `${String(id)}:SENT_TO_PO_PM`,
      toUsername: doc.createdBy,
      type: "REQUEST_STATUS",
      title: "Sent to procurement",
      message: `Your request "${doc.title || "Untitled"}" is now SENT_TO_PO.`,
      requestId: String(doc._id),
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json({ success: true, request: updated });
  } catch (e) {
    console.error("send-to-po error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   ✅ Ordering swapped: SENT_TO_PO -> ORDERED (RP orders)
================================== */
router.post("/:id/order", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isOrderingRole(user.role)) {
      return res.status(403).json({ error: `Only ${ROLE_ORDERING} can order` });
    }
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const requestDoc = await db.collection("requests").findOne({ _id: id });
    if (!requestDoc)
      return res.status(404).json({ error: "Request not found" });

    const st = String(requestDoc.status || "").toUpperCase();
    if (st !== STATUS.SENT_TO_PO) {
      return res
        .status(403)
        .json({ error: "Only SENT_TO_PO can be ordered", status: st });
    }

    const offerId = String(
      req.body?.offerId || requestDoc.recommendedOfferId || "",
    ).trim();
    if (!offerId)
      return res
        .status(400)
        .json({ error: "offerId missing (no recommended offer)" });

    const offerObjId = parseId(offerId);
    if (!offerObjId) return res.status(400).json({ error: "Invalid offerId" });

    const offer = await db.collection("offers").findOne({ _id: offerObjId });
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    if (String(offer.requestId) !== String(requestDoc._id)) {
      return res
        .status(403)
        .json({ error: "Offer does not belong to request" });
    }

    const now = new Date();

    const po = {
      requestId: String(requestDoc._id),
      offerId: String(offer._id),
      orderedBy: normalizeUsername(user.username),
      orderedAt: now,

      totalPrice: offer.price ?? null,
      currency: offer.currency || "EUR",
      providerUsername: offer.providerUsername || "",
      providerName: offer.providerName || "",

      rolesProvided: offer.rolesProvided || [],
      deliveryDays: offer.deliveryDays ?? null,

      snapshot: {
        requestTitle: requestDoc.title || "",
        requestType: requestDoc.type || "",
        projectId: requestDoc.projectId || "",
        projectName: requestDoc.projectName || "",
        supplier: requestDoc.contractSupplier || "",
        offer: {
          price: offer.price ?? null,
          currency: offer.currency || "EUR",
          deliveryDays: offer.deliveryDays ?? null,
          notes: offer.notes || "",
        },
      },

      createdAt: now,
      updatedAt: now,
    };

    const insert = await db.collection("purchase_orders").insertOne(po);

    await db
      .collection("offers")
      .updateOne(
        { _id: offerObjId },
        { $set: { status: "ORDERED", updatedAt: now } },
      );

    await db.collection("requests").updateOne(
      { _id: id, status: STATUS.SENT_TO_PO },
      {
        $set: {
          status: STATUS.ORDERED,
          orderId: String(insert.insertedId),
          orderedAt: now,
          orderedBy: normalizeUsername(user.username),
          orderedOfferId: String(offer._id),
          updatedAt: now,
        },
      },
    );

    await createNotification({
      uniqKey: `${String(id)}:ORDERED_PM`,
      toUsername: requestDoc.createdBy,
      type: "REQUEST_STATUS",
      title: "Request ordered",
      message: `Your request "${requestDoc.title || "Untitled"}" is now ORDERED.`,
      requestId: String(id),
    });

    await createNotification({
      uniqKey: `${String(id)}:ORDERED_ORDERING_ROLE`,
      toRole: ROLE_ORDERING,
      type: "REQUEST_STATUS",
      title: "Order placed",
      message: `Order placed for request "${requestDoc.title || "Untitled"}".`,
      requestId: String(id),
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json({
      success: true,
      orderId: String(insert.insertedId),
      request: updated,
    });
  } catch (e) {
    console.error("order error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
