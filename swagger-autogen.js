// swagger-autogen.js
import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "Service Management API",
    description: "Auto-generated Swagger documentation",
    version: "1.0.0",
  },
  host: "service-management-server.onrender.com",
  schemes: ["https"],
  consumes: ["application/json"],
  produces: ["application/json"],
  securityDefinitions: {
    bearerAuth: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description: 'JWT Authorization header. Example: "Bearer <token>"',
    },
  },
};

const outputFile = "./swagger-output.json";
const endpointsFiles = ["./server.js"]; // ✅ your main file

await swaggerAutogen({ openapi: "3.0.0" })(outputFile, endpointsFiles, doc);
console.log("✅ Swagger generated:", outputFile);
