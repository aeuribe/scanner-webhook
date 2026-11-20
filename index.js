const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ type: 'text/*', limit: '50mb' }));

// Guarda en memoria las últimas 30 lecturas completas para /api/webhook/logs
const RECENT_LOGS = [];
function saveLog(entry) {
  RECENT_LOGS.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (RECENT_LOGS.length > 30) RECENT_LOGS.pop();
}

// ============================================================
// RUTEO POR CÓDIGO DE CASILLERO (OCR)
// ============================================================

const CHUTE_BY_COUNTRY = {
  CU: 1, // Venezuela
  DO: 2, // Costa Rica
  GT: 3, // Guatemala
  CR: 4, // República Dominicana
  VE: 5, // Cuba
};

const MANUAL_CHUTE = 6;

const PREFIX_ALIASES = {
  V: 'VE',
};

// Patrones verificados contra etiquetas reales:
// 1. Códigos de 2 letras CON guion (VE-0234266, CR-1622241): detecta incluso si el OCR
//    pegó texto antes o después ("TOCR-1622241ANA", "52AW24TTERVE-0234266"), bloqueando "AVE-".
// 2. Códigos de 2 letras SIN guion (CR390621): permite "TO" o "TER" pegado antes.
// 3. Alias de 1 letra "V" (V-0578342): exige inicio de palabra o prefijo de dirección
//    ("TO", "TER", "ST", "STE", "APT", "UNIT", "FL") para no confundirse con "INV-12345".
const MATCH_PATTERNS = [
  /(?<!A)(VE|CR|GT|DO|CU)-(\d{3,8})(?!\d)/g,
  /(?<![A-Z0-9])(?:TO|TER)?(VE|CR|GT|DO|CU)(\d{3,8})(?!\d)/g,
  /(?<![A-Z0-9])(?:TO|TER|ST|STE|APT|UNIT|FL)?(V)-?(\d{3,8})(?!\d)/g,
];

function normalizeOcrText(ocr) {
  if (!ocr) return '';
  if (Array.isArray(ocr)) return ocr.join('\n');
  if (typeof ocr === 'object') return JSON.stringify(ocr);
  return String(ocr);
}

function extractOcrCandidate(data) {
  const possibleKeys = ['ocr', 'ocr_text', 'ocrText', 'OCR', 'text', 'ocr_result', 'ocrResult'];
  for (const key of possibleKeys) {
    if (data[key] !== undefined && data[key] !== null && String(data[key]).trim() !== '') {
      return { sourceField: key, rawValue: data[key] };
    }
  }
  return { sourceField: null, rawValue: '' };
}

function resolveChute(rawOcr) {
  const text = normalizeOcrText(rawOcr).toUpperCase();

  if (!text.trim()) {
    return { chute: MANUAL_CHUTE, country: null, matches: [], reason: 'no_ocr_text', evaluatedText: '' };
  }

  const matches = [];
  const seen = new Set();

  for (const regex of MATCH_PATTERNS) {
    for (const m of text.matchAll(regex)) {
      const prefix = m[1];
      const digits = m[2];
      const normalizedCode = `${prefix}-${digits}`;
      const uniqueKey = `${m.index}:${normalizedCode}`;

      if (!seen.has(uniqueKey)) {
        seen.add(uniqueKey);
        const country = PREFIX_ALIASES[prefix] || prefix;
        matches.push({
          rawMatch: m[0],
          normalizedCode,
          country,
        });
      }
    }
  }

  if (matches.length === 0) {
    return { chute: MANUAL_CHUTE, country: null, matches, reason: 'no_code_found', evaluatedText: text };
  }

  const countries = [...new Set(matches.map((m) => m.country))];

  if (countries.length > 1) {
    return { chute: MANUAL_CHUTE, country: null, matches, reason: 'multiple_countries', evaluatedText: text };
  }

  const country = countries[0];
  return { chute: CHUTE_BY_COUNTRY[country], country, matches, reason: 'ok', evaluatedText: text };
}

// ============================================================
// ENDPOINTS
// ============================================================

app.post('/api/webhook/scanner', upload.any(), (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  let parsedBody = req.body;
  if (typeof req.body === 'string') {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (_) {
      parsedBody = { raw_text_body: req.body };
    }
  }

  const data = (parsedBody && parsedBody.raw) ? parsedBody.raw : (parsedBody || {});
  const barcode = data.barcode || data.code || null;

  const attachedFiles = (req.files || []).map((f) => ({
    fieldname: f.fieldname,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: f.size,
  }));

  console.log('\n================ NUEVA LECTURA DE MÁQUINA ================');
  console.log(`IP: ${ip} | Content-Type: ${req.headers['content-type']}`);
  console.log('Query params:', JSON.stringify(req.query));
  console.log('Body completo recibido:', JSON.stringify(parsedBody, null, 2));
  if (attachedFiles.length > 0) {
    console.log('Archivos adjuntos:', JSON.stringify(attachedFiles, null, 2));
  }

  const ocrCandidate = extractOcrCandidate(data);
  const routing = resolveChute(ocrCandidate.rawValue);

  const decisionSummary = {
    ip,
    contentType: req.headers['content-type'] || 'unknown',
    receivedKeys: Object.keys(data),
    barcode,
    ocrFieldDetected: ocrCandidate.sourceField,
    ocrRawValue: ocrCandidate.rawValue,
    ocrEvaluatedText: routing.evaluatedText,
    matches: routing.matches,
    country: routing.country,
    reason: routing.reason,
    assignedChute: routing.chute,
    attachedFiles,
  };

  console.log('Decisión tomada:', JSON.stringify(decisionSummary, null, 2));
  console.log('==========================================================\n');

  saveLog({
    fullPayload: parsedBody,
    query: req.query,
    decision: decisionSummary,
  });

  return res.status(200).json({
    result: 'Success',
    sort_Port: routing.chute,
    debug_info: decisionSummary,
  });
});

app.get('/api/webhook/logs', (req, res) => {
  res.status(200).json({
    total_stored: RECENT_LOGS.length,
    logs: RECENT_LOGS,
  });
});

app.post('/api/webhook/upload-image-test', upload.any(), (req, res) => {
  console.log('\n=== NUEVA PETICIÓN DE FOTOS RECIBIDA ===');
  console.log(`Content-Type: ${req.headers['content-type']}`);

  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Campos de texto (Fields/JSON):', JSON.stringify(req.body, null, 2));
  }
  if (req.files && req.files.length > 0) {
    req.files.forEach((file, index) => {
      console.log(`Archivo [${index}]: FieldName='${file.fieldname}', FileName='${file.originalname}', MimeType='${file.mimetype}', Size=${file.size} bytes`);
    });
  }
  console.log('=========================================\n');

  return res.status(200).json({
    status: 'received',
    message: 'Payload inspected successfully',
  });
});

app.get('/', (req, res) => {
  res.send('Scanner Webhook — Running');
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

process.on('SIGTERM', () => process.exit(0));

module.exports = { resolveChute };