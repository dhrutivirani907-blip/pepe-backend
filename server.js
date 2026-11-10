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
const REFERRAL_LINK_REWARD = 100;
const REFERRAL_CODE_REWARD = 300;
const WELCOME_BONUS = 100;
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
    CREATE TABLE IF NOT EXISTS app_payment_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id),
      method VARCHAR(12) NOT NULL CHECK (method IN ('upi','crypto')),
      name VARCHAR(120) NOT NULL,
      account_detail VARCHAR(180) NOT NULL,
      amount NUMERIC(12,4) NOT NULL,
      amount_label VARCHAR(40) NOT NULL,
      coins_deducted BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed','Rejected')),
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS app_payment_user_idx ON app_payment_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS app_payment_method_idx ON app_payment_requests(method, created_at DESC);
    CREATE TABLE IF NOT EXISTS app_coin_purchases (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
      method VARCHAR(12) NOT NULL CHECK (method IN ('upi','crypto')),
      coin_package INTEGER NOT NULL CHECK (coin_package IN (500,2000,5000,10000)),
      amount_paid NUMERIC(12,4) NOT NULL,
      amount_label VARCHAR(40) NOT NULL,
      payment_reference VARCHAR(220) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed','Rejected')),
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS app_coin_purchase_user_idx ON app_coin_purchases(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS app_coin_purchase_method_idx ON app_coin_purchases(method, created_at DESC);
    CREATE TABLE IF NOT EXISTS app_game_progress (
      user_id VARCHAR(180) PRIMARY KEY REFERENCES app_users(user_id) ON DELETE CASCADE,
      xp INTEGER NOT NULL DEFAULT 0 CHECK (xp BETWEEN 0 AND 100),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_ad_sessions (
      id UUID PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS app_ad_sessions_user_idx ON app_ad_sessions(user_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS app_social_orders (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id),
      platform VARCHAR(16) NOT NULL CHECK (platform IN ('instagram','telegram')),
      quantity VARCHAR(40) NOT NULL,
      link TEXT NOT NULL,
      coins_deducted BIGINT NOT NULL CHECK (coins_deducted > 0),
      status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed','Rejected')),
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS app_social_orders_user_idx ON app_social_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS app_social_orders_platform_idx ON app_social_orders(platform, created_at DESC);
    CREATE TABLE IF NOT EXISTS app_coin_ad_sessions (
      id UUID PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS app_coin_ad_sessions_user_idx ON app_coin_ad_sessions(user_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS app_dino_games (
      id UUID PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      elapsed_seconds INTEGER,
      points BIGINT NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 15000),
      claimed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS app_dino_games_user_idx ON app_dino_games(user_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS app_dino_ad_sessions (
      id UUID PRIMARY KEY,
      game_id UUID NOT NULL UNIQUE REFERENCES app_dino_games(id) ON DELETE CASCADE,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
      points BIGINT NOT NULL CHECK (points BETWEEN 0 AND 15000),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS app_dino_ad_user_idx ON app_dino_ad_sessions(user_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS app_dino_redeems (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(180) NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
      wallet_address VARCHAR(160) NOT NULL,
      points BIGINT NOT NULL CHECK (points > 0),
      gram_amount NUMERIC(30,12) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed','Rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS app_dino_redeem_user_idx ON app_dino_redeems(user_id, created_at DESC);
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
  const referralSource = String(req.body.referralSource || (referralCode ? 'link' : 'none')).toLowerCase();
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
    let signupBonus = WELCOME_BONUS;
    let referrerReward = 0;
    if (referralCode) {
      const found = await client.query('SELECT user_id FROM app_users WHERE referral_code=$1', [referralCode]);
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Invalid referral code. Please check the code and try again.' });
      }
      referrer = found.rows[0].user_id;
      if (referrer === userId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'You cannot use your own referral code.' });
      }
      if (referralSource === 'code') {
        signupBonus = REFERRAL_CODE_REWARD;
        referrerReward = REFERRAL_CODE_REWARD;
      } else {
        // A signup opened through the personal invite link earns the standard link reward.
        signupBonus = WELCOME_BONUS;
        referrerReward = REFERRAL_LINK_REWARD;
      }
    }
    await client.query(
      `INSERT INTO app_users(user_id,name,email,password_hash,coins,gems,referral_code,referred_by)
       VALUES($1,$2,$3,$4,$5,0,$6,$7)`,
      [userId, name, email, passwordHash, signupBonus, ownCode, referrer]
    );
    if (referrer && referrerReward > 0) {
      await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1', [referrer, referrerReward]);
      await client.query('INSERT INTO app_referrals(referrer_id,referred_id,reward) VALUES($1,$2,$3) ON CONFLICT(referred_id) DO NOTHING', [referrer, userId, referrerReward]);
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

// Profile details for the signed-in user. Uses the existing session token and user ID.
app.get('/api/profile', userOnly, async (req,res) => {
  try {
    const r = await pool.query(
      'SELECT user_id AS "userId", name, email FROM app_users WHERE user_id=$1',
      [req.userId]
    );
    if (!r.rowCount) return res.status(404).json({success:false,message:'Profile not found.'});
    return res.json({success:true,profile:r.rows[0]});
  } catch (e) {
    console.error('profile',e);
    return res.status(500).json({success:false,message:'Could not load your profile.'});
  }
});

app.get('/api/redeems/:userId', userOnly, async (req,res) => {
  try { const r=await pool.query(`SELECT id,amount_inr AS amount,coins_deducted AS "coinsDeducted",status,redeem_code AS "redeemCode",created_at AS "createdAt",updated_at AS "updatedAt" FROM app_redeem_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[cleanId(req.params.userId)]); res.json({success:true,requests:r.rows}); }
  catch(e){res.status(500).json({success:false,message:'Could not load redeem history.'});}
});

app.post('/api/redeems', userOnly, async (req,res) => {
  const amount = Number(req.body.amount);
  const coins = COIN_RATES[amount];
  const name = String(req.body.name || '').trim().slice(0,120);
  const email = normalizeEmail(req.body.email);
  if (!coins) return res.status(400).json({success:false,message:'Choose a valid redeem amount.'});
  if (name.length < 2 || !validEmail(email)) {
    return res.status(400).json({success:false,message:'Enter a valid name and email address.'});
  }

  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const ur=await client.query('SELECT coins FROM app_users WHERE user_id=$1 FOR UPDATE',[req.userId]);
    if(!ur.rowCount){
      await client.query('ROLLBACK');
      return res.status(404).json({success:false,message:'Account not found. Please sign in again.'});
    }
    if(Number(ur.rows[0].coins)<coins){
      await client.query('ROLLBACK');
      return res.status(400).json({success:false,message:'Not enough coins for this redeem amount.'});
    }

    await client.query('UPDATE app_users SET coins=coins-$2,updated_at=NOW() WHERE user_id=$1',[req.userId,coins]);
    const rr=await client.query(
      `INSERT INTO app_redeem_requests(user_id,name,email,amount_inr,coins_deducted)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,amount_inr AS amount,coins_deducted AS "coinsDeducted",
                 status,redeem_code AS "redeemCode",created_at AS "createdAt"`,
      [req.userId,name,email,amount,coins]
    );
    const bal=await client.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);
    await client.query('COMMIT');
    res.json({success:true,request:rr.rows[0],balance:bal.rows[0]});
  } catch(e){
    await client.query('ROLLBACK');
    console.error('redeem create',e);
    res.status(500).json({success:false,message:'Could not submit redeem request.'});
  } finally {
    client.release();
  }
});

// UPI and GRAM crypto withdrawal requests are stored separately from Google Play codes.
const UPI_COIN_RATES = { 10:1500, 20:3000, 50:7500, 100:15000 };
const GRAM_COIN_RATES = { '0.1':1700, '0.2':3400, '0.5':8500, '1':17000 };
function validUpiId(value) { return /^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,64}$/.test(String(value || '').trim()); }
function validGramAddress(value) {
  const s=String(value||'').trim();
  return s.length>=32 && s.length<=120 && /^[A-Za-z0-9_:-]+$/.test(s);
}
app.get('/api/payments/:userId', userOnly, async (req,res)=>{
  try {
    const r=await pool.query(`SELECT id,method,name,account_detail AS "accountDetail",amount,amount_label AS "amountLabel",coins_deducted AS "coinsDeducted",status,admin_note AS "adminNote",created_at AS "createdAt",updated_at AS "updatedAt" FROM app_payment_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,[cleanId(req.params.userId)]);
    res.json({success:true,requests:r.rows});
  } catch(e) { console.error('user payments',e); res.status(500).json({success:false,message:'Could not load payment history.'}); }
});
app.post('/api/payments/:method', userOnly, async (req,res)=>{
  const method=String(req.params.method||'').toLowerCase();
  const name=String(req.body.name||'').trim().slice(0,120);
  const account=String(req.body.accountDetail||'').trim().slice(0,180);
  const rawAmount=String(req.body.amount??'');
  let amount,coins,label;
  if(name.length<2) return res.status(400).json({success:false,message:'Enter your full name.'});
  if(method==='upi') {
    amount=Number(rawAmount); coins=UPI_COIN_RATES[amount]; label='₹'+amount;
    if(!validUpiId(account)) return res.status(400).json({success:false,message:'Enter a valid UPI ID.'});
  } else if(method==='crypto') {
    amount=Number(rawAmount); coins=GRAM_COIN_RATES[rawAmount]; label=rawAmount+' GRAM';
    if(!validGramAddress(account)) return res.status(400).json({success:false,message:'Enter a valid TON network GRAM address.'});
  } else return res.status(400).json({success:false,message:'Invalid payment method.'});
  if(!coins) return res.status(400).json({success:false,message:'Choose a valid amount.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const u=await client.query('SELECT coins FROM app_users WHERE user_id=$1 FOR UPDATE',[req.userId]);
    if(!u.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Account not found.'});}
    if(Number(u.rows[0].coins)<coins){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Not enough coins for this withdrawal.'});}
    await client.query('UPDATE app_users SET coins=coins-$2,updated_at=NOW() WHERE user_id=$1',[req.userId,coins]);
    const q=await client.query(`INSERT INTO app_payment_requests(user_id,method,name,account_detail,amount,amount_label,coins_deducted) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,method,name,account_detail AS "accountDetail",amount,amount_label AS "amountLabel",coins_deducted AS "coinsDeducted",status,created_at AS "createdAt"`,[req.userId,method,name,account,amount,label,coins]);
    const b=await client.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);
    await client.query('COMMIT');
    res.json({success:true,request:q.rows[0],balance:b.rows[0]});
  } catch(e) { await client.query('ROLLBACK'); console.error('payment request',e); res.status(500).json({success:false,message:'Could not submit withdrawal request.'}); }
  finally { client.release(); }
});

// Server-verified ad visits: one successful visit adds 25 XP; 100 XP can be exchanged for 1 Gem.
app.get('/api/game/progress', userOnly, async (req,res)=>{
  try {
    await pool.query('INSERT INTO app_game_progress(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',[req.userId]);
    const q=await pool.query('SELECT xp FROM app_game_progress WHERE user_id=$1',[req.userId]);
    const u=await pool.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);
    res.json({success:true,xp:q.rows[0].xp,balance:u.rows[0]});
  } catch(e) { console.error('game progress',e); res.status(500).json({success:false,message:'Could not load XP progress.'}); }
});
app.post('/api/game/ad/start', userOnly, async (req,res)=>{
  try {
    await pool.query('INSERT INTO app_game_progress(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',[req.userId]);
    const p=await pool.query('SELECT xp FROM app_game_progress WHERE user_id=$1',[req.userId]);
    if(Number(p.rows[0].xp)>=100) return res.status(400).json({success:false,message:'Claim your Gem before watching more ads.'});
    const id=crypto.randomUUID();
    await pool.query('INSERT INTO app_ad_sessions(id,user_id) VALUES($1,$2)',[id,req.userId]);
    res.json({success:true,sessionId:id});
  } catch(e) { console.error('ad start',e); res.status(500).json({success:false,message:'Could not start ad visit.'}); }
});
app.post('/api/game/ad/complete', userOnly, async (req,res)=>{
  const id=String(req.body.sessionId||''); const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const s=await client.query('SELECT id,completed_at,started_at FROM app_ad_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,req.userId]);
    if(!s.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Ad visit session not found. Please try again.'});}
    if(s.rows[0].completed_at){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'This ad visit was already counted.'});}
    if(new Date(s.rows[0].started_at).getTime()>Date.now()-8000){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'You must stay for at least 8 seconds.'});}
    await client.query('UPDATE app_ad_sessions SET completed_at=NOW() WHERE id=$1',[id]);
    await client.query('INSERT INTO app_game_progress(user_id,xp) VALUES($1,25) ON CONFLICT(user_id) DO UPDATE SET xp=LEAST(100,app_game_progress.xp+25),updated_at=NOW()',[req.userId]);
    const p=await client.query('SELECT xp FROM app_game_progress WHERE user_id=$1',[req.userId]);
    await client.query('COMMIT');
    res.json({success:true,xp:p.rows[0].xp,xpAdded:25});
  } catch(e) { await client.query('ROLLBACK'); console.error('ad complete',e); res.status(500).json({success:false,message:'Could not verify this ad visit.'}); }
  finally { client.release(); }
});
app.post('/api/game/claim', userOnly, async (req,res)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const p=await client.query('SELECT xp FROM app_game_progress WHERE user_id=$1 FOR UPDATE',[req.userId]);
    if(!p.rowCount||Number(p.rows[0].xp)<100){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Complete 100 XP before claiming 1 Gem.'});}
    await client.query('UPDATE app_game_progress SET xp=0,updated_at=NOW() WHERE user_id=$1',[req.userId]);
    await client.query('UPDATE app_users SET gems=gems+1,updated_at=NOW() WHERE user_id=$1',[req.userId]);
    const u=await client.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);
    await client.query('COMMIT');
    res.json({success:true,gemsAdded:1,xp:0,balance:u.rows[0]});
  } catch(e) { await client.query('ROLLBACK'); console.error('gem claim',e); res.status(500).json({success:false,message:'Could not claim your Gem.'}); }
  finally { client.release(); }
});

app.get('/api/notifications', async (_req,res)=>{try{const r=await pool.query('SELECT id,title,message,created_at AS "createdAt" FROM app_notifications ORDER BY created_at DESC LIMIT 50');res.json({success:true,notifications:r.rows});}catch(e){res.status(500).json({success:false,message:'Could not load notifications.'});}});

app.post('/api/super-offer/claim', userOnly, async(req,res)=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const u=await client.query('SELECT gems FROM app_users WHERE user_id=$1 FOR UPDATE',[req.userId]);if(!u.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Account not found.'});}if(Number(u.rows[0].gems)<SUPER_OFFER_GEM_COST){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'You need 25 Gems to unlock this offer.'});}const reward=270+crypto.randomInt(0,31);await client.query('UPDATE app_users SET gems=gems-$2,coins=coins+$3,updated_at=NOW() WHERE user_id=$1',[req.userId,SUPER_OFFER_GEM_COST,reward]);await client.query('INSERT INTO app_super_offers(user_id,coins_awarded,gems_spent) VALUES($1,$2,$3)',[req.userId,reward,SUPER_OFFER_GEM_COST]);const b=await client.query('SELECT coins,gems FROM app_users WHERE user_id=$1',[req.userId]);const count=await client.query('SELECT COUNT(*)::int AS total FROM app_super_offers WHERE user_id=$1',[req.userId]);await client.query('COMMIT');res.json({success:true,coinsAdded:reward,gemsSpent:25,totalCompleted:count.rows[0].total,balance:b.rows[0]});}
  catch(e){await client.query('ROLLBACK');res.status(500).json({success:false,message:'Could not claim offer.'});}finally{client.release();}
});

// Admin API

// Social service orders: new additive tables; existing redeem/payment data is untouched.
const SOCIAL_PRICES = {
  instagram: { '1K views': 50, '5K views': 250, '50K views': 2500, '100K views': 5000 },
  telegram: { '100 members': 500, '500 members': 2500, '1K members': 5000 }
};
app.post('/api/orders', userOnly, async (req,res) => {
  const platform=String(req.body.platform||'').toLowerCase();
  const quantity=String(req.body.quantity||'');
  const link=String(req.body.link||'').trim().slice(0,2000);
  const expected=SOCIAL_PRICES[platform]?.[quantity];
  let parsed;
  try { parsed=new URL(link); } catch { parsed=null; }
  if(!expected || !parsed || !['http:','https:'].includes(parsed.protocol))
    return res.status(400).json({success:false,message:'Choose a valid package and enter a valid http or https link.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const u=await client.query('SELECT coins FROM app_users WHERE user_id=$1 FOR UPDATE',[req.userId]);
    if(!u.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Account not found.'});}
    if(Number(u.rows[0].coins)<expected){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Not enough Gold Coins for this order.'});}
    await client.query('UPDATE app_users SET coins=coins-$2,updated_at=NOW() WHERE user_id=$1',[req.userId,expected]);
    const q=await client.query(
      `INSERT INTO app_social_orders(user_id,platform,quantity,link,coins_deducted)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,platform,quantity,link,coins_deducted AS "coinsDeducted",status,created_at AS "createdAt"`,
      [req.userId,platform,quantity,link,expected]
    );
    const user=await client.query('SELECT user_id AS "userId",name,email,coins,gems,referral_code AS "referralCode" FROM app_users WHERE user_id=$1',[req.userId]);
    await client.query('COMMIT');
    res.json({success:true,order:q.rows[0],user:user.rows[0]});
  } catch(e) {
    await client.query('ROLLBACK'); console.error('social order create',e);
    res.status(500).json({success:false,message:'Could not submit your order.'});
  } finally { client.release(); }
});
app.get('/api/orders', userOnly, async(req,res)=>{
  try {
    const q=await pool.query(
      `SELECT id,platform,quantity,link,coins_deducted AS "coinsDeducted",status,
              admin_note AS "adminNote",created_at AS "createdAt",updated_at AS "updatedAt"
       FROM app_social_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [req.userId]
    );
    res.json({success:true,orders:q.rows});
  } catch(e) { console.error('social order history',e); res.status(500).json({success:false,message:'Could not load order history.'}); }
});
// Gold Coin purchases are separate from withdrawals. Submitting a purchase never credits coins.
const GOLD_BUY_PACKAGES = {
  500: { inr: 20, usd: 0.20, gram: 0.15 },
  2000: { inr: 70, usd: 0.70, gram: 0.6 },
  5000: { inr: 150, usd: 1.50, gram: 1.4 },
  10000: { inr: 300, usd: 3.00, gram: 2.7 }
};
app.get('/api/coin-purchases', userOnly, async (req,res)=>{
  try {
    const q=await pool.query(`SELECT id,method,coin_package AS "coinPackage",amount_paid AS "amountPaid",amount_label AS "amountLabel",payment_reference AS "paymentReference",status,admin_note AS "adminNote",created_at AS "createdAt" FROM app_coin_purchases WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,[req.userId]);
    res.json({success:true,requests:q.rows});
  } catch(e) { console.error('coin purchase history',e); res.status(500).json({success:false,message:'Could not load purchase history.'}); }
});
app.post('/api/coin-purchases', userOnly, async (req,res)=>{
  const method=String(req.body.method||'').toLowerCase();
  const coins=Number(req.body.coinPackage);
  const pkg=GOLD_BUY_PACKAGES[coins];
  const reference=String(req.body.paymentReference||'').trim().slice(0,220);
  if(!pkg || !['upi','crypto'].includes(method) || reference.length<4) return res.status(400).json({success:false,message:'Please enter valid purchase and payment details.'});
  const amount=method==='upi'?pkg.inr:pkg.gram;
  const label=method==='upi'?`INR ${pkg.inr}`:`${pkg.gram} GRAM`;
  try {
    const q=await pool.query(`INSERT INTO app_coin_purchases(user_id,method,coin_package,amount_paid,amount_label,payment_reference) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,method,coin_package AS "coinPackage",amount_paid AS "amountPaid",amount_label AS "amountLabel",payment_reference AS "paymentReference",status,created_at AS "createdAt"`,[req.userId,method,coins,amount,label,reference]);
    res.json({success:true,request:q.rows[0],message:'Your request is submitted. Order complete within 24 to 48 hours.'});
  } catch(e) { console.error('coin purchase submit',e); res.status(500).json({success:false,message:'Could not submit purchase request.'}); }
});
app.get('/api/admin/coin-purchases/:method', adminOnly, async(req,res)=>{
  const method=String(req.params.method||'').toLowerCase();
  if(!['upi','crypto'].includes(method)) return res.status(400).json({success:false,message:'Invalid payment method.'});
  try {
    const q=await pool.query(`SELECT p.id,p.user_id AS "userId",u.name,u.email,p.method,p.coin_package AS "coinPackage",p.amount_paid AS "amountPaid",p.amount_label AS "amountLabel",p.payment_reference AS "paymentReference",p.status,p.admin_note AS "adminNote",p.created_at AS "createdAt" FROM app_coin_purchases p JOIN app_users u ON u.user_id=p.user_id WHERE p.method=$1 ORDER BY p.created_at DESC LIMIT 500`,[method]);
    res.json({success:true,requests:q.rows});
  } catch(e) { console.error('admin coin purchases',e); res.status(500).json({success:false,message:'Could not load purchase requests.'}); }
});
app.put('/api/admin/coin-purchases/:id', adminOnly, async(req,res)=>{
  const status=String(req.body.status||''); const note=String(req.body.note||'').trim().slice(0,1000);
  if(!['Pending','Completed','Rejected'].includes(status)) return res.status(400).json({success:false,message:'Invalid status.'});
  try {
    const q=await pool.query('UPDATE app_coin_purchases SET status=$2,admin_note=$3,updated_at=NOW() WHERE id=$1 RETURNING id',[req.params.id,status,note]);
    if(!q.rowCount) return res.status(404).json({success:false,message:'Purchase request not found.'});
    res.json({success:true,message:'Purchase status updated. Coins were not credited automatically.'});
  } catch(e) { console.error('admin coin purchase update',e); res.status(500).json({success:false,message:'Could not update purchase request.'}); }
});
app.post('/api/admin/add-coins', adminOnly, async(req,res)=>{
  const email=normalizeEmail(req.body.email); const coins=Number(req.body.coins);
  if(!validEmail(email)||!Number.isSafeInteger(coins)||coins<1||coins>100000000) return res.status(400).json({success:false,message:'Enter a valid user email and coin amount.'});
  try {
    const q=await pool.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE LOWER(email)=LOWER($1) RETURNING user_id AS "userId",name,email,coins',[email,coins]);
    if(!q.rowCount) return res.status(404).json({success:false,message:'No user found with this email.'});
    res.json({success:true,user:q.rows[0],message:`${coins.toLocaleString('en-IN')} Gold Coins added successfully.`});
  } catch(e) { console.error('admin add coins',e); res.status(500).json({success:false,message:'Could not add coins.'}); }
});

app.get('/api/admin/orders', adminOnly, async(req,res)=>{
  const platform=String(req.query.platform||'').toLowerCase();
  if(!['instagram','telegram'].includes(platform))return res.status(400).json({success:false,message:'Choose Instagram or Telegram.'});
  try {
    const q=await pool.query(
      `SELECT o.id,o.user_id AS "userId",u.name,u.email,o.platform,o.quantity,o.link,
              o.coins_deducted AS "coinsDeducted",o.status,o.admin_note AS "adminNote",
              o.created_at AS "createdAt",o.updated_at AS "updatedAt"
       FROM app_social_orders o JOIN app_users u ON u.user_id=o.user_id
       WHERE o.platform=$1 ORDER BY o.created_at DESC LIMIT 1000`,
      [platform]
    );
    res.json({success:true,orders:q.rows});
  } catch(e) { console.error('admin social orders',e); res.status(500).json({success:false,message:'Could not load social orders.'}); }
});
app.put('/api/admin/orders/:id', adminOnly, async(req,res)=>{
  const status=String(req.body.status||'');
  const note=String(req.body.note||'').trim().slice(0,1000);
  if(!['Pending','Completed','Rejected'].includes(status))return res.status(400).json({success:false,message:'Invalid status.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const q=await client.query('SELECT * FROM app_social_orders WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Order not found.'});}
    const old=q.rows[0];
    if(old.status==='Rejected' && status!=='Rejected'){
      await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Rejected orders cannot be reopened.'});
    }
    if(status==='Rejected' && old.status!=='Rejected'){
      await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1',[old.user_id,old.coins_deducted]);
    }
    await client.query('UPDATE app_social_orders SET status=$2,admin_note=$3,updated_at=NOW() WHERE id=$1',[req.params.id,status,note]);
    await client.query('COMMIT');
    res.json({success:true,message:'Order updated successfully.'});
  } catch(e) { await client.query('ROLLBACK'); console.error('admin social order update',e); res.status(500).json({success:false,message:'Could not update order.'}); }
  finally { client.release(); }
});

// Dedicated one-coin ad flow; server verifies the full eight-second visit.
app.post('/api/coins/ad/start', userOnly, async(req,res)=>{
  try {
    const id=crypto.randomUUID();
    await pool.query('INSERT INTO app_coin_ad_sessions(id,user_id) VALUES($1,$2)',[id,req.userId]);
    res.json({success:true,sessionId:id});
  } catch(e) { console.error('coin ad start',e); res.status(500).json({success:false,message:'Could not start ad visit.'}); }
});
app.post('/api/coins/ad/complete', userOnly, async(req,res)=>{
  const id=String(req.body.sessionId||'');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const s=await client.query('SELECT id,started_at,completed_at FROM app_coin_ad_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,req.userId]);
    if(!s.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Ad session not found.'});}
    if(s.rows[0].completed_at){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'This ad visit was already rewarded.'});}
    if(new Date(s.rows[0].started_at).getTime()>Date.now()-8000){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'You must watch the ad for at least 8 seconds.'});}
    await client.query('UPDATE app_coin_ad_sessions SET completed_at=NOW() WHERE id=$1',[id]);
    const u=await client.query('UPDATE app_users SET coins=coins+1,updated_at=NOW() WHERE user_id=$1 RETURNING coins',[req.userId]);
    await client.query('COMMIT');
    res.json({success:true,coins:u.rows[0].coins,coinsAdded:1});
  } catch(e) { await client.query('ROLLBACK'); console.error('coin ad complete',e); res.status(500).json({success:false,message:'Could not verify this ad visit.'}); }
  finally { client.release(); }
});

app.post('/api/admin/login', (req,res)=>{if(!ADMIN_PASSWORD || String(req.body.password||'')!==ADMIN_PASSWORD)return res.status(401).json({success:false,message:'Incorrect admin password.'});res.json({success:true});});
app.get('/api/admin/redeems', adminOnly, async(_req,res)=>{try{const r=await pool.query(`SELECT id,user_id AS "userId",name,email,amount_inr AS amount,coins_deducted AS "coinsDeducted",status,redeem_code AS "redeemCode",created_at AS "createdAt" FROM app_redeem_requests ORDER BY created_at DESC LIMIT 500`);res.json({success:true,requests:r.rows});}catch(e){res.status(500).json({success:false,message:'Could not load requests.'});}});
app.put('/api/admin/redeems/:id', adminOnly, async(req,res)=>{
  const status=String(req.body.status||''); const code=String(req.body.redeemCode||'').trim().slice(0,100); const note=String(req.body.note||'').slice(0,1000);
  if(!['Pending','Completed','Rejected'].includes(status))return res.status(400).json({success:false,message:'Invalid status.'});if(status==='Completed'&&!code)return res.status(400).json({success:false,message:'Enter the Google Play redeem code before completing.'});
  const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query('SELECT * FROM app_redeem_requests WHERE id=$1 FOR UPDATE',[req.params.id]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Request not found.'});}const old=q.rows[0];if(old.status==='Rejected'&&status!=='Rejected'){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Rejected requests cannot be reopened.'});}if(status==='Rejected'&&old.status!=='Rejected'){await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1',[old.user_id,old.coins_deducted]);}await client.query(`UPDATE app_redeem_requests SET status=$2,redeem_code=$3,admin_note=$4,updated_at=NOW() WHERE id=$1`,[req.params.id,status,status==='Completed'?code:null,note]);await client.query('COMMIT');res.json({success:true,message:'Request updated.'});}catch(e){await client.query('ROLLBACK');res.status(500).json({success:false,message:'Could not update request.'});}finally{client.release();}
});
app.get('/api/admin/payments/:method', adminOnly, async(req,res)=>{
  const method=String(req.params.method||'').toLowerCase();
  if(!['upi','crypto'].includes(method)) return res.status(400).json({success:false,message:'Invalid payment method.'});
  try {
    const q=await pool.query(`SELECT id,user_id AS "userId",method,name,account_detail AS "accountDetail",amount,amount_label AS "amountLabel",coins_deducted AS "coinsDeducted",status,admin_note AS "adminNote",created_at AS "createdAt" FROM app_payment_requests WHERE method=$1 ORDER BY created_at DESC LIMIT 500`,[method]);
    res.json({success:true,requests:q.rows});
  } catch(e) { console.error('admin payments',e); res.status(500).json({success:false,message:'Could not load payment requests.'}); }
});
app.put('/api/admin/payments/:id', adminOnly, async(req,res)=>{
  const status=String(req.body.status||''); const note=String(req.body.note||'').trim().slice(0,1000);
  if(!['Pending','Completed','Rejected'].includes(status)) return res.status(400).json({success:false,message:'Invalid status.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const q=await client.query('SELECT * FROM app_payment_requests WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Payment request not found.'});}
    const old=q.rows[0];
    if(old.status==='Rejected'&&status!=='Rejected'){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Rejected requests cannot be reopened.'});}
    if(status==='Rejected'&&old.status!=='Rejected') await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1',[old.user_id,old.coins_deducted]);
    await client.query('UPDATE app_payment_requests SET status=$2,admin_note=$3,updated_at=NOW() WHERE id=$1',[req.params.id,status,note]);
    await client.query('COMMIT');
    res.json({success:true,message:'Payment request updated.'});
  } catch(e) { await client.query('ROLLBACK'); console.error('admin payment update',e); res.status(500).json({success:false,message:'Could not update payment request.'}); }
  finally { client.release(); }
});
app.post('/api/admin/notifications', adminOnly, async(req,res)=>{const title=String(req.body.title||'').trim().slice(0,160),message=String(req.body.message||'').trim().slice(0,3000);if(!title||!message)return res.status(400).json({success:false,message:'Enter a title and message.'});try{const r=await pool.query('INSERT INTO app_notifications(title,message) VALUES($1,$2) RETURNING id,title,message,created_at AS "createdAt"',[title,message]);res.json({success:true,notification:r.rows[0]});}catch(e){res.status(500).json({success:false,message:'Could not send notification.'});}});
app.get('/api/admin/stats', adminOnly, async(_req,res)=>{try{const r=await pool.query(`SELECT (SELECT COUNT(*) FROM app_users)::int AS users,(SELECT COUNT(*) FROM app_redeem_requests)::int AS requests,(SELECT COUNT(*) FROM app_redeem_requests WHERE status='Pending')::int AS pending,(SELECT COALESCE(SUM(coins),0) FROM app_users)::bigint AS coins,(SELECT COALESCE(SUM(gems),0) FROM app_users)::bigint AS gems`);res.json({success:true,stats:r.rows[0]});}catch(e){res.status(500).json({success:false,message:'Could not load stats.'});}});



// Dino Parkour: additive game APIs. Existing account, balance and legacy APIs remain unchanged.
app.post('/api/dino/game/start', userOnly, async (req,res)=>{
  try {
    const id=crypto.randomUUID();
    await pool.query('INSERT INTO app_dino_games(id,user_id) VALUES($1,$2)',[id,req.userId]);
    res.json({success:true,gameSessionId:id,startedAt:new Date().toISOString()});
  } catch(e) { console.error('dino game start',e); res.status(500).json({success:false,message:'Could not start this game. Please try again.'}); }
});
app.post('/api/dino/game/finish', userOnly, async (req,res)=>{
  const id=String(req.body.gameSessionId||'');
  const seconds=Math.max(0,Math.min(30,Math.floor(Number(req.body.elapsedSeconds)||0)));
  if(!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({success:false,message:'Invalid game session.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const g=await client.query('SELECT id,started_at,finished_at FROM app_dino_games WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,req.userId]);
    if(!g.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Game session not found.'});}
    if(g.rows[0].finished_at){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'This game has already finished.'});}
    const elapsedMs=Date.now()-new Date(g.rows[0].started_at).getTime();
    if(elapsedMs < Math.max(0,seconds*1000-1800) || elapsedMs > 10*60*1000){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Game timing could not be verified. Please play again.'});}
    const points=seconds*500;
    await client.query('UPDATE app_dino_games SET finished_at=NOW(),elapsed_seconds=$2,points=$3 WHERE id=$1',[id,seconds,points]);
    await client.query('COMMIT');
    res.json({success:true,points,elapsedSeconds:seconds});
  } catch(e) { await client.query('ROLLBACK'); console.error('dino game finish',e); res.status(500).json({success:false,message:'Could not save this game result.'}); }
  finally { client.release(); }
});
app.post('/api/dino/ad/start', userOnly, async (req,res)=>{
  const gameId=String(req.body.gameSessionId||'');
  try {
    const g=await pool.query('SELECT points,finished_at FROM app_dino_games WHERE id=$1 AND user_id=$2',[gameId,req.userId]);
    if(!g.rowCount || !g.rows[0].finished_at) return res.status(400).json({success:false,message:'Finish a game before opening the reward link.'});
    const existing=await pool.query('SELECT id FROM app_dino_ad_sessions WHERE game_id=$1',[gameId]);
    if(existing.rowCount) return res.status(409).json({success:false,message:'The reward link for this game has already been started.'});
    const id=crypto.randomUUID();
    await pool.query('INSERT INTO app_dino_ad_sessions(id,game_id,user_id,points) VALUES($1,$2,$3,$4)',[id,gameId,req.userId,g.rows[0].points]);
    res.json({success:true,adSessionId:id,points:Number(g.rows[0].points)});
  } catch(e) { console.error('dino ad start',e); res.status(500).json({success:false,message:'Could not start reward verification.'}); }
});
app.post('/api/dino/ad/complete', userOnly, async (req,res)=>{
  const id=String(req.body.adSessionId||'');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const a=await client.query('SELECT id,points,started_at,completed_at FROM app_dino_ad_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,req.userId]);
    if(!a.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Reward visit not found. Please try again.'});}
    if(a.rows[0].completed_at){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'This game reward has already been claimed.'});}
    const remaining=8000-(Date.now()-new Date(a.rows[0].started_at).getTime());
    if(remaining>0){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'You must stay on the opened link for at least 8 seconds.',remainingMs:remaining});}
    await client.query('UPDATE app_dino_ad_sessions SET completed_at=NOW() WHERE id=$1',[id]);
    await client.query('UPDATE app_dino_games SET claimed_at=NOW() WHERE id=(SELECT game_id FROM app_dino_ad_sessions WHERE id=$1)',[id]);
    const u=await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1 RETURNING coins,gems',[req.userId,a.rows[0].points]);
    await client.query('COMMIT');
    res.json({success:true,pointsAdded:Number(a.rows[0].points),coins:u.rows[0].coins,gems:u.rows[0].gems});
  } catch(e) { await client.query('ROLLBACK'); console.error('dino ad complete',e); res.status(500).json({success:false,message:'Could not verify your reward. Please try again.'}); }
  finally { client.release(); }
});


// Dino Rush GRAM point redemptions. 15,000 points = 0.000075 GRAM.
app.get('/api/dino/redeems', userOnly, async (req,res)=>{
  try {
    const q=await pool.query(`SELECT id,points,gram_amount AS "gramAmount",status,created_at AS "createdAt" FROM app_dino_redeems WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,[req.userId]);
    res.json({success:true,requests:q.rows});
  } catch(e) { console.error('Dino redeem history',e); res.status(500).json({success:false,message:'Could not load redemption history.'}); }
});
app.post('/api/dino/redeems', userOnly, async (req,res)=>{
  const address=String(req.body.address||'').trim();
  const points=Number(req.body.points);
  if(address.length<20 || address.length>160 || !Number.isSafeInteger(points) || points<500000) return res.status(400).json({success:false,message:'Minimum withdrawal is 500,000 points. Enter a valid TON address and point amount.'});
  const gram=points*0.000000005;
  if(!Number.isFinite(gram) || gram<=0) return res.status(400).json({success:false,message:'Invalid GRAM amount.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const u=await client.query('SELECT coins FROM app_users WHERE user_id=$1 FOR UPDATE',[req.userId]);
    if(!u.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Account not found.'});}
    if(Number(u.rows[0].coins)<points){await client.query('ROLLBACK');return res.status(400).json({success:false,message:'Insufficient points balance.'});}
    await client.query('UPDATE app_users SET coins=coins-$2,updated_at=NOW() WHERE user_id=$1',[req.userId,points]);
    const q=await client.query(`INSERT INTO app_dino_redeems(user_id,wallet_address,points,gram_amount) VALUES($1,$2,$3,$4) RETURNING id,points,gram_amount AS "gramAmount",status,created_at AS "createdAt"`,[req.userId,address,points,gram.toFixed(12)]);
    await client.query('COMMIT');
    res.json({success:true,request:q.rows[0],message:'Your GRAM redemption request has been submitted.'});
  } catch(e) { await client.query('ROLLBACK'); console.error('Dino redeem submit',e); res.status(500).json({success:false,message:'Could not submit redemption request.'}); }
  finally { client.release(); }
});
app.get('/api/admin/dino/redeems', adminOnly, async (_req,res)=>{
  try {
    const q=await pool.query(`SELECT r.id,r.wallet_address AS address,r.points,r.gram_amount AS "gramAmount",r.status,r.created_at AS "createdAt" FROM app_dino_redeems r ORDER BY r.created_at DESC LIMIT 1000`);
    res.json({success:true,requests:q.rows});
  } catch(e) { console.error('Admin Dino redeems',e); res.status(500).json({success:false,message:'Could not load GRAM redemption requests.'}); }
});
app.put('/api/admin/dino/redeems/:id', adminOnly, async (req,res)=>{
  const status=String(req.body.status||'');
  if(!['Pending','Completed','Rejected'].includes(status)) return res.status(400).json({success:false,message:'Invalid status.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const q=await client.query('SELECT * FROM app_dino_redeems WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Redemption request not found.'});}
    const old=q.rows[0];
    if(old.status==='Rejected' && status!=='Rejected'){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Rejected requests cannot be reopened.'});}
    if(status==='Rejected' && old.status!=='Rejected') await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1',[old.user_id,old.points]);
    await client.query('UPDATE app_dino_redeems SET status=$2,updated_at=NOW() WHERE id=$1',[req.params.id,status]);
    await client.query('COMMIT');
    res.json({success:true,message:status==='Rejected'?'Request rejected and points refunded.':'Request status updated.'});
  } catch(e) { await client.query('ROLLBACK'); console.error('Admin Dino redeem update',e); res.status(500).json({success:false,message:'Could not update redemption status.'}); }
  finally { client.release(); }
});

initDb().then(()=>app.listen(PORT,()=>console.log(`Redeem & Earn app listening on ${PORT}`))).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
