import { db } from "../db.js";
import { getIO } from "../socket.js";

export async function createNotification({
  title,
  message,
  roles,
  requestId = null,
  relatedOfferId = null,
  createdByRole = "System",
  createdByEmail = null,
  type = null
}) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error("Notification must target at least one role");
  }

  const doc = {
    title,
    message,
    type,
    roles,
    requestId,
    relatedOfferId,
    createdByRole,
    createdByEmail,
    createdAt: new Date(),
    readBy: []
  };

  const result = await db.collection("notifications").insertOne(doc);
  const saved = { ...doc, _id: result.insertedId };

  try {
    const io = getIO();
    roles.forEach((role) => {
      io.to(`role:${role}`).emit("notification", saved);
    });
  } catch (err) {
    console.error("Socket emit failed:", err.message);
  }

  return saved;
}