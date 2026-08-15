const express = require('express');
const multer = require('multer'); // Agregado: Dependencia necesaria para interceptar archivos

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

  // OCR field — optional for now, log it when present
  if (data.ocr_text) {
    console.log(`OCR routing code detected: ${data.ocr_text}`);
  } else {
    console.log('No OCR routing code in this request');
  }

  const sortPort = Math.floor(Math.random() * 3) + 1;

  return res.status(200).json({
    result: 'Success',
    sort_Port: sortPort,
  });
});

// --- NUEVO ENDPOINT "ATRAPATODO" PARA FOTOS ---
// Usamos upload.any() para aceptar cualquier archivo o campo sin saber cómo se llama
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // Límite de 50MB por si acaso

app.post('/api/webhook/upload-image-test', upload.any(), (req, res) => {
  console.log('\n=== NUEVA PETICIÓN DE FOTOS RECIBIDA ===');
  console.log(`Content-Type: ${req.headers['content-type']}`);

  // 1. Mostrar campos de texto enviados (ej. code, tracking, etc.)
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Campos de texto (Fields/JSON):', JSON.stringify(req.body, null, 2));
  } else {
    console.log('Campos de texto: Ninguno detectado');
  }

  // 2. Mostrar archivos detectados
  if (req.files && req.files.length > 0) {
    req.files.forEach((file, index) => {
      console.log(`Archivo [${index}]: FieldName='${file.fieldname}', FileName='${file.originalname}', MimeType='${file.mimetype}', Size=${file.size} bytes`);
    });
  } else {
    console.log('Archivos adjuntos: Ninguno detectado');
  }

  console.log('=========================================\n');

  // Responder 200 OK siempre para que la máquina no genere errores
  return res.status(200).json({
    status: 'received',
    message: 'Payload inspected successfully'
  });
});
// --- FIN DEL NUEVO ENDPOINT ---

app.get('/', (req, res) => {
  res.send('Scanner Webhook — Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});