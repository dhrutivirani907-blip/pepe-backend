const express = require('express');
const cors = require('cors');
const fs = require('fs'); // File system module

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const FILE_PATH = './withdrawals.json';

// File se data load karne ke liye helper function
const loadWithdrawals = () => {
    if (!fs.existsSync(FILE_PATH)) {
        fs.writeFileSync(FILE_PATH, JSON.stringify([]));
    }
    const data = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(data || '[]');
};

// File me data save karne ke liye helper function
const saveWithdrawals = (data) => {
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
};

app.get('/', (req, res) => {
    res.json({ status: "Active", app: "BONK Tap Backend" });
});

// User Withdrawal Submit Karega
app.post('/api/withdraw', (req, res) => {
    const { binanceId, amount } = req.body;

    if (!binanceId || !amount || amount < 1000) {
        return res.status(400).json({ success: false, message: "Invalid Request Data" });
    }

    const withdrawals = loadWithdrawals();

    const record = {
        id: Date.now().toString(),
        binanceId: binanceId,
        amount: amount,
        status: "Pending",
        date: new Date()
    };

    withdrawals.push(record);
    saveWithdrawals(withdrawals); // File me save ho gaya

    console.log(`[WITHDRAWAL] Binance ID: ${binanceId} | Amount: ${amount} BONK`);

    res.json({ success: true, message: "Request received" });
});

// ADMIN: Get All Withdrawal Requests
app.get('/api/withdrawals', (req, res) => {
    const withdrawals = loadWithdrawals();
    res.json(withdrawals);
});

// ADMIN: Update Status Approve/Reject
app.put('/api/withdrawals/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    let withdrawals = loadWithdrawals();
    const item = withdrawals.find(w => w.id === id);

    if (item) {
        item.status = status;
        saveWithdrawals(withdrawals); // Updated status save ho gaya
        return res.json({ success: true, message: `Status updated to ${status}` });
    }

    res.status(404).json({ success: false, message: "Record not found" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
