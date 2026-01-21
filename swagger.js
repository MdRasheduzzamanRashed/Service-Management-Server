// swagger.js
import swaggerJsdoc from "swagger-jsdoc";

const PORT = process.env.PORT || 8000;

// ✅ Render provides this sometimes; fallback to localhost
const PROD_URL = process.env.PUBLIC_BASE_URL; // example: https://service-management-server.onrender.com
const LOCAL_URL = `http://localhost:${PORT}`;

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Service Management API",
      version: "1.0.0",
    },
    servers: [{ url: PROD_URL || LOCAL_URL }, { url: LOCAL_URL }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ["./routes/*.js"], // must match your project structure
});
