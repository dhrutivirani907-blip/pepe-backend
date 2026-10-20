const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const DEPOSIT_ADDRESS = String(process.env.USDT_BEP20_ADDRESS || '0xeaf649489fc27078f4f86734f4ff770469416b3a');
const MIN_DEPOSIT = 1;
const MAX_DEPOSIT = 50;
const POWER_PER_USDT = 100;
const POWER_DAYS = 15;
const MIN_WITHDRAWAL = 1.5;
const RATE_PER_POWER_PER_SECOND = Number(process.env.RATE_PER_POWER_PER_SECOND || 0.00000001929);

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Admin-Key'] }));
app.use(express.json({ limit: '1mb' }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

const id = () => crypto.randomUUID();
const emailNorm = v => String(v || '').trim().toLowerCase();
const adminOnly = (req,res,next) => {
  const supplied = String(req.headers['x-admin-key'] || req.body?.adminKey || '');
  if (!ADMIN_KEY) return res.status(503).json({ success:false, message:'ADMIN_KEY is not configured on the server.' });
  const a = Buffer.from(supplied); const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({success:false,message:'Invalid admin key.'});
  next();
};
async function initDb(){
  await pool.query(`CREATE TABLE IF NOT EXISTS usdt_users (
    email TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS usdt_deposits (
    id TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES usdt_users(email), amount NUMERIC(18,8) NOT NULL,
    txid TEXT NOT NULL UNIQUE, network TEXT NOT NULL DEFAULT 'BEP20', status TEXT NOT NULL DEFAULT 'Pending',
    admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS usdt_power (
    id TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES usdt_users(email), amount NUMERIC(18,8) NOT NULL,
    source_deposit_id TEXT, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS usdt_withdrawals (
    id TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES usdt_users(email), amount NUMERIC(18,8) NOT NULL,
    wallet TEXT NOT NULL, network TEXT NOT NULL DEFAULT 'BEP20', status TEXT NOT NULL DEFAULT 'Pending',
    admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS usdt_history (
    id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL REFERENCES usdt_users(email), kind TEXT NOT NULL,
    amount NUMERIC(18,8) NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_usdt_deposits_email ON usdt_deposits(email)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_usdt_power_email_expiry ON usdt_power(email, expires_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_usdt_withdrawals_email ON usdt_withdrawals(email)');
  console.log('USDT Fan Miner database ready');
}
app.get('/health', (_req,res)=>res.json({status:'Active',app:'USDT Fan Miner API',version:1}));
app.get('/', (_req,res)=>res.sendFile(require('path').join(__dirname, 'index.html')));
app.get('/api/config', (_req,res)=>res.json({success:true,depositAddress:DEPOSIT_ADDRESS,minDeposit:MIN_DEPOSIT,maxDeposit:MAX_DEPOSIT,powerPerUsdt:POWER_PER_USDT,powerDays:POWER_DAYS,minWithdrawal:MIN_WITHDRAWAL,network:'BNB Smart Chain (BEP20)',ratePerPowerPerSecond:RATE_PER_POWER_PER_SECOND}));
app.post('/api/register', async(req,res)=>{
 try { const email=emailNorm(req.body.email); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({success:false,message:'Enter a valid email address.'});
 await pool.query('INSERT INTO usdt_users(email) VALUES($1) ON CONFLICT(email) DO NOTHING',[email]);
 res.json({success:true,email}); } catch(e){console.error(e);res.status(500).json({success:false,message:'Registration failed.'});}
});
async function userEmail(req,res,next){ const email=emailNorm(req.body.email || req.query.email); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({success:false,message:'Valid email is required.'}); req.email=email; next(); }
app.get('/api/me', userEmail, async(req,res)=>{
 try {
  const u=await pool.query('SELECT email,created_at FROM usdt_users WHERE email=$1',[req.email]); if(!u.rowCount) return res.status(404).json({success:false,message:'Email not registered. Register again.'});
  const p=await pool.query('SELECT COALESCE(SUM(amount),0) AS power FROM usdt_power WHERE email=$1 AND expires_at>NOW()',[req.email]);
  const expires=await pool.query('SELECT id,amount,expires_at FROM usdt_power WHERE email=$1 AND expires_at>NOW() ORDER BY expires_at',[req.email]);
  const dep=await pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM usdt_deposits WHERE email=$1 AND status='Approved'",[req.email]);
  const wd=await pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM usdt_withdrawals WHERE email=$1 AND status IN ('Pending','Approved')",[req.email]);
  const power=Number(p.rows[0].power||0); const seconds=expires.rows.reduce((n,r)=>n+Math.max(0,(new Date(r.expires_at)-Date.now())/1000),0);
  res.json({success:true,email:req.email,activePower:power,approvedDeposits:Number(dep.rows[0].total||0),reservedWithdrawals:Number(wd.rows[0].total||0),estimatedRatePerSecond:power*RATE_PER_POWER_PER_SECOND,powerLots:expires.rows,createdAt:u.rows[0].created_at,disclaimer:'Mining estimates are illustrative only; no earnings or payout is guaranteed.'});
 } catch(e){console.error(e);res.status(500).json({success:false,message:'Could not load account.'});}
});
app.post('/api/deposits', userEmail, async(req,res)=>{
 try { const amount=Number(req.body.amount); const txid=String(req.body.txid||'').trim();
 if(!Number.isFinite(amount)||amount<MIN_DEPOSIT||amount>MAX_DEPOSIT) return res.status(400).json({success:false,message:`Deposit must be ${MIN_DEPOSIT}–${MAX_DEPOSIT} USDT.`});
 if(txid.length<20||txid.length>180||! /^[a-zA-Z0-9xX_-]+$/.test(txid)) return res.status(400).json({success:false,message:'Enter a valid transaction hash / TXID.'});
 const user=await pool.query('SELECT email FROM usdt_users WHERE email=$1',[req.email]); if(!user.rowCount) return res.status(404).json({success:false,message:'Register your email first.'});
 const depositId=id(); await pool.query('INSERT INTO usdt_deposits(id,email,amount,txid) VALUES($1,$2,$3,$4)',[depositId,req.email,amount,txid]);
 await pool.query("INSERT INTO usdt_history(email,kind,amount,detail) VALUES($1,'Deposit submitted',$2,$3)",[req.email,amount,`TXID ${txid}; awaiting manual review`]);
 res.json({success:true,message:'Deposit submitted for manual review.',id:depositId,status:'Pending'});
 } catch(e){ if(e.code==='23505') return res.status(409).json({success:false,message:'This TXID has already been submitted.'}); console.error(e);res.status(500).json({success:false,message:'Could not submit deposit.'}); }
});
app.post('/api/withdrawals', userEmail, async(req,res)=>{
 try {const amount=Number(req.body.amount); const wallet=String(req.body.wallet||'').trim();
 if(!Number.isFinite(amount)||amount<MIN_WITHDRAWAL) return res.status(400).json({success:false,message:`Minimum withdrawal is ${MIN_WITHDRAWAL} USDT.`});
 if(!/^0x[a-fA-F0-9]{40}$/.test(wallet)) return res.status(400).json({success:false,message:'Enter a valid BEP20 wallet address.'});
 const client=await pool.connect(); try {await client.query('BEGIN'); const p=await client.query('SELECT COALESCE(SUM(amount),0) AS power FROM usdt_power WHERE email=$1 AND expires_at>NOW()',[req.email]); const dep=await client.query("SELECT COALESCE(SUM(amount),0) AS total FROM usdt_deposits WHERE email=$1 AND status='Approved'",[req.email]); const w=await client.query("SELECT COALESCE(SUM(amount),0) AS total FROM usdt_withdrawals WHERE email=$1 AND status IN ('Pending','Approved')",[req.email]);
 // Withdrawal eligibility is limited to the approved deposit balance; mining estimates are not withdrawable funds.
 const available=Math.max(0,Number(dep.rows[0].total)-Number(w.rows[0].total)); if(amount>available){await client.query('ROLLBACK');return res.status(400).json({success:false,message:`Available approved deposit balance is ${available.toFixed(4)} USDT. Mining estimates are not withdrawable.`});}
 const wid=id(); await client.query('INSERT INTO usdt_withdrawals(id,email,amount,wallet) VALUES($1,$2,$3,$4)',[wid,req.email,amount,wallet]); await client.query("INSERT INTO usdt_history(email,kind,amount,detail) VALUES($1,'Withdrawal requested',$2,$3)",[req.email,amount,`BEP20 wallet ${wallet}; pending manual review`]); await client.query('COMMIT'); res.json({success:true,message:'Withdrawal request submitted. Approval does not send funds automatically.',id:wid,status:'Pending'});
 } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
 } catch(e){console.error(e);res.status(500).json({success:false,message:'Could not submit withdrawal.'});}
});
app.get('/api/history', userEmail, async(req,res)=>{try{const r=await pool.query('SELECT id,kind,amount,detail,created_at FROM usdt_history WHERE email=$1 ORDER BY created_at DESC LIMIT 100',[req.email]);res.json({success:true,items:r.rows});}catch(e){console.error(e);res.status(500).json({success:false,message:'Could not load history.'});}});
app.get('/api/admin/overview', adminOnly, async(_req,res)=>{try{const [users,deposits,power,withdrawals]=await Promise.all([pool.query('SELECT email,created_at FROM usdt_users ORDER BY created_at DESC LIMIT 500'),pool.query('SELECT * FROM usdt_deposits ORDER BY created_at DESC LIMIT 500'),pool.query('SELECT * FROM usdt_power ORDER BY created_at DESC LIMIT 500'),pool.query('SELECT * FROM usdt_withdrawals ORDER BY created_at DESC LIMIT 500')]);res.json({success:true,users:users.rows,deposits:deposits.rows,power:power.rows,withdrawals:withdrawals.rows});}catch(e){console.error(e);res.status(500).json({success:false,message:'Admin overview failed.'});}});
app.post('/api/admin/deposits/:id/review', adminOnly, async(req,res)=>{const status=String(req.body.status||'');const note=String(req.body.note||'').slice(0,500);if(!['Approved','Rejected'].includes(status))return res.status(400).json({success:false,message:'Status must be Approved or Rejected.'});const client=await pool.connect();try{await client.query('BEGIN');const d=await client.query('SELECT * FROM usdt_deposits WHERE id=$1 FOR UPDATE',[req.params.id]);if(!d.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Deposit not found.'});}if(d.rows[0].status!=='Pending'){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Deposit has already been reviewed.'});}await client.query('UPDATE usdt_deposits SET status=$1,admin_note=$2,reviewed_at=NOW() WHERE id=$3',[status,note,req.params.id]);if(status==='Approved'){const power=Number(d.rows[0].amount)*POWER_PER_USDT;const expiry=new Date(Date.now()+POWER_DAYS*86400000);await client.query('INSERT INTO usdt_power(id,email,amount,source_deposit_id,expires_at) VALUES($1,$2,$3,$4,$5)',[id(),d.rows[0].email,power,req.params.id,expiry]);await client.query("INSERT INTO usdt_history(email,kind,amount,detail) VALUES($1,'Power added',$2,$3)",[d.rows[0].email,power,`${POWER_PER_USDT} Power per USDT; expires ${expiry.toISOString()}`]);}await client.query("INSERT INTO usdt_history(email,kind,amount,detail) VALUES($1,$2,$3,$4)",[d.rows[0].email,`Deposit ${status.toLowerCase()}`,d.rows[0].amount,note||`Admin marked ${status}`]);await client.query('COMMIT');res.json({success:true,message:`Deposit ${status.toLowerCase()}.`});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({success:false,message:'Review failed.'});}finally{client.release();}});
app.post('/api/admin/power', adminOnly, async(req,res)=>{try{const email=emailNorm(req.body.email);const amount=Number(req.body.amount);const days=Number(req.body.days||POWER_DAYS);if(!email||!Number.isFinite(amount)||amount<=0||!Number.isInteger(days)||days<1||days>365)return res.status(400).json({success:false,message:'Enter valid email, positive Power amount and 1–365 days.'});const u=await pool.query('SELECT email FROM usdt_users WHERE email=$1',[email]);if(!u.rowCount)return res.status(404).json({success:false,message:'User email is not registered.'});const expiry=new Date(Date.now()+days*86400000);await pool.query('INSERT INTO usdt_power(id,email,amount,expires_at) VALUES($1,$2,$3,$4)',[id(),email,amount,expiry]);await pool.query("INSERT INTO usdt_history(email,kind,amount,detail) VALUES($1,'Admin Power added',$2,$3)",[email,amount,`Manual admin addition; expires ${expiry.toISOString()}`]);res.json({success:true,message:`Added ${amount} Power for ${days} days.`,expiresAt:expiry});}catch(e){console.error(e);res.status(500).json({success:false,message:'Could not add Power.'});}});
app.post('/api/admin/withdrawals/:id/review', adminOnly, async(req,res)=>{try{const status=String(req.body.status||'');const note=String(req.body.note||'').slice(0,500);if(!['Approved','Rejected'].includes(status))return res.status(400).json({success:false,message:'Status must be Approved or Rejected.'});const r=await pool.query("UPDATE usdt_withdrawals SET status=$1,admin_note=$2,reviewed_at=NOW() WHERE id=$3 AND status='Pending' RETURNING *",[status,note,req.params.id]);if(!r.rowCount)return res.status(404).json({success:false,message:'Pending withdrawal not found.'});await pool.query("INSERT INTO usdt_history(email,kind,amount,detail) VALUES($1,$2,$3,$4)",[r.rows[0].email,`Withdrawal ${status.toLowerCase()}`,r.rows[0].amount,note||`Admin marked ${status}; funds are not transferred automatically`]);res.json({success:true,message:`Withdrawal ${status.toLowerCase()}. This action does not transfer funds on-chain.`});}catch(e){console.error(e);res.status(500).json({success:false,message:'Review failed.'});}});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({success:false,message:'Unexpected server error.'});});
initDb().then(()=>app.listen(PORT,()=>console.log(`USDT Fan Miner API listening on ${PORT}`))).catch(e=>{console.error('Database startup failed:',e);process.exit(1);});
