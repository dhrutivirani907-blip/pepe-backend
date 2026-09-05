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

app.post('/api/withdraw', (req, res) => {
    const { binanceId, amount } = req.body;

    if (!binanceId || !amount || amount < 1000) {
        return res.status(400).json({ success: false, message: "Invalid Request Data" });
    }

    const record = {
        id: Date.now(),
        binanceId: binanceId,
        amount: amount,
        date: new Date()
    };

    withdrawals.push(record);

    console.log(`[WITHDRAWAL] Binance ID: ${binanceId} | Amount: ${amount} BONK`);

    res.json({ success: true, message: "Request received" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
