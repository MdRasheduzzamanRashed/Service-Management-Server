// routes/auth.js  (STYLE 1: full /api/... paths inside router)
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { db } from "../db.js";
import { XMLParser } from "fast-xml-parser";

dotenv.config();
const router = express.Router();

const EMPLOYEES_API =
  "https://workforcemangementtool.onrender.com/api/employees";

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
  if (!process.env.JWT_SECRET) throw new Error("Missing JWT_SECRET");

  return jwt.sign(
    {
      _id: String(u._id),
      employeeId: u.employeeId ? String(u.employeeId) : "",
      userId: u.userId ? String(u.userId) : "",
      username: u.username || "",
      email: u.email || "",
      role: u.role || "",
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
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
  // XML includes <id> and <employeeId>
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
  const res = await fetch(EMPLOYEES_API, {
    headers: { Accept: "application/xml, text/xml, application/json" },
  });

  if (!res.ok) throw new Error(`Employees API failed: ${res.status}`);

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const raw = await res.text();

  // JSON fallback (if API ever returns JSON)
  if (contentType.includes("application/json")) {
    const json = JSON.parse(raw);
    const employees = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(employees)) throw new Error("Employees JSON invalid");
    return employees;
  }

  // XML parse
  const parsed = xmlParser.parse(raw);

  // expected: { List: { item: [...] } }
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
   STYLE 1 ROUTES (full paths)
============================================================ */

/**
 * ✅ GET /api/auth/prefill?email=
 * verifies employee email + role
 * returns name/username/role (NO companyName)
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
        .json({ error: "Unauthorized email. Not found in employee records." });
    }

    const role = normalizeRole(employee?.role);
    if (!ALLOWED_EMPLOYEE_ROLES.has(role)) {
      return res.status(403).json({
        error: "Unauthorized role. You cannot register for this system.",
        roleFound: role,
      });
    }

    const username = pickEmployeeUsername(employee);
    if (!username) {
      return res.status(403).json({
        error: "Username missing in employee record. Contact admin.",
      });
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
 * ✅ POST /api/auth/register
 * body: { email, password }
 * auto-fills username/name/role/etc from employees API (NO companyName)
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
        error: "Registration denied. Email not found in employee records.",
      });
    }

    const role = normalizeRole(employee?.role);
    if (!ALLOWED_EMPLOYEE_ROLES.has(role)) {
      return res.status(403).json({
        error:
          "Registration denied. Only PROJECT_MANAGER, RESOURCE_PLANNER, PROCUREMENT_OFFICER, SYSTEM_ADMIN can register.",
        roleFound: role,
      });
    }

    const usernameRaw = pickEmployeeUsername(employee);
    if (!usernameRaw) {
      return res.status(403).json({
        error: "Username missing in employee record. Contact admin.",
      });
    }

    const username = normalizeUsername(usernameRaw);
    const normEmail = normalizeEmail(email);

    // prevent duplicates by email OR username
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
      username, // normalized username used for login
      displayUsername: usernameRaw, // show on UI

      role, // stored exactly like employees role enum

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
 * ✅ POST /api/auth/login
 * body: { username, password }
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
    if (!user) {
      return res.status(400).json({ error: "Invalid username or password" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(400).json({ error: "Invalid username or password" });
    }

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
 * ✅ POST /api/auth/change-password
 * body: { username, oldPassword, newPassword }
 */
router.post("/api/auth/change-password", async (req, res) => {
  try {
    const { username, oldPassword, newPassword } = req.body || {};

    if (!username || !oldPassword || !newPassword) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const normUsername = normalizeUsername(username);

    const user = await db
      .collection("users")
      .findOne({ username: normUsername });
    if (!user) return res.status(400).json({ error: "User not found" });

    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match)
      return res.status(400).json({ error: "Old password is incorrect" });

    const hashed = await bcrypt.hash(newPassword, 10);

    await db
      .collection("users")
      .updateOne({ username: normUsername }, { $set: { password: hashed } });

    return res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
