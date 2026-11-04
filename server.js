'use strict';

// Redeem + Earn app backend. Keeps the existing PostgreSQL database and legacy
// GRAM tables intact; new features use separate app_* tables.
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Password']
}));
app.use(express.json({ limit: '1mb' }));

const COIN_RATES = { 10: 1500, 20: 3000, 50: 7500, 100: 15000 };
const REFERRAL_REWARD = 100;
const WELCOME_BONUS = 0;
const SUPER_OFFER_GEM_COST = 25;

async function initDb() {
  // These are additive migrations only. Existing withdrawals/referrals are not dropped or rewritten.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      user_id VARCHAR(180) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(254) NOT NULL,
      password_hash TEXT,
      coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
      gems BIGINT NOT NULL DEFAULT 0 CHECK (gems >= 0),
      referral_code VARCHAR(40) UNIQUE NOT NULL,
      referred_by VARCHAR(180),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_uq ON app_users (LOWER(email));
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions(user_id);
    CREATE TABLE IF NOT EXISTS app_redeem_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id),
      name VARCHAR(120) NOT NULL,
      email VARCHAR(254) NOT NULL,
      amount_inr INTEGER NOT NULL CHECK (amount_inr IN (10,20,50,100)),
      coins_deducted BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed','Rejected')),
      redeem_code VARCHAR(100),
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS app_redeem_user_idx ON app_redeem_requests(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS app_notifications (
      id BIGSERIAL PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_game_sessions (
      id UUID PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      claimed BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS app_game_ball_visits (
      session_id UUID NOT NULL REFERENCES app_game_sessions(id) ON DELETE CASCADE,
      ball_index INTEGER NOT NULL CHECK (ball_index BETWEEN 0 AND 3),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY(session_id, ball_index)
    );
    CREATE TABLE IF NOT EXISTS app_super_offers (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id),
      coins_awarded INTEGER NOT NULL,
      gems_spent INTEGER NOT NULL DEFAULT 25,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id),
      referred_id VARCHAR(180) NOT NULL UNIQUE REFERENCES app_users(user_id),
      reward INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (referrer_id <> referred_id)
    );
  `);
  console.log('Redeem app database ready (legacy tables preserved).');
}

function cleanId(v) { return String(v || '').trim().slice(0, 180); }
function adminOnly(req, res, next) {
  const supplied = req.headers['x-admin-password'] || req.body?.adminPassword || req.query?.adminPassword || '';
  if (!ADMIN_PASSWORD || supplied !== ADMIN_PASSWORD) return res.status(401).json({ success:false, message:'Invalid admin password. Set ADMIN_PASSWORD on Render.' });
  next();
}
async function userOnly(req, res, next) {
  const id = cleanId(req.body?.userId || req.params?.userId || req.query?.userId);
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!id || !token) return res.status(401).json({ success:false, message:'Please log in to continue.' });
  try {
    const tokenHash = hashToken(token);
    const session = await pool.query(
      'SELECT user_id FROM app_sessions WHERE token_hash=$1 AND expires_at>NOW()',
      [tokenHash]
    );
    if (!session.rowCount || session.rows[0].user_id !== id) {
      return res.status(401).json({ success:false, message:'Your session has expired. Please log in again.' });
    }
    req.userId = id;
    req.sessionTokenHash = tokenHash;
    next();
  } catch (e) {
    console.error('session check', e);
    res.status(500).json({ success:false, message:'Could not verify your login.' });
  }
}

app.get('/', (_req,res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (_req,res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_req,res) => res.json({ success:true, app:'Premium Redeem & Earn', database: !!process.env.DATABASE_URL }));

// Password-based accounts. A random session token is stored only as a SHA-256 hash.
function normalizeEmail(value) { return String(value || '').trim().toLowerCase().slice(0, 254); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve('scrypt$' + salt.toString('hex') + '$' + key.toString('hex'));
    });
  });
}
function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    try {
      const parts = String(stored || '').split('$');
      if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
      const salt = Buffer.from(parts[1], 'hex');
      const expected = Buffer.from(parts[2], 'hex');
      crypto.scrypt(String(password), salt, expected.length, (err, actual) => {
        if (err) return reject(err);
        resolve(actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
      });
    } catch (e) { reject(e); }
  });
}
async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await pool.query('INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hashToken(token), userId, expires]);
  const q = await pool.query('SELECT user_id AS "userId",name,email,coins,gems,referral_code AS "referralCode" FROM app_users WHERE user_id=$1', [userId]);
  res.json({ success: true, token, expiresAt: expires.toISOString(), user: q.rows[0] });
}
app.post('/api/auth/signup', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const referralCode = String(req.body.referralCode || '').trim().toUpperCase().slice(0, 40);
  if (name.length < 2 || !validEmail(email) || password.length < 8 || password.length > 200) {
    return res.status(400).json({ success: false, message: 'Enter a valid name, email and password (8–200 characters).' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT user_id FROM app_users WHERE LOWER(email)=LOWER($1) FOR UPDATE', [email]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'This email already has an account. Please use the Login tab.' });
    }
    const userId = 'usr_' + crypto.randomUUID();
    const ownCode = 'R' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const passwordHash = await hashPassword(password);
    let referrer = null;
    if (referralCode) {
      const found = await client.query('SELECT user_id FROM app_users WHERE referral_code=$1', [referralCode]);
      if (found.rowCount) referrer = found.rows[0].user_id;
    }
    await client.query(
      `INSERT INTO app_users(user_id,name,email,password_hash,coins,gems,referral_code,referred_by)
       VALUES($1,$2,$3,$4,$5,0,$6,$7)`,
      [userId, name, email, passwordHash, WELCOME_BONUS, ownCode, referrer]
    );
    if (referrer && referrer !== userId) {
      await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1', [referrer, REFERRAL_REWARD]);
      await client.query('INSERT INTO app_referrals(referrer_id,referred_id,reward) VALUES($1,$2,$3) ON CONFLICT(referred_id) DO NOTHING', [referrer, userId, REFERRAL_REWARD]);
    }
    await client.query('COMMIT');
    await createSession(userId, res);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('signup', e);
    if (e.code === '23505') return res.status(409).json({ success: false, message: 'This email already has an account. Please use the Login tab.' });
    res.status(500).json({ success: false, message: 'Could not create your account. Please try again.' });
  } finally { client.release(); }
});
app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!validEmail(email) || !password) return res.status(400).json({ success: false, message: 'Enter your email and password.' });
  try {
    const q = await pool.query('SELECT user_id,password_hash FROM app_users WHERE LOWER(email)=LOWER($1)', [email]);
    if (!q.rowCount) return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    if (!q.rows[0].password_hash) {
      return res.status(409).json({ success: false, message: 'This account was created before password login was added. Please contact support to securely activate password login.' });
    }
    const ok = await verifyPassword(password, q.rows[0].password_hash);
    if (!ok) return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    await createSession(q.rows[0].user_id, res);
  } catch (e) {
    console.error('login', e);
    res.status(500).json({ success: false, message: 'Could not log in. Please try again.' });
  }
});
app.post('/api/auth/logout', userOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [req.sessionTokenHash]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: 'Could not log out.' }); }
});

// Restore the current account directly from its bearer token.
app.get('/api/auth/me', async (req,res) => {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({success:false,message:'No saved login session.'});
  try {
    const tokenHash = hashToken(token);
    const r = await pool.query(
      `SELECT u.user_id AS "userId",u.name,u.email,u.coins,u.gems,
              u.referral_code AS "referralCode"
       FROM app_sessions s
       JOIN app_users u ON u.user_id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>NOW()
       LIMIT 1`,
      [tokenHash]
    );
    if (!r.rowCount) return res.status(401).json({success:false,message:'Your login session has expired. Please log in again.'});
    return res.json({success:true,user:r.rows[0]});
  } catch (e) {
    console.error('session restore',e);
    return res.status(500).json({success:false,message:'Could not restore your account. Please try again.'});
  }
});

app.get('/api/user/:userId', userOnly, async (req,res) => {
  try {
    const r = await pool.query('SELECT user_id AS "userId",name,email,coins,gems,referral_code AS "referralCode" FROM app_users WHERE user_id=$1',[cleanId(req.params.userId)]);
    if (!r.rowCount) return res.status(404).json({success:false,message:'User not found.'});
    res.json({success:true,user:r.rows[0]});
  } catch(e) { res.status(500).json({success:false,message:'Could not load account.'}); }
});

app.get('/api/redeems/:userId', userOnly, async (req,res) => {
  try { const r=await pool.query(`SELECT id,amount_inr AS amount,coins_deducted AS "coinsDeducted",status,redeem_code AS "redeemCode",created_at AS "createdAt",updated_at AS "updatedAt" FROM app_redeem_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[cleanId(req.params.userId)]); res.json({success:true,requests:r.rows}); }
  catch(e){res.status(500).json({success:false,message:'Could not load redeem history.'});}
});

app.post('/api/redeems', userOnly, async (req,res) => {
  const amount = Number(req.body.amount);
  const coins = COIN_RATES[amount];
  if (!coins) return res.status(400).json({success:false,message:'Choose a valid redeem amount.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const ur=await client.query('SELECT name,email,coins FROM app_users WHERE user_id=$1 FOR UPDATE',[req.userId]);
    if(!ur.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Account not found. Please sign in again.'});}
    if(Number(ur.rows[0].coins)<coins){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Not enough coins for this redeem amount.'});}
    await client.query('UPDATE app_users SET coins=coins-$2,updated_at=NOW() WHERE user_id=$1',[req.userId,coins]);
    const rr=await client.query(`INSERT INTO app_redeem_requests(user_id,name,email,amount_inr,coins_deducted) VALUES($1,$2,$3,$4,$5) RETURNING id,amount_inr AS amount,coins_deducted AS "coinsDeducted",status,redeem_code AS "redeemCode",created_at AS "createdAt"`,[req.userId,ur.rows[0].name,ur.rows[0].email,amount,coins]);
    const bal=await client.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);
    await client.query('COMMIT');
    res.json({success:true,request:rr.rows[0],balance:bal.rows[0]});
  } catch(e){await client.query('ROLLBACK');console.error('redeem create',e);res.status(500).json({success:false,message:'Could not submit redeem request.'});}
  finally{client.release();}
});

app.get('/api/notifications', async (_req,res)=>{try{const r=await pool.query('SELECT id,title,message,created_at AS "createdAt" FROM app_notifications ORDER BY created_at DESC LIMIT 50');res.json({success:true,notifications:r.rows});}catch(e){res.status(500).json({success:false,message:'Could not load notifications.'});}});

app.post('/api/game/start', userOnly, async (req,res)=>{
  try{const u=await pool.query('SELECT user_id FROM app_users WHERE user_id=$1',[req.userId]);if(!u.rowCount)return res.status(404).json({success:false,message:'Sign in first.'});const id=crypto.randomUUID();await pool.query('INSERT INTO app_game_sessions(id,user_id) VALUES($1,$2)',[id,req.userId]);res.json({success:true,sessionId:id});}
  catch(e){res.status(500).json({success:false,message:'Could not start game.'});}
});
app.post('/api/game/ball/start', userOnly, async (req,res)=>{
  const sessionId=String(req.body.sessionId||''); const ball=Number(req.body.ballIndex);
  if(!Number.isInteger(ball)||ball<0||ball>3)return res.status(400).json({success:false,message:'Invalid ball.'});
  try{
    const s=await pool.query('SELECT id,claimed FROM app_game_sessions WHERE id=$1 AND user_id=$2',[sessionId,req.userId]);
    if(!s.rowCount||s.rows[0].claimed)return res.status(400).json({success:false,message:'Game session is not active.'});
    const old=await pool.query('SELECT completed_at FROM app_game_ball_visits WHERE session_id=$1 AND ball_index=$2',[sessionId,ball]);
    if(old.rowCount&&old.rows[0].completed_at)return res.json({success:true,completed:true});
    // A retry after an early return starts a fresh server-side 8-second window.
    await pool.query(`INSERT INTO app_game_ball_visits(session_id,ball_index,opened_at,completed_at) VALUES($1,$2,NOW(),NULL)
      ON CONFLICT(session_id,ball_index) DO UPDATE SET opened_at=NOW(),completed_at=NULL`,[sessionId,ball]);
    res.json({success:true,completed:false});
  }catch(e){console.error('ball start',e);res.status(500).json({success:false,message:'Could not start ball visit.'});}
});
app.post('/api/game/ball/complete', userOnly, async (req,res)=>{
  const sessionId=String(req.body.sessionId||''); const ball=Number(req.body.ballIndex);
  if(!Number.isInteger(ball)||ball<0||ball>3)return res.status(400).json({success:false,message:'Invalid ball.'});
  try{
    const s=await pool.query('SELECT id FROM app_game_sessions WHERE id=$1 AND user_id=$2 AND claimed=FALSE',[sessionId,req.userId]);
    if(!s.rowCount)return res.status(400).json({success:false,message:'Game session is not active.'});
    const v=await pool.query(`UPDATE app_game_ball_visits SET completed_at=NOW() WHERE session_id=$1 AND ball_index=$2 AND completed_at IS NULL AND opened_at<=NOW()-INTERVAL '8 seconds' RETURNING ball_index`,[sessionId,ball]);
    if(!v.rowCount){
      const exists=await pool.query('SELECT completed_at FROM app_game_ball_visits WHERE session_id=$1 AND ball_index=$2',[sessionId,ball]);
      if(exists.rowCount&&exists.rows[0].completed_at)return res.json({success:true,completed:true});
      return res.status(400).json({success:false,message:'You did not stay for at least 8 seconds. This ball is not complete.'});
    }
    res.json({success:true,completed:true});
  }catch(e){console.error('ball complete',e);res.status(500).json({success:false,message:'Could not verify ball visit.'});}
});

app.post('/api/game/claim', userOnly, async (req,res)=>{
  const id=String(req.body.sessionId||''); const client=await pool.connect();
  try{await client.query('BEGIN');const s=await client.query('SELECT id,claimed FROM app_game_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,req.userId]);if(!s.rowCount){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Game session not found.'});}if(s.rows[0].claimed){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'This game reward was already claimed.'});}const count=await client.query('SELECT COUNT(*)::int AS n FROM app_game_ball_visits WHERE session_id=$1 AND completed_at IS NOT NULL',[id]);if(count.rows[0].n!==4){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Complete all four verified 8-second visits first.'});}await client.query('UPDATE app_game_sessions SET claimed=TRUE,completed_at=NOW() WHERE id=$1',[id]);await client.query('UPDATE app_users SET gems=gems+1,updated_at=NOW() WHERE user_id=$1',[req.userId]);const u=await client.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);await client.query('COMMIT');res.json({success:true,gemsAdded:1,balance:u.rows[0]});}
  catch(e){await client.query('ROLLBACK');res.status(500).json({success:false,message:'Could not claim game reward.'});}finally{client.release();}
});

app.post('/api/super-offer/claim', userOnly, async(req,res)=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const u=await client.query('SELECT gems FROM app_users WHERE user_id=$1 FOR UPDATE',[req.userId]);if(!u.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Account not found.'});}if(Number(u.rows[0].gems)<SUPER_OFFER_GEM_COST){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'You need 25 Gems to unlock this offer.'});}const reward=270+crypto.randomInt(0,31);await client.query('UPDATE app_users SET gems=gems-$2,coins=coins+$3,updated_at=NOW() WHERE user_id=$1',[req.userId,SUPER_OFFER_GEM_COST,reward]);await client.query('INSERT INTO app_super_offers(user_id,coins_awarded,gems_spent) VALUES($1,$2,$3)',[req.userId,reward,SUPER_OFFER_GEM_COST]);const b=await client.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);const count=await client.query('SELECT COUNT(*)::int AS total FROM app_super_offers WHERE user_id=$1',[req.userId]);await client.query('COMMIT');res.json({success:true,coinsAdded:reward,gemsSpent:25,totalCompleted:count.rows[0].total,balance:b.rows[0]});}
  catch(e){await client.query('ROLLBACK');res.status(500).json({success:false,message:'Could not claim offer.'});}finally{client.release();}
});

// Admin API
app.post('/api/admin/login', (req,res)=>{if(!ADMIN_PASSWORD || String(req.body.password||'')!==ADMIN_PASSWORD)return res.status(401).json({success:false,message:'Incorrect admin password.'});res.json({success:true});});
app.get('/api/admin/redeems', adminOnly, async(_req,res)=>{try{const r=await pool.query(`SELECT id,user_id AS "userId",name,email,amount_inr AS amount,coins_deducted AS "coinsDeducted",status,redeem_code AS "redeemCode",created_at AS "createdAt" FROM app_redeem_requests ORDER BY created_at DESC LIMIT 500`);res.json({success:true,requests:r.rows});}catch(e){res.status(500).json({success:false,message:'Could not load requests.'});}});
app.put('/api/admin/redeems/:id', adminOnly, async(req,res)=>{
  const status=String(req.body.status||''); const code=String(req.body.redeemCode||'').trim().slice(0,100); const note=String(req.body.note||'').slice(0,1000);
  if(!['Pending','Completed','Rejected'].includes(status))return res.status(400).json({success:false,message:'Invalid status.'});if(status==='Completed'&&!code)return res.status(400).json({success:false,message:'Enter the Google Play redeem code before completing.'});
  const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('SELECT * FROM app_redeem_requests WHERE id=$1 FOR UPDATE',[req.params.id]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Request not found.'});}const old=q.rows[0];if(old.status==='Rejected'&&status!=='Rejected'){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Rejected requests cannot be reopened.'});}if(status==='Rejected'&&old.status!=='Rejected'){await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1',[old.user_id,old.coins_deducted]);}await client.query(`UPDATE app_redeem_requests SET status=$2,redeem_code=$3,admin_note=$4,updated_at=NOW() WHERE id=$1`,[req.params.id,status,status==='Completed'?code:null,note]);await client.query('COMMIT');res.json({success:true,message:'Request updated.'});}catch(e){await client.query('ROLLBACK');res.status(500).json({success:false,message:'Could not update request.'});}finally{client.release();}
});
app.post('/api/admin/notifications', adminOnly, async(req,res)=>{const title=String(req.body.title||'').trim().slice(0,160),message=String(req.body.message||'').trim().slice(0,3000);if(!title||!message)return res.status(400).json({success:false,message:'Enter a title and message.'});try{const r=await pool.query('INSERT INTO app_notifications(title,message) VALUES($1,$2) RETURNING id,title,message,created_at AS "createdAt"',[title,message]);res.json({success:true,notification:r.rows[0]});}catch(e){res.status(500).json({success:false,message:'Could not send notification.'});}});
app.get('/api/admin/stats', adminOnly, async(_req,res)=>{try{const r=await pool.query(`SELECT (SELECT COUNT(*) FROM app_users)::int AS users,(SELECT COUNT(*) FROM app_redeem_requests)::int AS requests,(SELECT COUNT(*) FROM app_redeem_requests WHERE status='Pending')::int AS pending,(SELECT COALESCE(SUM(coins),0) FROM app_users)::bigint AS coins,(SELECT COALESCE(SUM(gems),0) FROM app_users)::bigint AS gems`);res.json({success:true,stats:r.rows[0]});}catch(e){res.status(500).json({success:false,message:'Could not load stats.'});}});

initDb().then(()=>app.listen(PORT,()=>console.log(`Redeem & Earn app listening on ${PORT}`))).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
