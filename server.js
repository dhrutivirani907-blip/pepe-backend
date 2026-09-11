const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins & headers
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

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
                token_type VARCHAR(50) DEFAULT 'BONK',
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
            ADD COLUMN IF NOT EXISTS token_type VARCHAR(50) DEFAULT 'BONK',
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

// 1. ADS & ENERGY RECHARGE HANDLERS
const rechargeHandler = (req, res) => {
    const { userId, energyAmount } = req.body;
    const addedEnergy = energyAmount || 300;

    console.log(`[ADS REWARD] Refill request received for: ${userId || 'User'} | Added: ${addedEnergy}`);
    
    res.json({ 
        success: true, 
        message: "Energy successfully recharged!", 
        energyAdded: addedEnergy 
    });
};

app.post('/api/recharge-energy', rechargeHandler);
app.post('/api/bonk/recharge-energy', rechargeHandler);

// 2. SUBMIT WITHDRAWAL HANDLER
const withdrawHandler = async (req, res) => {
    const { binanceId, amount, userId, wallet, type, tokenType, totalDeduct } = req.body;

    if (!binanceId || !amount || amount < 1000) {
        return res.status(400).json({ success: false, message: "Invalid Request Data" });
    }

    const id = Date.now().toString();
    const finalUserId = userId || req.body.user_id || 'N/A';
    const finalWallet = wallet || req.body.wallet || binanceId;
    const finalType = type || req.body.type || 'Binance';
    const finalTokenType = tokenType || req.body.token_type || 'BONK';
    const finalDeduct = totalDeduct || req.body.total_deduct || amount;

    try {
        const query = `
            INSERT INTO withdrawals (id, user_id, binance_id, wallet, amount, type, token_type, total_deduct, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *;
        `;
        await pool.query(query, [id, finalUserId, binanceId, finalWallet, amount, finalType, finalTokenType, finalDeduct, 'Pending']);

        console.log(`[WITHDRAWAL SUCCESS] Token: ${finalTokenType} | Binance ID: ${binanceId} | Amount: ${amount}`);
        res.json({ success: true, message: "Request received" });
    } catch (err) {
        console.error("Database Save Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error", error: err.message });
    }
};

app.post('/api/withdraw', withdrawHandler);
app.post('/api/bonk/withdraw', withdrawHandler);

// 3. GET WITHDRAWALS HANDLERS (FILTERED BY TOKEN)
app.get('/api/bonk/withdrawals', async (req, res) => {
    try {
        const query = `
            SELECT id, user_id AS "userId", binance_id AS "binanceId", wallet, amount, type, token_type AS "tokenType", status, created_at AS "createdAt"
            FROM withdrawals 
            WHERE UPPER(token_type) = 'BONK' OR token_type IS NULL
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Database Fetch Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error", error: err.message });
    }
});

app.get('/api/withdrawals', async (req, res) => {
    try {
        const query = `
            SELECT id, user_id AS "userId", binance_id AS "binanceId", wallet, amount, type, token_type AS "tokenType", status, created_at AS "createdAt"
            FROM withdrawals 
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Database Fetch Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error", error: err.message });
    }
});

// 4. UPDATE WITHDRAWAL STATUS HANDLER
const updateStatusHandler = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).json({ success: false, message: "Status is required" });
    }

    try {
        const query = `UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *;`;
        const result = await pool.query(query, [status, id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        console.error("Database Update Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error", error: err.message });
    }
};

app.put('/api/withdrawals/:id', updateStatusHandler);
app.put('/api/bonk/withdrawals/:id', updateStatusHandler);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
