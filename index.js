// server.js (Render-ready)
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
app.set("trust proxy", 1); // ✅ important behind Render proxy/load balancer

const server = http.createServer(app);
const PORT = process.env.PORT || 8000;

// ✅ Allowed origins (local + deployed frontend)
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  process.env.CLIENT_URL, // e.g. https://your-frontend.vercel.app
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow Postman/server-to-server (no origin header)
      if (!origin) return cb(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "2mb" }));

// ✅ Swagger
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/docs.json", (req, res) => res.json(swaggerSpec));

// ✅ DB connect once at startup
await connectDB();

// ✅ IMPORTANT: NO PREFIX HERE (your routers already contain /api/..)
app.use(authRoutes);
app.use(requestsRoutes);
app.use(offersRoutes);
app.use(serviceOrdersRoutes);
app.use(notificationsRoutes);
app.use(contractsRoutes);
app.use(skillsRoutes);

// ✅ Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

// ✅ Socket.io
initSocket(server);

server.listen(PORT, () => {
  console.log("Backend listening on port", PORT);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});
