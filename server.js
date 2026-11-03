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

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '1mb' }));

const COIN_RATES = { 10: 1500, 20: 3000, 50: 7500, 100: 15000 };
const REFERRAL_REWARD = 100;
const WELCOME_BONUS = 3000;
const SUPER_OFFER_GEM_COST = 25;

async function initDb() {
  // These are additive migrations only. Existing withdrawals/referrals are not dropped or rewritten.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      user_id VARCHAR(180) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(254) NOT NULL,
      coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
      gems BIGINT NOT NULL DEFAULT 0 CHECK (gems >= 0),
      referral_code VARCHAR(40) UNIQUE NOT NULL,
      referred_by VARCHAR(180),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_uq ON app_users (LOWER(email));
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
function userOnly(req, res, next) {
  const id = cleanId(req.body?.userId || req.params?.userId || req.query?.userId);
  if (!id) return res.status(400).json({ success:false, message:'User ID is required.' });
  req.userId = id; next();
}

app.get('/', (_req,res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (_req,res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_req,res) => res.json({ success:true, app:'Premium Redeem & Earn', database: !!process.env.DATABASE_URL }));

// Login/register. Telegram user IDs are used when available; browser mode uses a persistent UUID.
app.post('/api/auth', async (req,res) => {
  const userId = cleanId(req.body.userId);
  const name = String(req.body.name || '').trim().slice(0,120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0,254);
  const referralCode = String(req.body.referralCode || '').trim().toUpperCase().slice(0,40);
  if (!userId || name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({success:false,message:'Enter a valid name and email.'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT user_id FROM app_users WHERE user_id=$1 FOR UPDATE',[userId]);
    let isNewUser = false;
    if (exists.rowCount) {
      await client.query('UPDATE app_users SET name=$2,email=$3,updated_at=NOW() WHERE user_id=$1',[userId,name,email]);
    } else {
      isNewUser = true;
      const ownCode = 'R' + crypto.randomBytes(5).toString('hex').toUpperCase();
      let referrer = null;
      if (referralCode) {
        const found = await client.query('SELECT user_id FROM app_users WHERE referral_code=$1',[referralCode]);
        if (found.rowCount && found.rows[0].user_id !== userId) referrer = found.rows[0].user_id;
      }
      await client.query(`INSERT INTO app_users(user_id,name,email,coins,referral_code,referred_by) VALUES($1,$2,$3,$4,$5,$6)`,[userId,name,email,WELCOME_BONUS,ownCode,referrer]);
      if (referrer) {
        await client.query('UPDATE app_users SET coins=coins+$2,updated_at=NOW() WHERE user_id=$1',[referrer,REFERRAL_REWARD]);
        await client.query('INSERT INTO app_referrals(referrer_id,referred_id,reward) VALUES($1,$2,$3) ON CONFLICT(referred_id) DO NOTHING',[referrer,userId,REFERRAL_REWARD]);
      }
    }
    const u = await client.query('SELECT user_id AS "userId",name,email,coins,gems,referral_code AS "referralCode" FROM app_users WHERE user_id=$1',[userId]);
    await client.query('COMMIT');
    res.json({success:true,user:u.rows[0],isNewUser,welcomeBonus:isNewUser?WELCOME_BONUS:0});
  } catch(e) { await client.query('ROLLBACK'); console.error('auth',e); res.status(500).json({success:false,message:e.code==='23505'?'This email is already registered to another account.':'Could not sign in.'}); }
  finally { client.release(); }
});

app.get('/api/user/:userId', async (req,res) => {
  try {
    const r = await pool.query('SELECT user_id AS "userId",name,email,coins,gems,referral_code AS "referralCode" FROM app_users WHERE user_id=$1',[cleanId(req.params.userId)]);
    if (!r.rowCount) return res.status(404).json({success:false,message:'User not found.'});
    res.json({success:true,user:r.rows[0]});
  } catch(e) { res.status(500).json({success:false,message:'Could not load account.'}); }
});

app.get('/api/redeems/:userId', async (req,res) => {
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
