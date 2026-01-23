// swagger.js
import fs from "fs";

let swaggerSpec = {
  openapi: "3.0.0",
  info: { title: "Service Management API", version: "1.0.0" },
  paths: {},
};

try {
  const raw = fs.readFileSync("./swagger-output.json", "utf8");
  swaggerSpec = JSON.parse(raw);
} catch (e) {
  console.warn(
    "⚠️ swagger-output.json not found or invalid. Run: npm run swagger",
  );
}

export { swaggerSpec };
