import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";
import { createNotification } from "../utils/createNotification.js";

const router = express.Router();

// GET service orders
router.get("/api/service-orders", async (req, res) => {
  try {
    const list = await db
      .collection("serviceOrders")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (err) {
    console.error("Get service orders error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// CREATE service order
router.post("/api/service-orders", async (req, res) => {
  try {
    const {
      requestId,
      title,
      supplierName,
      supplierRepresentative,
      specialistName,
      role,
      manDays,
      startDate,
      endDate,
      location,
      contractValue
    } = req.body;

    if (!requestId || !title || !supplierName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const rid = new ObjectId(requestId);

    const doc = {
      requestId: rid,
      title,
      supplierName,
      supplierRepresentative,
      specialistName,
      role,
      manDays,
      startDate,
      endDate,
      location,
      contractValue,
      createdAt: new Date()
    };

    const result = await db.collection("serviceOrders").insertOne(doc);

    await db.collection("auditLogs").insertOne({
      type: "ServiceOrderCreated",
      requestId: rid,
      at: new Date()
    });

    // 🔔 Notify PM + Planner
    await createNotification({
      title: "Service Order Created",
      message: `A service order for "${title}" has been created.`,
      roles: ["ProjectManager", "ResourcePlanner"],
      requestId: rid,
      type: "ServiceOrderCreated"
    });

    return res.status(201).json({ ...doc, _id: result.insertedId });
  } catch (err) {
    console.error("Create service order error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// SUBSTITUTE specialist
router.post("/api/service-orders/:id/substitute", async (req, res) => {
  try {
    const id = req.params.id;
    const { newSpecialistName } = req.body;

    if (!newSpecialistName) {
      return res.status(400).json({ error: "newSpecialistName required" });
    }

    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid service order id" });
    }

    const updated = await db.collection("serviceOrders").findOneAndUpdate(
      { _id: oid },
      { $set: { specialistName: newSpecialistName } },
      { returnDocument: "after" }
    );

    await db.collection("auditLogs").insertOne({
      type: "ServiceOrderSubstitution",
      serviceOrderId: oid,
      at: new Date()
    });

    // 🔔 Notify PM + Planner
    await createNotification({
      title: "Specialist Substitution",
      message: `Specialist changed to "${newSpecialistName}" for service order "${updated.value.title}".`,
      roles: ["ProjectManager", "ResourcePlanner"],
      requestId: updated.value.requestId,
      type: "ServiceOrderSubstitution"
    });

    return res.json(updated.value);
  } catch (err) {
    console.error("Substitute error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// EXTEND service order
router.post("/api/service-orders/:id/extend", async (req, res) => {
  try {
    const id = req.params.id;
    const { newEndDate, additionalManDays, updatedContractValue } = req.body;

    let oid;
    try {
      oid = new ObjectId(id);
    } catch {
      return res.status(400).json({ error: "Invalid service order id" });
    }

    const updated = await db.collection("serviceOrders").findOneAndUpdate(
      { _id: oid },
      {
        $set: {
          endDate: newEndDate,
          manDays: additionalManDays,
          contractValue: updatedContractValue
        }
      },
      { returnDocument: "after" }
    );

    await db.collection("auditLogs").insertOne({
      type: "ServiceOrderExtended",
      serviceOrderId: oid,
      at: new Date()
    });

    // 🔔 Notify PM + Planner
    await createNotification({
      title: "Service Order Extended",
      message: `Service order "${updated.value.title}" extended to ${newEndDate}.`,
      roles: ["ProjectManager", "ResourcePlanner"],
      requestId: updated.value.requestId,
      type: "ServiceOrderExtended"
    });

    return res.json(updated.value);
  } catch (err) {
    console.error("Extend error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
