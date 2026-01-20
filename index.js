// server.js
import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";

import { connectDB } from "./db.js";
import { swaggerSpec } from "./swagger.js";
import { initSocket } from "./socket.js";

import skillsRoutes from "./routes/skills.js";
import authRoutes from "./routes/auth.js";
import requestsRoutes from "./routes/requests.js";
import offersRoutes from "./routes/offers.js";
import serviceOrdersRoutes from "./routes/serviceOrders.js";
import notificationsRoutes from "./routes/notifications.js";
import contractsRoutes from "./routes/contracts.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const PORT = process.env.PORT || 8000;

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "2mb" }));

// Swagger
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/docs.json", (req, res) => res.json(swaggerSpec));

// DB connect once
await connectDB();

// ✅ mount with prefixes
app.use("/api/auth", authRoutes);
app.use("/api/requests", requestsRoutes);
app.use("/api/offers", offersRoutes);
app.use("/api/service-orders", serviceOrdersRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/contracts", contractsRoutes);
app.use("/api/skills", skillsRoutes);

app.get("/", (req, res) => res.json({ status: "ok" }));

initSocket(server);

server.listen(PORT, () => {
  console.log("Backend listening on port", PORT);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});
