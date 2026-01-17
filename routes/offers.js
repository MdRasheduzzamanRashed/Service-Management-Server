import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";
import { createNotification } from "../utils/createNotification.js";

const router = express.Router();

// GET all offers for a request
router.get("/api/offers/:requestId", async (req, res) => {
  try {
    let requestId;
    try {
      requestId = new ObjectId(req.params.requestId);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const offers = await db
      .collection("offers")
      .find({ requestId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(offers);
  } catch (err) {
    console.error("Get offers error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST: Provider submits offer
router.post("/api/offers/:requestId", async (req, res) => {
  try {
    const { providerName, price, currency, notes } = req.body;

    if (!providerName || price == null) {
      return res.status(400).json({ error: "providerName and price required" });
    }

    let requestId;
    try {
      requestId = new ObjectId(req.params.requestId);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc = {
      requestId,
      providerName,
      price,
      currency: currency || "EUR",
      notes: notes || "",
      createdAt: new Date()
    };

    const result = await db.collection("offers").insertOne(doc);
    const saved = { ...doc, _id: result.insertedId };

    // Audit log
    await db.collection("auditLogs").insertOne({
      type: "OfferSubmitted",
      requestId,
      offerId: saved._id,
      at: new Date()
    });

    // 🔔 Notify PM + Planner (Providers submit offers)
    await createNotification({
      title: "New Provider Offer Submitted",
      message: `Provider "${providerName}" submitted an offer.`,
      roles: ["ProjectManager", "ResourcePlanner"],
      requestId,
      createdByRole: "Provider",
      type: "OfferSubmitted"
    });

    return res.status(201).json(saved);
  } catch (err) {
    console.error("Create offer error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST: PM selects preferred offer
router.post("/api/offers/:offerId/select", async (req, res) => {
  try {
    const { offerId } = req.params;
    const { requestId } = req.body;

    let oid, rid;
    try {
      oid = new ObjectId(offerId);
      rid = new ObjectId(requestId);
    } catch {
      return res.status(400).json({ error: "Invalid offer or request id" });
    }

    // Update service request
    const updated = await db.collection("serviceRequests").findOneAndUpdate(
      { _id: rid },
      { $set: { selectedOfferId: oid, status: "Selected" } },
      { returnDocument: "after" }
    );

    // Audit
    await db.collection("auditLogs").insertOne({
      type: "OfferSelected",
      requestId: rid,
      offerId: oid,
      at: new Date()
    });

    // 🔔 Notify Procurement + Planner
    await createNotification({
      title: "Preferred Offer Selected",
      message: `PM selected a preferred offer for request "${updated.value.title}".`,
      roles: ["ProcurementOfficer", "ResourcePlanner"],
      requestId: rid,
      relatedOfferId: oid,
      createdByRole: "ProjectManager",
      type: "OfferSelected"
    });

    return res.json(updated.value);
  } catch (err) {
    console.error("Select offer error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
