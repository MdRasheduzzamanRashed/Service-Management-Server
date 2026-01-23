// swagger.js
import fs from "fs";

const swaggerSpec = JSON.parse(
  fs.readFileSync("./swagger-output.json", "utf8"),
);

export { swaggerSpec };
