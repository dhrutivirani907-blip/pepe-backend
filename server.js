const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

let withdrawalRequests = [];

// API: Save User Withdrawal
app.post('/api/withdraw', (req, res) => {
    const { amount, address, date } = req.body;
    withdrawalRequests.push({ id: Date.now(), amount, address, date, status: 'Pending' });
    res.json({ success: true, message: "Request Saved" });
});

// API: Admin Panel Data View
app.get('/admin/requests', (req, res) => {
    let html = `<h1>Withdrawal Requests Panel</h1><table border="1" cellpadding="8">
    <tr><th>ID</th><th>Amount</th><th>Address</th><th>Date</th><th>Status</th></tr>`;
    
    withdrawalRequests.forEach(req => {
        html += `<tr><td>${req.id}</td><td>${req.amount} PEPE</td><td>${req.address}</td><td>${req.date}</td><td>${req.status}</td></tr>`;
    });
    
    html += `</table>`;
    res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));