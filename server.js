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
                amount NUMERIC NOT NULL,
                type VARCHAR(50) DEFAULT 'Binance',
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Fix Constraints: Make user_id, type & binance_id optional (Allow NULL)
        await pool.query(`
            ALTER TABLE withdrawals 
            ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS binance_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'Binance',
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

            ALTER TABLE withdrawals ALTER COLUMN user_id DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN type DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN binance_id DROP NOT NULL;
        `);

        console.log("Database schema updated: type and user_id constraints fixed!");
    } catch (err) {
        console.error("Database schema error:", err.message);
    }
};

initDb();

app.get('/', (req, res) => {
    res.json({ status: "Active", app: "BONK Tap Backend" });
});

// Submit Withdrawal
app.post('/api/withdraw', async (req, res) => {
    const { binanceId, amount, userId, type } = req.body;

    if (!binanceId || !amount || amount < 1000) {
        return res.status(400).json({ success: false, message: "Invalid Request Data" });
    }

    const id = Date.now().toString();
    const finalUserId = userId || req.body.user_id || 'N/A';
    const finalType = type || req.body.type || 'Binance';

    try {
        const query = `
            INSERT INTO withdrawals (id, user_id, binance_id, amount, type, status)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
        `;
        await pool.query(query, [id, finalUserId, binanceId, amount, finalType, 'Pending']);

        console.log(`[WITHDRAWAL SUCCESS] Binance ID: ${binanceId} | Amount: ${amount}`);
        res.json({ success: true, message: "Request received" });
    } catch (err) {
        console.error("Database Save Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error", error: err.message });
    }
});

// ADMIN: Get All Requests
app.get('/api/withdrawals', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id, 
                user_id AS "userId",
                binance_id AS "binanceId", 
                amount::INTEGER AS amount, 
                type,
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

// ADMIN: Update Status
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
