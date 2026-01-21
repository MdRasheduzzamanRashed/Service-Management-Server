import swaggerJsdoc from "swagger-jsdoc";

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "Service Management API", version: "1.0.0" },
    servers: [{ url: process.env.PUBLIC_BASE_URL || "http://localhost:8000" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  },
  apis: ["./routes/*.js"],
});
