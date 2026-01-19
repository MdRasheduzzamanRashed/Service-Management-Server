// routes/auth.js  (STYLE A: server mounts /api/auth, router uses short paths)
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { db } from "../db.js";
import { XMLParser } from "fast-xml-parser";
import { authMiddleware } from "../middleware/authMiddleware.js";

dotenv.config();
const router = express.Router();

const EMPLOYEES_API =
  "https://workforcemangementtool.onrender.com/api/employees";
const EMPLOYEES_API_TIMEOUT_MS = 8000;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("Missing JWT_SECRET");
}

const ALLOWED_EMPLOYEE_ROLES = new Set([
  "PROJECT_MANAGER",
  "RESOURCE_PLANNER",
  "PROCUREMENT_OFFICER",
  "SYSTEM_ADMIN",
]);

/* =========================
   Helpers
========================= */
function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}
function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase();
}
function normalizeRole(role) {
  return String(role || "")
    .trim()
    .toUpperCase();
}

function safeUser(u) {
  return {
    _id: String(u._id),
    employeeId: u.employeeId ? String(u.employeeId) : "",
    userId: u.userId ? String(u.userId) : "",
    username: u.username || "",
    displayUsername: u.displayUsername || "",
    name: u.name || "",
    firstName: u.firstName || "",
    lastName: u.lastName || "",
    email: u.email || "",
    role: u.role || "",
    department: u.department || "",
    position: u.position || "",
  };
}

function signToken(u) {
  return jwt.sign(
    {
      _id: String(u._id),
      employeeId: u.employeeId ? String(u.employeeId) : "",
      userId: u.userId ? String(u.userId) : "",
      username: u.username || "",
      email: u.email || "",
      role: u.role || "",
    },
    JWT_SECRET,
    { expiresIn: "7d" },
  );
}

function buildFullName(employee) {
  const fn = String(employee?.firstName || "").trim();
  const ln = String(employee?.lastName || "").trim();
  const full = `${fn} ${ln}`.trim();
  return full || String(employee?.username || "").trim() || "User";
}
function pickEmployeeUsername(employee) {
  return String(employee?.username || "").trim();
}
function pickEmployeeId(employee) {
  return employee?.id || employee?._id || employee?.employeeId || null;
}

/* =========================
   Employees fetch (XML -> JS)
========================= */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
});

async function getEmployees() {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    EMPLOYEES_API_TIMEOUT_MS,
  );
  let res;
  try {
    res = await fetch(EMPLOYEES_API, {
      headers: { Accept: "application/xml, text/xml, application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Employees API timeout");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) throw new Error(`Employees API failed: ${res.status}`);

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const raw = await res.text();

  // JSON fallback
  if (contentType.includes("application/json")) {
    const json = JSON.parse(raw);
    const employees = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(employees)) throw new Error("Employees JSON invalid");
    return employees;
  }

  // XML parse
  const parsed = xmlParser.parse(raw);
  const items = parsed?.List?.item;
  const employees = Array.isArray(items) ? items : items ? [items] : [];
  if (!Array.isArray(employees)) throw new Error("Employees XML invalid");
  return employees;
}

async function findEmployeeByEmail(email) {
  const normEmail = normalizeEmail(email);
  const employees = await getEmployees();
  return employees.find((e) => normalizeEmail(e?.email) === normEmail) || null;
}

/* ============================================================
   ROUTES (server mounts: /api/auth)
============================================================ */

/**
 * @openapi
 * /api/auth/prefill:
 *   get:
 *     summary: Verify employee email and prefill user info
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema: { type: string, example: "john.doe@workforce.com" }
 *     responses:
 *       200:
 *         description: Prefill data
 *       403:
 *         description: Unauthorized email/role
 *       503:
 *         description: Employees service unavailable
 */
router.get("/api/auth/prefill", async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: "Email is required" });

    let employee;
    try {
      employee = await findEmployeeByEmail(email);
    } catch (e) {
      console.error("Employees API error:", e);
      return res.status(503).json({ error: "Employees service unavailable" });
    }

    if (!employee) {
      return res
        .status(403)
        .json({ error: "Unauthorized to register for this system." });
    }

    const role = normalizeRole(employee?.role);
    if (!ALLOWED_EMPLOYEE_ROLES.has(role)) {
      return res.status(403).json({
        error: "Unauthorized to register for this system.",
      });
    }

    const username = pickEmployeeUsername(employee);
    if (!username) {
      return res
        .status(403)
        .json({ error: "Unauthorized to register for this system." });
    }

    return res.json({
      email: normalizeEmail(employee?.email),
      username,
      name: buildFullName(employee),
      firstName: employee?.firstName || "",
      lastName: employee?.lastName || "",
      role,
      employeeId: pickEmployeeId(employee),
      department: employee?.department || "",
      position: employee?.position || "",
      userId: employee?.userId || "",
    });
  } catch (err) {
    console.error("Prefill error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     summary: Register by email + password (username auto from employee system)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: "john.doe@workforce.com" }
 *               password: { type: string, example: "1234" }
 *     responses:
 *       200: { description: Registered }
 *       400: { description: Validation / already registered }
 *       403: { description: Not allowed }
 *       503: { description: Employees service unavailable }
 */
router.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    let employee;
    try {
      employee = await findEmployeeByEmail(email);
    } catch (e) {
      console.error("Employees API error:", e);
      return res.status(503).json({ error: "Employees service unavailable" });
    }

    if (!employee) {
      return res.status(403).json({
        error: "Registration denied. You are not authorized to register.",
      });
    }

    const role = normalizeRole(employee?.role);
    if (!ALLOWED_EMPLOYEE_ROLES.has(role)) {
      return res.status(403).json({
        error: "Registration denied. You are not authorized to register.",
      });
    }

    const usernameRaw = pickEmployeeUsername(employee);
    if (!usernameRaw) {
      return res
        .status(403)
        .json({ error: "Registration denied. You are not authorized to register." });
    }

    const username = normalizeUsername(usernameRaw);
    const normEmail = normalizeEmail(email);

    const existing = await db.collection("users").findOne({
      $or: [{ email: normEmail }, { username }],
    });
    if (existing) {
      return res.status(400).json({
        error: "User already registered (email/username already exists).",
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    const newUser = {
      email: normEmail,
      username,
      displayUsername: usernameRaw,
      role,

      name: buildFullName(employee),
      firstName: employee?.firstName || "",
      lastName: employee?.lastName || "",
      department: employee?.department || "",
      position: employee?.position || "",

      employeeId: pickEmployeeId(employee),
      userId: employee?.userId || null,

      password: hashed,
      createdAt: new Date(),
    };

    const result = await db.collection("users").insertOne(newUser);
    const created = { ...newUser, _id: result.insertedId };

    const token = signToken(created);

    return res.json({
      message: "Registration successful",
      token,
      user: safeUser(created),
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     summary: Login with username + password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, example: "pm_john" }
 *               password: { type: string, example: "1234" }
 *     responses:
 *       200: { description: Logged in }
 *       400: { description: Invalid username or password }
 */
router.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const normUsername = normalizeUsername(username);

    const user = await db
      .collection("users")
      .findOne({ username: normUsername });
    if (!user)
      return res.status(400).json({ error: "Invalid username or password" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(400).json({ error: "Invalid username or password" });

    const token = signToken(user);

    return res.json({
      message: "Login successful",
      token,
      user: safeUser(user),
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * @openapi
 * /api/auth/change-password:
 *   post:
 *     summary: Change password for current user (requires Bearer token)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oldPassword, newPassword]
 *             properties:
 *               username: { type: string }
 *               oldPassword: { type: string }
 *               newPassword: { type: string }
 *     responses:
 *       200: { description: Password updated }
 *       400: { description: Validation error }
 */
router.post("/api/auth/change-password", authMiddleware, async (req, res) => {
  try {
    const { username, oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Old and new passwords are required" });
    }

    const tokenUsername = normalizeUsername(req.user?.username);
    if (!tokenUsername) {
      return res.status(401).json({ error: "Token invalid or expired" });
    }

    const bodyUsername = username
      ? normalizeUsername(username)
      : tokenUsername;
    if (bodyUsername !== tokenUsername) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const user = await db
      .collection("users")
      .findOne({ username: tokenUsername });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match)
      return res.status(400).json({ error: "Invalid credentials" });

    const hashed = await bcrypt.hash(newPassword, 10);

    await db
      .collection("users")
      .updateOne({ username: tokenUsername }, { $set: { password: hashed } });

    return res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
