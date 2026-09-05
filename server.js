const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Table Setup
const initDb = async () => {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS withdrawals (
            id VARCHAR(255) PRIMARY KEY,
            binance_id VARCHAR(255) NOT NULL,
            amount NUMERIC NOT NULL,
            status VARCHAR(50) DEFAULT 'Pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(createTableQuery);
        console.log("Database table is active and ready!");
    } catch (err) {
        console.error("Database connection error:", err);
    }
};

initDb();

app.get('/', (req, res) => {
    res.json({ status: "Active", app: "BONK Tap Backend" });
});

// Submit Withdrawal
app.post('/api/withdraw', async (req, res) => {
    const { binanceId, amount } = req.body;

    if (!binanceId || !amount || amount < 1000) {
        return res.status(400).json({ success: false, message: "Invalid Request Data" });
    }

    const id = Date.now().toString();

    try {
        const query = `
            INSERT INTO withdrawals (id, binance_id, amount, status)
            VALUES ($1, $2, $3, $4) RETURNING *;
        `;
        await pool.query(query, [id, binanceId, amount, 'Pending']);

        res.json({ success: true, message: "Request received" });
    } catch (err) {
        console.error("Database Save Error:", err);
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

// ADMIN: Get All Requests (Fixed Field Mapping for Frontend)
app.get('/api/withdrawals', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id, 
                binance_id AS "binanceId", 
                amount::INTEGER AS amount, 
                status, 
                created_at 
            FROM withdrawals 
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Database Fetch Error:", err);
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
        console.error("Database Update Error:", err);
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
