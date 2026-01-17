import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

/* ============================================================
   GET ALL CONTRACTS
   Example document:
   {
     _id: "...",
     contract: "Software Development",
     subContract: ["React Developer", "Node.js Developer"]
   }
============================================================ */
router.get("/api/contracts", async (req, res) => {
  try {
    const list = await db
      .collection("contracts")
      .find({})
      .sort({ contract: 1 })
      .toArray();

    return res.json(list);
  } catch (err) {
    console.error("Load contracts error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   GET ONE CONTRACT BY ID
============================================================ */
router.get("/api/contracts/:id", async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid contract ID" });
    }

    const doc = await db.collection("contracts").findOne({ _id: id });

    if (!doc) return res.status(404).json({ error: "Contract not found" });

    return res.json(doc);
  } catch (err) {
    console.error("Get contract error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   CREATE NEW CONTRACT
============================================================ */
router.post("/api/contracts", async (req, res) => {
  try {
    const { contract, subContract } = req.body;

    if (!contract || !contract.trim()) {
      return res.status(400).json({ error: "Contract name is required" });
    }

    const doc = {
      contract,
      subContract: Array.isArray(subContract) ? subContract : [],
      createdAt: new Date(),
    };

    const result = await db.collection("contracts").insertOne(doc);

    return res.json({
      success: true,
      id: result.insertedId,
    });
  } catch (err) {
    console.error("Create contract error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   UPDATE CONTRACT
============================================================ */
router.put("/api/contracts/:id", async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid contract ID" });
    }

    const { contract, subContract } = req.body;

    const update = {
      ...(contract && { contract }),
      ...(Array.isArray(subContract) && { subContract }),
      updatedAt: new Date(),
    };

    await db.collection("contracts").updateOne({ _id: id }, { $set: update });

    return res.json({ success: true });
  } catch (err) {
    console.error("Update contract error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   DELETE CONTRACT
============================================================ */
router.delete("/api/contracts/:id", async (req, res) => {
  try {
    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid contract ID" });
    }

    await db.collection("contracts").deleteOne({ _id: id });

    return res.json({ success: true });
  } catch (err) {
    console.error("Delete contract error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
