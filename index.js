// server.js
import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import notificationsRoutes from "./routes/notifications.js";
import { connectDB } from "./db.js";
import { db } from "./db.js";
import { swaggerSpec } from "./swagger.js";
import { initSocket } from "./socket.js";

import authRoutes from "./routes/auth.js";
import requestsRoutes from "./routes/requests.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const PORT = process.env.PORT || 8000;

const allowlist = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.CLIENT_URL,
].filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin), false);
  },
  credentials: true, // ✅ MUST be true
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-user-role",
    "x-username",
  ],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // ✅ IMPORTANT


app.use("/api/notifications", notificationsRoutes);
/* =========================
   ✅ Body parser (before routes)
========================= */
app.use(express.json({ limit: "2mb" }));

/* =========================
   DB connect
========================= */
await connectDB();

/* =========================
   ✅ auto-expire job (your code unchanged)
========================= */
function computeEndsAt(doc) {
  if (!doc?.biddingStartedAt) return null;
  const days = Number(doc?.biddingCycleDays ?? 7);
  const start = new Date(doc.biddingStartedAt);
  if (Number.isNaN(start.getTime())) return null;
  const ends = new Date(start);
  ends.setDate(ends.getDate() + (Number.isFinite(days) ? days : 7));
  return ends;
}

async function expireDueBiddingRequests() {
  const now = new Date();
  const cursor = db.collection("requests").find({
    status: "BIDDING",
    biddingStartedAt: { $type: "date" },
  });

  for await (const doc of cursor) {
    const endsAt = computeEndsAt(doc);
    if (!endsAt) continue;
    if (now < endsAt) continue;

    const result = await db
      .collection("requests")
      .updateOne(
        { _id: doc._id, status: "BIDDING" },
        { $set: { status: "EXPIRED", expiredAt: now, updatedAt: now } },
      );

    if (!result.modifiedCount) continue;

    if (doc.createdBy) {
      const requestId = String(doc._id);
      const uniq = `${requestId}:EXPIRED`;

      await db.collection("notifications").updateOne(
        { uniqKey: uniq },
        {
          $setOnInsert: {
            uniqKey: uniq,
            toUsername: String(doc.createdBy).toLowerCase(),
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
  }
}

setInterval(
  () => {
    expireDueBiddingRequests().catch((e) =>
      console.error("Expire job error:", e),
    );
  },
  5 * 60 * 1000,
);

expireDueBiddingRequests().catch(() => {});

/* =========================
   ✅ Routes (IMPORTANT: mount with prefixes)
========================= */
app.get("/", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/requests", requestsRoutes);

/* =========================
   Socket + Listen
========================= */
initSocket(server);

server.listen(PORT, () => {
  console.log("Backend listening on port", PORT);
});
