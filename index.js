const express = require('express');
const app = express();

app.use(express.json());

app.post('/api/webhook/scanner', (req, res) => {
  const body = req.body;
  const data = body.raw || body;

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`Request received from IP: ${ip}`);
  console.log('Request received:', JSON.stringify(data, null, 2));

  if (!data.code) {
    return res.status(400).json({ result: 'Error', message: 'code is required' });
  }

  if (!data.weight || data.weight <= 0) {
    return res.status(400).json({ result: 'Error', message: 'weight is required and must be greater than 0' });
  }

  if (!data.hid) {
    return res.status(400).json({ result: 'Error', message: 'hid is required' });
  }

  const sortPort = Math.floor(Math.random() * 3) + 1;

  return res.status(200).json({
    result: 'Success',
    sort_Port: sortPort,
    label_pdf_to_base64: ''
  });
});

app.get('/', (req, res) => {
  res.send('Scanner Webhook — Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
