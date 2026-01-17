import express from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";

const router = express.Router();

/* ============================================================
   AUTH (header-based)
   Frontend must send:
   - x-user-id:   Mongo ObjectId string
   - x-user-role: ProjectManager | ProcurementOfficer | ResourcePlanner | System | ...
============================================================ */
function getUser(req) {
  const role = (req.headers["x-user-role"] || "").toString().trim();
  const userIdRaw = (req.headers["x-user-id"] || "").toString().trim();

  if (!role) return { error: "Missing x-user-role" };
  if (!userIdRaw) return { error: "Missing x-user-id" };

  let userId;
  try {
    userId = new ObjectId(userIdRaw);
  } catch {
    return { error: "Invalid x-user-id" };
  }

  return { role, userId };
}

/* ✅ PO + RP + System can see all */
function isAdminRole(role) {
  return (
    role === "ProcurementOfficer" ||
    role === "ResourcePlanner" ||
    role === "System"
  );
}

/* ============================================================
   VALIDATE REQUEST PAYLOAD
============================================================ */
function validatePayload(body) {
  if (!body.title || body.title.trim() === "") return "Title is required";
  if (!body.contractId || body.contractId.trim() === "")
    return "contractId is required";
  if (!body.contract || body.contract.trim() === "")
    return "Contract name is required";
  if (!Array.isArray(body.positions) || body.positions.length === 0)
    return "At least one position is required";

  for (let p of body.positions) {
    if (!p.subContract || p.subContract.trim() === "") {
      return "Each position must have a subContract";
    }
  }

  return null;
}

/* ============================================================
   SANITIZE: allow only editable fields
============================================================ */
function sanitizeRequest(body) {
  return {
    title: body.title,
    contract: body.contract,
    contractId: body.contractId, // string here, convert later

    requestType: body.requestType || "Single",

    positions: (body.positions || []).map((p) => ({
      subContract: p.subContract,
      role: p.role || p.subContract,
      technology: p.technology || "",
      experienceLevel: p.experienceLevel || "",
      performanceLocation: p.performanceLocation || "Onshore",
      startDate: p.startDate || "",
      endDate: p.endDate || "",
      manDays: Number(p.manDays) || 0,
      hoursPerDay: Number(p.hoursPerDay) || 8,
      employeesCount: Number(p.employeesCount) || 1,
      offeredSalaryPerHour: Number(p.offeredSalaryPerHour) || 0,
      taskDescription: p.taskDescription || "",
      mustHaveSkills: Array.isArray(p.mustHaveSkills) ? p.mustHaveSkills : [],
      niceToHaveSkills: Array.isArray(p.niceToHaveSkills)
        ? p.niceToHaveSkills
        : [],
    })),

    commercialWeighting: Number(body.commercialWeighting) || 50,
    technicalWeighting: Number(body.technicalWeighting) || 50,

    maxOffersPerProvider: Number(body.maxOffersPerProvider) || 3,
    maxAcceptedOffers: Number(body.maxAcceptedOffers) || 1,

    requiredLanguageSkills: Array.isArray(body.requiredLanguageSkills)
      ? body.requiredLanguageSkills
      : [],

    sumOfManDays: Number(body.sumOfManDays) || 0,
    totalEmployees: Number(body.totalEmployees) || 1,

    externalId: body.externalId || "",
    externalViewUrl: body.externalViewUrl || "",
  };
}

/* ============================================================
   RULE: Only PM can edit Draft request created by himself
============================================================ */
function canEditDraft(user, doc) {
  if (!doc) return false;
  if (user.role !== "ProjectManager") return false;
  if (doc.status !== "Draft") return false;
  if (!doc.createdBy) return false;
  return String(doc.createdBy) === String(user.userId);
}

/* ============================================================
   RULE: Who can read a request
   - PO/RP/System can read all
   - PM can read only his own
============================================================ */
function canRead(user, doc) {
  if (!doc) return false;
  if (isAdminRole(user.role)) return true;
  if (user.role === "ProjectManager") {
    return String(doc.createdBy) === String(user.userId);
  }
  return false;
}

/* ============================================================
   CREATE SERVICE REQUEST
   ✅ status Draft
   ✅ createdBy = logged user
============================================================ */
router.post("/api/requests", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    if (user.role !== "ProjectManager") {
      return res
        .status(403)
        .json({ error: "Only ProjectManager can create requests" });
    }

    const body = req.body;

    const err = validatePayload(body);
    if (err) return res.status(400).json({ error: err });

    let contractObjId;
    try {
      contractObjId = new ObjectId(body.contractId);
    } catch {
      return res.status(400).json({ error: "Invalid contractId" });
    }

    const clean = sanitizeRequest(body);

    const doc = {
      ...clean,
      contractId: contractObjId,
      createdBy: user.userId,
      status: "Draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("requests").insertOne(doc);

    return res.json({ success: true, requestId: result.insertedId });
  } catch (error) {
    console.error("Create request error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   GET ALL REQUESTS
   ✅ PM => only own requests
   ✅ PO/RP/System => all requests
============================================================ */
router.get("/api/requests", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    const query =
      user.role === "ProjectManager"
        ? { createdBy: user.userId }
        : isAdminRole(user.role)
        ? {}
        : null;

    if (!query) return res.status(403).json({ error: "Not allowed" });

    const list = await db
      .collection("requests")
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(list);
  } catch (error) {
    console.error("List requests error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   GET ONE REQUEST
============================================================ */
router.get("/api/requests/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const doc = await db.collection("requests").findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: "Request not found" });

    if (!canRead(user, doc)) {
      return res
        .status(403)
        .json({ error: "Not allowed to view this request" });
    }

    return res.json(doc);
  } catch (error) {
    console.error("Load request error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   UPDATE REQUEST
   ✅ Only owner PM can edit Draft
============================================================ */
router.put("/api/requests/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const body = req.body;

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (!canEditDraft(user, existing)) {
      return res.status(403).json({
        error: "Not allowed. Only owner PM can edit Draft requests.",
      });
    }

    const err = validatePayload(body);
    if (err) return res.status(400).json({ error: err });

    let contractObjId;
    try {
      contractObjId = new ObjectId(body.contractId);
    } catch {
      return res.status(400).json({ error: "Invalid contractId" });
    }

    const clean = sanitizeRequest(body);

    const update = {
      ...clean,
      contractId: contractObjId,
      updatedAt: new Date(),
    };

    await db.collection("requests").updateOne({ _id: id }, { $set: update });

    const updated = await db.collection("requests").findOne({ _id: id });
    return res.json(updated);
  } catch (error) {
    console.error("Update request error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   DELETE REQUEST
   ✅ Only owner PM can delete Draft
============================================================ */
router.delete("/api/requests/:id", async (req, res) => {
  try {
    const user = getUser(req);
    if (user.error) return res.status(401).json({ error: user.error });

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ error: "Invalid request id" });
    }

    const existing = await db.collection("requests").findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Request not found" });

    if (!canEditDraft(user, existing)) {
      return res.status(403).json({
        error: "Not allowed. Only owner PM can delete Draft requests.",
      });
    }

    await db.collection("requests").deleteOne({ _id: id });
    return res.json({ success: true });
  } catch (error) {
    console.error("Delete request error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
