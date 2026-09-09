require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const db = new Database(path.join(__dirname, "cvforge.sqlite"));

app.use("/api/payments/stripe/webhook", express.raw({type:"application/json"}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cvs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  template TEXT NOT NULL DEFAULT 'classic',
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_reference TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  month_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, month_key),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

try { db.prepare("ALTER TABLE cvs ADD COLUMN template TEXT NOT NULL DEFAULT 'classic'").run(); } catch {}

function signUser(user) {
  return jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: "7d" });
}

function setAuthCookie(res, token) {
  res.cookie("cvforge_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function authRequired(req, res, next) {
  try {
    const token = req.cookies.cvforge_token;
    if (!token) return res.status(401).json({ error: "Please log in." });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please log in again." });
  }
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function aiLimitFor(plan) {
  return plan === "pro" ? Number(process.env.PRO_AI_LIMIT || 100) : Number(process.env.FREE_AI_LIMIT || 3);
}

function getUsage(userId) {
  const row = db.prepare("SELECT count FROM ai_usage WHERE user_id=? AND month_key=?").get(userId, monthKey());
  return row ? row.count : 0;
}

function consumeUsage(userId) {
  db.prepare(`
    INSERT INTO ai_usage(user_id, month_key, count) VALUES(?,?,1)
    ON CONFLICT(user_id, month_key) DO UPDATE SET count=count+1
  `).run(userId, monthKey());
}

async function callOpenAI(instruction) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("AI is not configured yet. Add OPENAI_API_KEY to the server .env file.");
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
      input: instruction
    })
  });

  const body = await response.json();
  if (!response.ok) {
    const err = new Error(body?.error?.message || "The AI provider returned an error.");
    err.status = response.status;
    throw err;
  }

  const text = body.output_text ||
    (body.output || [])
      .flatMap(item => item.content || [])
      .map(part => part.text || "")
      .join("")
      .trim();

  if (!text) throw new Error("The AI provider returned an empty response.");
  return text.trim();
}

function safeJson(text) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned);
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const normalized = String(email).trim().toLowerCase();
    const existing = db.prepare("SELECT id FROM users WHERE email=?").get(normalized);
    if (existing) return res.status(409).json({ error: "An account with that email already exists." });

    const hash = await bcrypt.hash(password, 12);
    const info = db.prepare("INSERT INTO users(name,email,password_hash) VALUES(?,?,?)").run(String(name).trim(), normalized, hash);
    const user = db.prepare("SELECT id,name,email,plan FROM users WHERE id=?").get(info.lastInsertRowid);
    setAuthCookie(res, signUser(user));
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = db.prepare("SELECT * FROM users WHERE email=?").get(String(email || "").trim().toLowerCase());
    if (!user || !(await bcrypt.compare(String(password || ""), user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const safeUser = { id: user.id, name: user.name, email: user.email, plan: user.plan };
    setAuthCookie(res, signUser(safeUser));
    res.json({ user: safeUser });
  } catch {
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("cvforge_token");
  res.json({ ok: true });
});

app.get("/api/auth/me", authRequired, (req, res) => {
  const user = db.prepare("SELECT id,name,email,plan FROM users WHERE id=?").get(req.user.id);
  res.json({ user, aiUsage: getUsage(user.id), aiLimit: aiLimitFor(user.plan) });
});

app.get("/api/cvs", authRequired, (req, res) => {
  const rows = db.prepare("SELECT id,title,data_json,template,created_at,updated_at FROM cvs WHERE user_id=? ORDER BY updated_at DESC").all(req.user.id);
  res.json({ cvs: rows.map(r => ({ ...r, data: JSON.parse(r.data_json) })) });
});

app.post("/api/cvs", authRequired, (req, res) => {
  const { title, data, template } = req.body || {};
  if (!title || !data) return res.status(400).json({ error: "CV title and data are required." });
  const info = db.prepare("INSERT INTO cvs(user_id,title,data_json,template,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)")
    .run(req.user.id, String(title), JSON.stringify(data), String(template || "classic"));
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/cvs/:id", authRequired, (req, res) => {
  const { title, data, template } = req.body || {};
  const result = db.prepare("UPDATE cvs SET title=?, data_json=?, template=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?")
    .run(String(title || "My CV"), JSON.stringify(data || {}), String(template || "classic"), req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: "CV not found." });
  res.json({ ok: true });
});

app.delete("/api/cvs/:id", authRequired, (req, res) => {
  const result = db.prepare("DELETE FROM cvs WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: "CV not found." });
  res.json({ ok: true });
});

app.get("/api/ai/usage", authRequired, (req, res) => {
  res.json({ plan: req.user.plan, used: getUsage(req.user.id), limit: aiLimitFor(req.user.plan) });
});

app.post("/api/ai/generate", authRequired, async (req, res) => {
  try {
    const usage = getUsage(req.user.id);
    const limit = aiLimitFor(req.user.plan);
    if (usage >= limit) {
      return res.status(429).json({
        error: req.user.plan === "free"
          ? "You have reached the Free AI limit. Upgrade to Pro for more AI generations."
          : "You have reached this month's AI limit."
      });
    }

    const { mode, cv, jobDescription, targetRole } = req.body || {};
    const input = JSON.stringify({ mode, cv, jobDescription, targetRole });

    const instruction = `
You are CVForge AI, a professional CV-writing assistant.
Create concise, truthful, job-relevant content. Never invent employers, degrees,
certifications, dates, achievements, metrics, or skills that the user did not provide.
If information is missing, improve wording without fabricating facts.

Task mode: ${mode || "summary"}
Target role: ${targetRole || "Not specified"}
Job description: ${jobDescription || "Not provided"}
Current CV data:
${input}

Return ONLY valid JSON with this structure:
{
  "summary": "string",
  "experience": [
    {"role":"string","company":"string","bullets":["string","string","string"]}
  ],
  "skills": ["string"],
  "coverLetter": "string"
}

For modes other than a specific field, still return all keys, using empty values where not requested.
`.trim();

    const raw = await callOpenAI(instruction);
    let result;
    try { result = safeJson(raw); }
    catch { result = { summary: raw, experience: [], skills: [], coverLetter: "" }; }

    consumeUsage(req.user.id);
    res.json({ result, used: usage + 1, limit });
  } catch (e) {
    const status = e.code === "AI_NOT_CONFIGURED" ? 503 : (e.status && e.status >= 400 ? 502 : 500);
    res.status(status).json({ error: e.message || "AI generation failed." });
  }
});



async function stripeRequest(endpoint, params) {
  if (!process.env.STRIPE_SECRET_KEY) {
    const e = new Error("Stripe is not configured. Add STRIPE_SECRET_KEY to .env.");
    e.code = "STRIPE_NOT_CONFIGURED";
    throw e;
  }
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.append(key, value);
  const r = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || "Stripe request failed.");
  return d;
}

app.post("/api/payments/checkout", authRequired, async (req, res) => {
  try {
    const { plan } = req.body || {};
    const priceId = plan === "pro"
      ? process.env.STRIPE_PRO_PRICE_ID
      : plan === "career"
        ? process.env.STRIPE_CAREER_PRICE_ID
        : null;

    if (!priceId) return res.status(400).json({error:"That plan is not configured yet."});

    const user = db.prepare("SELECT id,email FROM users WHERE id=?").get(req.user.id);
    const mode = plan === "pro" ? "subscription" : "payment";
    const base = process.env.APP_URL || "http://localhost:3000";
    const params = {
      mode,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${base}/?payment=success`,
      cancel_url: `${base}/?payment=cancelled`,
      customer_email: user.email,
      client_reference_id: String(user.id),
      "metadata[user_id]": String(user.id),
      "metadata[plan]": plan
    };
    if (mode === "subscription") {
      params["subscription_data[metadata][user_id]"] = String(user.id);
      params["subscription_data[metadata][plan]"] = plan;
    }
    const session = await stripeRequest("checkout/sessions", params);
    res.json({url: session.url});
  } catch (e) {
    res.status(e.code === "STRIPE_NOT_CONFIGURED" ? 503 : 502).json({error:e.message});
  }
});

function verifyStripeSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const pairs = signature.split(",").map(x => x.split("="));
  const timestamp = pairs.find(x => x[0] === "t")?.[1];
  const provided = pairs.find(x => x[0] === "v1")?.[1];
  if (!timestamp || !provided) return false;
  const age = Math.floor(Date.now()/1000) - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return expected.length === provided.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

app.post("/api/payments/stripe/webhook", (req, res) => {
  const raw = req.body.toString("utf8");
  if (!verifyStripeSignature(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).send("Invalid signature");
  }
  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).send("Invalid JSON"); }
  const obj = event.data?.object || {};
  const metadata = obj.metadata || {};
  const userId = Number(metadata.user_id || obj.client_reference_id);
  const plan = metadata.plan;

  if (event.type === "checkout.session.completed" && userId && plan) {
    db.prepare("UPDATE users SET plan=? WHERE id=?").run(plan === "pro" ? "pro" : "career", userId);
    db.prepare("INSERT OR IGNORE INTO payments(user_id,provider,provider_reference,plan,status) VALUES(?,?,?,?,?)")
      .run(userId, "stripe", obj.id, plan, "paid");
  }
  if (event.type === "customer.subscription.deleted" && userId) {
    db.prepare("UPDATE users SET plan='free' WHERE id=?").run(userId);
  }
  res.json({received:true});
});

app.get("/api/plans", (req, res) => {
  res.json({
    plans: [
      { id:"free", name:"Free", price:0, aiLimit:Number(process.env.FREE_AI_LIMIT||3), features:["1 CV","3 AI generations/month","Classic template","Print/PDF"] },
      { id:"pro", name:"Pro", price:2500, aiLimit:Number(process.env.PRO_AI_LIMIT||100), features:["Unlimited CV saves","100 AI generations/month","Premium templates","AI job tailoring","Cover letter tools"] },
      { id:"career", name:"Career Pack", price:5000, aiLimit:20, features:["CV + cover letter","Application email","Premium templates","One-time purchase"] }
    ]
  });
});

app.post("/api/checkout/start", authRequired, (req, res) => {
  const { plan } = req.body || {};
  if (!["pro","career"].includes(plan)) return res.status(400).json({error:"Invalid plan."});
  res.json({
    ready: false,
    message: "Checkout endpoint is ready for Paystack/Flutterwave server-side integration.",
    plan
  });
});

app.post("/api/cvs/:id/pdf", authRequired, (req, res) => {
  const cv = db.prepare("SELECT title,data_json,template FROM cvs WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!cv) return res.status(404).json({error:"CV not found."});
  let data;
  try { data = JSON.parse(cv.data_json); } catch { return res.status(400).json({error:"Invalid CV data."}); }

  const doc = new PDFDocument({size:"A4", margin:48});
  const filename = `${String(cv.title || "CV").replace(/[^a-z0-9_-]+/gi,"_")}.pdf`;
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
  doc.pipe(res);

  const accent = cv.template === "modern" ? "#4f46e5" : cv.template === "minimal" ? "#222222" : "#365f91";
  const text = value => String(value || "").replace(/\s+/g," ").trim();

  doc.fontSize(25).fillColor(accent).font("Helvetica-Bold").text(text(data.name) || "Your Name");
  doc.moveDown(.2).fontSize(12).fillColor("#333").font("Helvetica").text(text(data.role) || "Target Role");
  doc.moveDown(1);

  const section = (title, body) => {
    doc.fontSize(12).fillColor(accent).font("Helvetica-Bold").text(title.toUpperCase());
    doc.moveDown(.25);
    doc.fontSize(10.5).fillColor("#222").font("Helvetica").text(body || "Not provided", {lineGap:3});
    doc.moveDown(.7);
  };

  section("Professional Summary", text(data.summary));
  section("Experience", text(data.experience));
  section("Skills", text(data.skills));
  if (data.education) section("Education", text(data.education));
  if (data.certifications) section("Certifications", text(data.certifications));

  doc.end();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`CVForge AI running at http://localhost:${PORT}`);
});
