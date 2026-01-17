import swaggerJSDoc from "swagger-jsdoc";

export const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Backend API",
      version: "1.0.0",
      description: "API documentation (Swagger / OpenAPI)",
    },
    servers: [{ url: "http://localhost:8000", description: "Local" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      responses: {
        UnauthorizedError: { description: "Unauthorized" },
      },
    },
  },
  // ✅ This matches your folder structure
  apis: ["./routes/*.js"],
});
