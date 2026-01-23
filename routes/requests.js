// routes/requests.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

/**
 * STATUS FLOW:
 * PM: DRAFT -> IN_REVIEW
 * RP: IN_REVIEW -> APPROVED_FOR_SUBMISSION or REJECTED
 * PM: APPROVED_FOR_SUBMISSION -> BIDDING
 * SYSTEM: BIDDING -> EXPIRED (auto)
 * AUTO: BIDDING -> BID_EVALUATION (when offersCount >= maxOffers)
 * RP: BID_EVALUATION -> RECOMMENDED (select best offer)
 * PM: RECOMMENDED -> SENT_TO_PO
 * PO: SENT_TO_PO -> ORDERED
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
function isRP(role) {
  return role === "RESOURCE_PLANNER";
}
function isPO(role) {
  return role === "PROCUREMENT_OFFICER";
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
    const uniq = `${requestId}:EXPIRED`;

    await db.collection("notifications").updateOne(
      { uniqKey: uniq },
      {
        $setOnInsert: {
          uniqKey: uniq,
          toUsername: normalizeUsername(doc.createdBy),
          type: "REQUEST_EXPIRED",
          title: "Request expired",
          message: `Your request "${doc.title || "Untitled"}" has expired after the bidding cycle.`,
          requestId,
          createdAt: now,
          read: false,
        },
      },
      { upsert: true },
    );
  }

  return await db.collection("requests").findOne({ _id: doc._id });
}

/* =========================
   Offers helpers (enterprise)
========================= */
/**
 * Auto-complete: if offersCount >= maxOffers and status is BIDDING -> BID_EVALUATION
 * Uses doc.offersCount if present (from lookup), otherwise counts on demand.
 */
async function autoCompleteBiddingIfEnoughOffers(reqDoc) {
  if (!reqDoc) return reqDoc;

  const st = String(reqDoc.status || "").toUpperCase();

  const requestId = String(reqDoc._id);
  const offersCount =
    typeof reqDoc.offersCount === "number"
      ? reqDoc.offersCount
      : await db.collection("offers").countDocuments({ requestId });

  // always attach offersCount
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
    if (!isPM(user.role))
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can create requests" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const body = req.body || {};
    if (!body.title || !String(body.title).trim())
      return res.status(400).json({ error: "Title is required" });

    const doc = {
      ...body,
      status: STATUS.DRAFT,
      createdBy: normalizeUsername(user.username),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("requests").insertOne(doc);
    return res.json({ success: true, id: String(result.insertedId) });
  } catch (e) {
    console.error("Create request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   LIST (admin/pm/rp/po)
   supports:
   - ?view=my (PM only)
   - ?status=...
   - ?q=... (search)
   - ?page=1&limit=20
   Returns: { data, meta }
================================== */
router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadAll(user.role))
      return res.status(403).json({ error: "Not allowed to view requests." });

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
      if (!isPM(user.role))
        return res
          .status(403)
          .json({ error: "Only PROJECT_MANAGER can use view=my" });
      if (!user.username)
        return res.status(401).json({ error: "Missing x-username" });
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

    // total count (match only, without lookup)
    const total = await db.collection("requests").countDocuments(match);

    // data with offersCount
    const pipeline = [
      ...addOffersCountPipeline(match),
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const list = await db.collection("requests").aggregate(pipeline).toArray();

    // enforce expiry + auto-complete
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
   GET /api/requests/bidding
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
   LIST BID_EVALUATION (PM/RP/PO/Admin)
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
   GET ONE (includes offersCount + expiry + auto-complete)
================================== */
router.get("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadAll(user.role))
      return res.status(403).json({ error: "Not allowed to view requests." });

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
    if (!isPM(user.role))
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can update requests" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (!isOwner(existing, user.username))
      return res.status(403).json({ error: "Not allowed" });
    if (String(existing.status || "").toUpperCase() !== STATUS.DRAFT)
      return res
        .status(403)
        .json({ error: "Only DRAFT requests can be edited" });

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
    if (!isPM(user.role))
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can delete requests" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (!isOwner(existing, user.username))
      return res.status(403).json({ error: "Not allowed" });
    if (String(existing.status || "").toUpperCase() !== STATUS.DRAFT)
      return res
        .status(403)
        .json({ error: "Only DRAFT requests can be deleted" });

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
    if (!isPM(user.role))
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can submit for review" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });
    if (!isOwner(doc, user.username))
      return res.status(403).json({ error: "Not allowed" });

    if (String(doc.status || "").toUpperCase() !== STATUS.DRAFT)
      return res
        .status(403)
        .json({ error: "Only DRAFT can be submitted for review" });

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.IN_REVIEW,
          submittedAt: new Date(),
          submittedBy: normalizeUsername(user.username),
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

// RP: IN_REVIEW -> APPROVED_FOR_SUBMISSION
router.post("/:id/rp-approve", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isRP(user.role))
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can approve" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (String(doc.status || "").toUpperCase() !== STATUS.IN_REVIEW)
      return res
        .status(403)
        .json({ error: "Only IN_REVIEW requests can be approved" });

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.APPROVED_FOR_SUBMISSION,
          rpApprovedAt: new Date(),
          rpApprovedBy: normalizeUsername(user.username),
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

// RP: IN_REVIEW -> REJECTED
router.post("/:id/rp-reject", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isRP(user.role))
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can reject" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (String(doc.status || "").toUpperCase() !== STATUS.IN_REVIEW)
      return res
        .status(403)
        .json({ error: "Only IN_REVIEW requests can be rejected" });

    const reason = String(req.body?.reason || "").trim();

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.REJECTED,
          rpRejectedAt: new Date(),
          rpRejectedBy: normalizeUsername(user.username),
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

// PM: APPROVED_FOR_SUBMISSION -> BIDDING
router.post("/:id/submit-for-bidding", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isPM(user.role))
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can submit for bidding" });
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
    )
      return res
        .status(403)
        .json({ error: "Only APPROVED_FOR_SUBMISSION can go to BIDDING" });

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.BIDDING,
          biddingStartedAt: new Date(),
          biddingStartedBy: normalizeUsername(user.username),
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

// PM: EXPIRED -> APPROVED_FOR_SUBMISSION
router.post("/:id/reactivate", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isPM(user.role))
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can reactivate" });
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });
    if (!isOwner(doc, user.username))
      return res.status(403).json({ error: "Not allowed" });

    if (String(doc.status || "").toUpperCase() !== STATUS.EXPIRED)
      return res
        .status(403)
        .json({ error: "Only EXPIRED requests can be reactivated" });

    await db.collection("requests").updateOne(
      { _id: id, status: STATUS.EXPIRED },
      {
        $set: {
          status: STATUS.APPROVED_FOR_SUBMISSION,
          reactivatedAt: new Date(),
          reactivatedBy: normalizeUsername(user.username),
          updatedAt: new Date(),
        },
        $unset: {
          biddingStartedAt: "",
          biddingStartedBy: "",
          expiredAt: "",
        },
      },
    );

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("reactivate error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   RP recommends (BID_EVALUATION -> RECOMMENDED)
================================== */
router.post("/:id/rp-recommend-offer", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isRP(user.role))
      return res
        .status(403)
        .json({ error: "Only RESOURCE_PLANNER can recommend" });
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

    await db
      .collection("offers")
      .updateMany(
        { requestId: String(doc._id), status: "RECOMMENDED" },
        { $set: { status: "SUBMITTED", updatedAt: now } },
      );

    await db
      .collection("offers")
      .updateOne(
        { _id: offerObjId },
        { $set: { status: "RECOMMENDED", updatedAt: now } },
      );

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
    console.error("rp-recommend-offer error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   PM: RECOMMENDED -> SENT_TO_PO
   (returns updated request)
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

    if (String(doc.status || "").toUpperCase() !== STATUS.RECOMMENDED)
      return res
        .status(403)
        .json({ error: "Only RECOMMENDED can be sent to PO" });

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

    await db.collection("notifications").insertOne({
      toRole: "PROCUREMENT_OFFICER",
      type: "REQUEST_SENT_TO_PO",
      title: "New request for ordering",
      message: `A request "${doc.title || "Untitled"}" is ready for ordering.`,
      requestId: String(doc._id),
      createdAt: now,
      read: false,
    });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json({ success: true, request: updated });
  } catch (e) {
    console.error("send-to-po error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   PO: SENT_TO_PO -> ORDERED
   (returns updated request + orderId)
================================== */
router.post("/:id/order", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!isPO(user.role))
      return res.status(403).json({ error: "Only PROCUREMENT_OFFICER" });
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
    if (!offerId) {
      return res
        .status(400)
        .json({ error: "offerId missing (no recommended offer)" });
    }

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
