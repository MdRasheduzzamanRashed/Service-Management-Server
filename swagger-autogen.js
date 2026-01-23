// swagger-autogen.js
import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "Service Management API",
    version: "1.0.0",
    description: "Auto-generated Swagger documentation",
  },
  host: "service-management-server.onrender.com",
  schemes: ["https"],
};

const outputFile = "./swagger-output.json";

// ✅ scan your real entry file:
const endpointsFiles = ["./index.js"];

await swaggerAutogen({ openapi: "3.0.0" })(outputFile, endpointsFiles, doc);
console.log("✅ Swagger generated:", outputFile);
