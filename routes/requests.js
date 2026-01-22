// routes/requests.js
import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

const STATUS = {
  DRAFT: "DRAFT",
  IN_REVIEW: "IN_REVIEW",
  APPROVED_FOR_SUBMISSION: "APPROVED_FOR_SUBMISSION",
  BIDDING: "BIDDING",
  BID_EVALUATION: "BID_EVALUATION", // ✅ new
  RECOMMENDED: "RECOMMENDED", // ✅ new
  SENT_TO_PO: "SENT_TO_PO", // ✅ new
  ORDERED: "ORDERED", // ✅ new
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
};

// ---------- auth helpers ----------
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
    return new ObjectId(idStr);
  } catch {
    return null;
  }
}
function isOwner(doc, username) {
  if (!username) return false;
  return normalizeUsername(doc?.createdBy) === normalizeUsername(username);
}

// ---------- expiry helpers ----------
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
  const status = String(doc.status || "").toUpperCase();
  if (status !== STATUS.BIDDING) return doc;

  const endsAt = computeBiddingEndsAt(doc);
  if (!endsAt) return doc;

  const now = new Date();
  if (now < endsAt) return doc;

  if (String(doc.status || "").toUpperCase() === STATUS.EXPIRED) return doc;

  await db.collection("requests").updateOne(
    { _id: doc._id, status: STATUS.BIDDING },
    {
      $set: {
        status: STATUS.EXPIRED,
        expiredAt: now,
        updatedAt: now,
      },
    },
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

router.post("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (!isPM(user.role)) {
      return res
        .status(403)
        .json({ error: "Only PROJECT_MANAGER can create requests" });
    }
    if (!user.username)
      return res.status(401).json({ error: "Missing x-username" });

    const body = req.body || {};
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const doc = {
      ...body,
      status: STATUS.DRAFT,
      createdBy: user.username,
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

router.get("/", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadAll(user.role))
      return res.status(403).json({ error: "Not allowed to view requests." });

    const status = String(req.query.status || "").trim();
    const view = String(req.query.view || "")
      .trim()
      .toLowerCase();

    const query = {};
    if (status) query.status = status;

    if (view === "my") {
      if (!isPM(user.role))
        return res
          .status(403)
          .json({ error: "Only PROJECT_MANAGER can use view=my" });
      if (!user.username)
        return res.status(401).json({ error: "Missing x-username" });
      query.createdBy = user.username;
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

router.get("/bidding", async (req, res) => {
  try {
    const list = await db
      .collection("requests")
      .find({ status: "BIDDING" })
      .sort({ biddingStartedAt: -1, createdAt: -1 })
      .project({
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
      })
      .toArray();

    return res.json(list);
  } catch (e) {
    console.error("Public bidding error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });
    if (!canReadAll(user.role))
      return res.status(403).json({ error: "Not allowed to view requests." });

    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid request id" });

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const updated = await ensureExpiredIfDue(doc);
    return res.json(updated);
  } catch (e) {
    console.error("Load request error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

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

    const st = String(doc.status || "").toUpperCase();
    if (st !== STATUS.EXPIRED) {
      return res
        .status(403)
        .json({ error: "Only EXPIRED requests can be reactivated" });
    }

    await db.collection("requests").updateOne(
      { _id: id, status: STATUS.EXPIRED },
      {
        $set: {
          status: STATUS.APPROVED_FOR_SUBMISSION,
          reactivatedAt: new Date(),
          reactivatedBy: user.username,
          updatedAt: new Date(),
        },
        $unset: {
          biddingStartedAt: "",
          biddingStartedBy: "",
          expiredAt: "",
        },
      },
    );

    const requestId = String(id);
    const uniq = `${requestId}:REACTIVATED`;
    await db.collection("notifications").updateOne(
      { uniqKey: uniq },
      {
        $setOnInsert: {
          uniqKey: uniq,
          toUsername: user.username,
          type: "REQUEST_REACTIVATED",
          title: "Request reactivated",
          message: `You reactivated "${doc.title || "Untitled"}". It is ready to submit for bidding again.`,
          requestId,
          createdAt: new Date(),
          read: false,
        },
      },
      { upsert: true },
    );

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (e) {
    console.error("reactivate error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ RP: Recommend best offer
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

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    const st = String(doc.status || "").toUpperCase();
    if (!["BID_EVALUATION", "EXPIRED", "BIDDING"].includes(st)) {
      return res
        .status(403)
        .json({ error: "Request not in recommendable state" });
    }

    const offerId = String(req.body?.offerId || "").trim();
    if (!offerId) return res.status(400).json({ error: "offerId is required" });

    const offer = await db
      .collection("offers")
      .findOne({ _id: new ObjectId(offerId) });
    if (!offer) return res.status(404).json({ error: "Offer not found" });
    if (String(offer.requestId) !== String(doc._id)) {
      return res
        .status(403)
        .json({ error: "Offer does not belong to this request" });
    }

    await db
      .collection("offers")
      .updateOne(
        { _id: new ObjectId(offerId) },
        { $set: { status: "RECOMMENDED", updatedAt: new Date() } },
      );

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.RECOMMENDED,
          recommendedOfferId: offerId,
          recommendedAt: new Date(),
          recommendedBy: user.username,
          updatedAt: new Date(),
        },
      },
    );

    // notify PM owner
    if (doc.createdBy) {
      await db.collection("notifications").insertOne({
        toUsername: normalizeUsername(doc.createdBy),
        type: "OFFER_RECOMMENDED",
        title: "Offer recommended",
        message: `RP recommended an offer for "${doc.title || "Untitled"}".`,
        requestId: String(doc._id),
        createdAt: new Date(),
        read: false,
      });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("rp-recommend-offer error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ PM: RECOMMENDED -> SENT_TO_PO
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

    await db.collection("requests").updateOne(
      { _id: id, status: STATUS.RECOMMENDED },
      {
        $set: {
          status: STATUS.SENT_TO_PO,
          sentToPoAt: new Date(),
          sentToPoBy: user.username,
          updatedAt: new Date(),
        },
      },
    );

    // notify PO role (role-based)
    await db.collection("notifications").insertOne({
      toRole: "PROCUREMENT_OFFICER",
      type: "REQUEST_SENT_TO_PO",
      title: "New request for ordering",
      message: `A request "${doc.title || "Untitled"}" is ready for ordering.`,
      requestId: String(doc._id),
      createdAt: new Date(),
      read: false,
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("send-to-po error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ PO: SENT_TO_PO -> ORDERED + create purchase order
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

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (String(doc.status || "").toUpperCase() !== STATUS.SENT_TO_PO) {
      return res.status(403).json({ error: "Only SENT_TO_PO can be ordered" });
    }

    const offerId = String(
      req.body?.offerId || doc.recommendedOfferId || "",
    ).trim();
    if (!offerId)
      return res
        .status(400)
        .json({ error: "offerId missing (no recommended offer)" });

    const offer = await db
      .collection("offers")
      .findOne({ _id: new ObjectId(offerId) });
    if (!offer) return res.status(404).json({ error: "Offer not found" });

    const po = {
      requestId: String(doc._id),
      offerId,
      orderedBy: user.username,
      orderedAt: new Date(),
      totalPrice: offer.price ?? null,
      currency: offer.currency || "EUR",
      providerUsername: offer.providerUsername,
      rolesProvided: offer.rolesProvided || [],
      createdAt: new Date(),
    };

    const r = await db.collection("purchase_orders").insertOne(po);

    await db
      .collection("offers")
      .updateOne(
        { _id: new ObjectId(offerId) },
        { $set: { status: "ORDERED", updatedAt: new Date() } },
      );

    await db.collection("requests").updateOne(
      { _id: id },
      {
        $set: {
          status: STATUS.ORDERED,
          orderId: String(r.insertedId),
          orderedAt: new Date(),
          orderedBy: user.username,
          updatedAt: new Date(),
        },
      },
    );

    // notify PM owner
    if (doc.createdBy) {
      await db.collection("notifications").insertOne({
        toUsername: normalizeUsername(doc.createdBy),
        type: "REQUEST_ORDERED",
        title: "Order placed",
        message: `PO placed an order for "${doc.title || "Untitled"}".`,
        requestId: String(doc._id),
        createdAt: new Date(),
        read: false,
      });
    }

    return res.json({ success: true, orderId: String(r.insertedId) });
  } catch (e) {
    console.error("order error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
