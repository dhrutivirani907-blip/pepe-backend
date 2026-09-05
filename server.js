const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const withdrawals = [];

app.get('/', (req, res) => {
    res.json({ status: "Active", app: "BONK Tap Backend" });
});

// User Withdrawal Submit Karega
app.post('/api/withdraw', (req, res) => {
    const { binanceId, amount } = req.body;

    if (!binanceId || !amount || amount < 1000) {
        return res.status(400).json({ success: false, message: "Invalid Request Data" });
    }

    const record = {
        id: Date.now().toString(),
        binanceId: binanceId,
        amount: amount,
        status: "Pending",
        date: new Date()
    };

    withdrawals.push(record);

    console.log(`[WITHDRAWAL] Binance ID: ${binanceId} | Amount: ${amount} BONK`);

    res.json({ success: true, message: "Request received" });
});

// ADMIN: Get All Withdrawal Requests (FIX 404)
app.get('/api/withdrawals', (req, res) => {
    res.json(withdrawals);
});

// ADMIN: Update Status Approve/Reject (FIX 404)
app.put('/api/withdrawals/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const item = withdrawals.find(w => w.id === id);
    if (item) {
        item.status = status;
        return res.json({ success: true, message: `Status updated to ${status}` });
    }

    res.status(404).json({ success: false, message: "Record not found" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
