// server.js (or index.js)
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
const server = http.createServer(app);
const PORT = process.env.PORT || 8000;

app.use(
  cors({
    origin: ["http://localhost:3000"],
    credentials: true,
  })
);
app.use(express.json());

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/docs.json", (req, res) => res.json(swaggerSpec));

await connectDB();

// ✅ IMPORTANT: NO PREFIX HERE
app.use(authRoutes);
app.use(requestsRoutes);
app.use(offersRoutes);
app.use(serviceOrdersRoutes);
app.use(notificationsRoutes);
app.use(contractsRoutes);
app.use(skillsRoutes);

app.get("/", (req, res) => res.json({ status: "ok" }));

initSocket(server);

server.listen(PORT, () => {
  console.log("Backend listening on port", PORT);
});
