const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Database Migration & Schema Fixes
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id VARCHAR(255) PRIMARY KEY,
                user_id VARCHAR(255),
                binance_id VARCHAR(255),
                wallet VARCHAR(255),
                amount NUMERIC NOT NULL,
                type VARCHAR(50) DEFAULT 'Binance',
                total_deduct NUMERIC DEFAULT 0,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            ALTER TABLE withdrawals 
            ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS binance_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS wallet VARCHAR(255),
            ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'Binance',
            ADD COLUMN IF NOT EXISTS total_deduct NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

            ALTER TABLE withdrawals ALTER COLUMN user_id DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN binance_id DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN wallet DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN type DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN total_deduct DROP NOT NULL;
        `);

        console.log("SUCCESS: Database schema fully active and verified!");
    } catch (err) {
        console.error("Database initialization error:", err.message);
    }
};

initDb();

app.get('/', (req, res) => {
    res.json({ status: "Active", app: "BONK Tap Backend" });
});

// 1. ADS & ENERGY RECHARGE HANDLER (Fix for Ads refill issue)
app.post('/api/recharge-energy', (req, res) => {
    const { userId, energyAmount } = req.body;
    const addedEnergy = energyAmount || 500;

    console.log(`[ADS REWARD] Refill request received for: ${userId || 'User'} | Added: ${addedEnergy}`);
    
    res.json({ 
        success: true, 
        message: "Energy successfully recharged!", 
        energyAdded: addedEnergy 
    });
});

// 2. SUBMIT WITHDRAWAL
app.post('/api/withdraw', async (req, res) => {
    const { binanceId, amount, userId, wallet, type, totalDeduct } = req.body;

    if (!binanceId || !amount || amount < 1000) {
        return res.status(400).json({ success: false, message: "Invalid Request Data" });
    }

    const id = Date.now().toString();
    const finalUserId = userId || req.body.user_id || 'N/A';
    const finalWallet = wallet || req.body.wallet || binanceId;
    const finalType = type || req.body.type || 'Binance';
    const finalDeduct = totalDeduct || req.body.total_deduct || amount;

    try {
        const query = `
            INSERT INTO withdrawals (id, user_id, binance_id, wallet, amount, type, total_deduct, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;
        `;
        await pool.query(query, [id, finalUserId, binanceId, finalWallet, amount, finalType, finalDeduct, 'Pending']);

        console.log(`[WITHDRAWAL SUCCESS] Binance ID: ${binanceId} | Amount: ${amount}`);
        res.json({ success: true, message: "Request received" });
    } catch (err) {
        console.error("Database Save Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error", error: err.message });
    }
});

// 3. ADMIN: GET ALL WITHDRAWALS
app.get('/api/withdrawals', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id, 
                user_id AS "userId",
                binance_id AS "binanceId", 
                wallet,
                amount::INTEGER AS amount, 
                type,
                total_deduct AS "totalDeduct",
                status, 
                created_at 
            FROM withdrawals 
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Database Fetch Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

// 4. ADMIN: UPDATE STATUS
app.put('/api/withdrawals/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const query = `UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *;`;
        const result = await pool.query(query, [status, id]);

        if (result.rowCount > 0) {
            return res.json({ success: true, message: `Status updated to ${status}` });
        }
        res.status(404).json({ success: false, message: "Record not found" });
    } catch (err) {
        console.error("Database Update Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
