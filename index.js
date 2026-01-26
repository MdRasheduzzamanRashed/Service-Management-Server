// server.js
import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";

import { connectDB } from "./db.js";
import { swaggerSpec } from "./swagger.js";
import { initSocket } from "./socket.js";

import authRoutes from "./routes/auth.js";
import requestsRoutes from "./routes/requests.js";
import offersRoutes from "./routes/offers.js";
import biddingRoutes from "./routes/bidding.js";
import ordersRoutes from "./routes/orders.js";
import notificationsRoutes from "./routes/notifications.js";
import rpEvaluationsRoutes from "./routes/rpEvaluations.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

// ✅ avoid 304 caching problems (client gets latest)
app.set("etag", false);

const server = http.createServer(app);
const PORT = process.env.PORT || 8000;

const allowlist = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.CLIENT_URL, // e.g. https://service-management-client.vercel.app
].filter(Boolean);

// ✅ CORS
const corsOptions = {
  origin(origin, cb) {
    // allow curl/postman and same-origin
    if (!origin) return cb(null, true);

    if (allowlist.includes(origin)) return cb(null, true);

    // allow vercel preview deployments
    if (origin.endsWith(".vercel.app")) return cb(null, true);

    return cb(new Error("CORS blocked: " + origin), false);
  },

  // ✅ keep true (safe if later you use cookies); doesn't break withCredentials:false
  credentials: true,

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-user-role",
    "x-username",

    // ✅ some browsers send these automatically
    "cache-control",
    "pragma",
    "expires",
    "if-modified-since",
    "if-none-match",
  ],

  // ✅ optional: allows browser to read these headers if you set them
  exposedHeaders: ["etag", "x-total-count"],

  optionsSuccessStatus: 204,
};

// ✅ apply cors BEFORE routes
app.use(cors(corsOptions));

// ✅ must handle OPTIONS preflight explicitly
app.options("*", cors(corsOptions));

// ✅ Body parser
app.use(express.json({ limit: "2mb" }));

// ✅ disable caching for API responses
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

// ✅ DB connect
await connectDB();

/* =========================
   Routes
========================= */
app.get("/", (req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes);
app.use("/api/requests", requestsRoutes);
app.use("/api/offers", offersRoutes);
app.use("/api/bidding", biddingRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/rp-evaluations", rpEvaluationsRoutes);


/* =========================
   Swagger
========================= */
app.use(
  "/api/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    explorer: true,
    swaggerOptions: { persistAuthorization: true },
  }),
);

app.get("/api/docs.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(swaggerSpec);
});

/* =========================
   Error handlers
========================= */

// ✅ CORS error handler (clean JSON instead of server crash)
app.use((err, req, res, next) => {
  if (err?.message?.startsWith("CORS blocked:")) {
    return res.status(403).json({ error: err.message });
  }
  return next(err);
});

// ✅ global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

/* =========================
   Socket + Listen
========================= */
initSocket(server);

server.listen(PORT, () => {
  console.log("🚀 Backend listening on port", PORT);
});
