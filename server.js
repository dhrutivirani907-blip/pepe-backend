const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));

// CORS: the app does not use cookie credentials, so allow requests from web and Capacitor WebViews.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false }));

const required = ["DATABASE_URL", "JWT_SECRET"];
for (const key of required) if (!process.env[key]) {
  console.error(`Missing required environment variable: ${key}`);
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
const PORT = Number(process.env.PORT || 3000);
const REWARD_MIN = 12000, REWARD_MAX = 15000, VISIT_SECONDS = 8;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(60) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      total_points BIGINT NOT NULL DEFAULT 0 CHECK (total_points >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reward_cards (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      points INTEGER NOT NULL CHECK (points BETWEEN 12000 AND 15000),
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','earned')),
      visit_started_at TIMESTAMPTZ,
      earned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS reward_cards_user_created_idx ON reward_cards(user_id, created_at DESC);
  `);
}
function makeToken(user) {
  return jwt.sign({ sub: String(user.id) }, process.env.JWT_SECRET, { expiresIn: "30d", issuer: "screech-card" });
}
async function auth(req, res, next) {
  try {
    const value = req.headers.authorization || "";
    if (!value.startsWith("Bearer ")) return res.status(401).json({ error: "Please log in to continue." });
    const decoded = jwt.verify(value.slice(7), process.env.JWT_SECRET, { issuer: "screech-card" });
    const result = await pool.query("SELECT id,name,email,total_points FROM app_users WHERE id=$1", [decoded.sub]);
    if (!result.rowCount) return res.status(401).json({ error: "Account not found. Please log in again." });
    req.user = result.rows[0]; next();
  } catch { return res.status(401).json({ error: "Your session expired. Please log in again." }); }
}
const emailOk = s => typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
app.post("/api/auth/signup", async (req,res) => {
  try {
    const name = String(req.body.name || "").trim(), email = String(req.body.email || "").trim().toLowerCase(), password = req.body.password;
    if (name.length < 2 || name.length > 60) return res.status(400).json({error:"Name must be between 2 and 60 characters."});
    if (!emailOk(email)) return res.status(400).json({error:"Enter a valid email address."});
    if (typeof password !== "string" || password.length < 8 || password.length > 72) return res.status(400).json({error:"Password must be 8 to 72 characters."});
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query("INSERT INTO app_users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,total_points", [name,email,hash]);
    const user = r.rows[0]; res.status(201).json({token:makeToken(user),user:{id:user.id,name:user.name,email:user.email,points:Number(user.total_points)}});
  } catch(e) { if(e.code==="23505") return res.status(409).json({error:"This email is already registered. Please log in."}); console.error(e);res.status(500).json({error:"Could not create account. Please try again."}); }
});
app.post("/api/auth/login", async (req,res) => {
  try {
    const email=String(req.body.email||"").trim().toLowerCase(), password=req.body.password;
    if(!emailOk(email)||typeof password!=="string")return res.status(400).json({error:"Enter your email and password."});
    const r=await pool.query("SELECT id,name,email,password_hash,total_points FROM app_users WHERE email=$1",[email]);
    if(!r.rowCount || !(await bcrypt.compare(password,r.rows[0].password_hash)))return res.status(401).json({error:"Incorrect email or password."});
    const u=r.rows[0];res.json({token:makeToken(u),user:{id:u.id,name:u.name,email:u.email,points:Number(u.total_points)}});
  }catch(e){console.error(e);res.status(500).json({error:"Login failed. Please try again."});}
});
app.get("/api/me",auth,(req,res)=>res.json({user:{id:req.user.id,name:req.user.name,email:req.user.email,points:Number(req.user.total_points)}}));
app.post("/api/cards/new",auth,async(req,res)=>{
  try{
    const existing=await pool.query("SELECT id,points,created_at FROM reward_cards WHERE user_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[req.user.id]);
    if(existing.rowCount){const c=existing.rows[0];return res.json({id:c.id,points:c.points,cardNumber:await cardNumber(req.user.id,c.id)});}
    const points=crypto.randomInt(REWARD_MIN,REWARD_MAX+1),id=crypto.randomUUID();
    await pool.query("INSERT INTO reward_cards(id,user_id,points) VALUES($1,$2,$3)",[id,req.user.id,points]);
    res.status(201).json({id,points,cardNumber:await cardNumber(req.user.id,id)});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create a card."});}
});
async function cardNumber(userId,id){const r=await pool.query("SELECT COUNT(*)::int AS n FROM reward_cards WHERE user_id=$1 AND created_at <= (SELECT created_at FROM reward_cards WHERE id=$2)",[userId,id]);return r.rows[0].n;}
app.post("/api/cards/:id/visit-start",auth,async(req,res)=>{
  try{
    const r=await pool.query("UPDATE reward_cards SET visit_started_at=NOW() WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id",[req.params.id,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:"This card is not available."});
    res.json({ok:true,minimumSeconds:VISIT_SECONDS});
  }catch(e){console.error(e);res.status(500).json({error:"Could not start visit verification."});}
});
app.post("/api/cards/:id/claim",auth,async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query("SELECT id,points,status,visit_started_at FROM reward_cards WHERE id=$1 AND user_id=$2 FOR UPDATE",[req.params.id,req.user.id]);
    if(!r.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Card not found."});}
    const c=r.rows[0];
    if(c.status==="earned"){const u=await client.query("SELECT total_points FROM app_users WHERE id=$1",[req.user.id]);await client.query("COMMIT");return res.json({earned:true,alreadyClaimed:true,points:c.points,totalPoints:Number(u.rows[0].total_points)});}
    if(!c.visit_started_at){await client.query("ROLLBACK");return res.status(400).json({error:"Open the reward link first."});}
    const elapsed=Date.now()-new Date(c.visit_started_at).getTime();
    if(elapsed<VISIT_SECONDS*1000){await client.query("ROLLBACK");return res.json({earned:false,secondsRemaining:Math.ceil((VISIT_SECONDS*1000-elapsed)/1000)});}
    await client.query("UPDATE reward_cards SET status='earned',earned_at=NOW() WHERE id=$1",[c.id]);
    const u=await client.query("UPDATE app_users SET total_points=total_points+$1 WHERE id=$2 RETURNING total_points",[c.points,req.user.id]);
    await client.query("COMMIT");
    res.json({earned:true,points:c.points,totalPoints:Number(u.rows[0].total_points)});
  }catch(e){await client.query("ROLLBACK");console.error(e);res.status(500).json({error:"Could not verify your reward."});}
  finally{client.release();}
});
app.get("/health",(_,res)=>res.json({ok:true}));
const publicDir = path.join(__dirname, "public");
const fs = require("fs");
if (fs.existsSync(path.join(publicDir, "index.html"))) {
  app.use(express.static(publicDir));
  app.get("/{*splat}", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
} else {
  app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
}
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:"Internal server error."});});
initDb().then(()=>app.listen(PORT,()=>console.log(`Screech Card server running on port ${PORT}`))).catch(e=>{console.error("Database initialization failed:",e);process.exit(1);});
