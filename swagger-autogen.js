// swagger-autogen.js
import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "Service Management API",
    description: "Auto-generated Swagger docs for Service Management Backend",
    version: "1.0.0",
  },
  host: "service-management-server.onrender.com",
  schemes: ["https"],
  basePath: "/api",
  consumes: ["application/json"],
  produces: ["application/json"],
  tags: [
    { name: "Auth", description: "Authentication" },
    { name: "Requests", description: "Service requests & workflow" },
    { name: "Offers", description: "Offers" },
    { name: "Bidding", description: "Bidding lists" },
    { name: "Orders", description: "Orders & Purchase Orders" },
    { name: "Notifications", description: "Notifications" },
  ],
  securityDefinitions: {
    bearerAuth: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description: "Use: Bearer <token> (optional in your current backend)",
    },
    userRole: {
      type: "apiKey",
      in: "header",
      name: "x-user-role",
      description:
        "Required: PROJECT_MANAGER / RESOURCE_PLANNER / PROCUREMENT_OFFICER / SYSTEM_ADMIN",
    },
    username: {
      type: "apiKey",
      in: "header",
      name: "x-username",
      description: "Required for PM actions and ownership checks",
    },
  },
};

const outputFile = "./swagger-output.json";

// IMPORTANT: put your main server entry here (the one that mounts routes)
const endpointsFiles = ["./index.js"]; // or "./server.js" depending on your entry file

await swaggerAutogen({ openapi: "3.0.0" })(outputFile, endpointsFiles, doc);

console.log("✅ Swagger file generated:", outputFile);
