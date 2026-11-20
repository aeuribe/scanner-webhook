const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

// Acepta JSON, formularios URL-encoded y texto plano para no perder nada
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ type: 'text/*', limit: '50mb' }));

// Guarda en memoria las últimas 30 lecturas para poder verlas desde el navegador
const RECENT_LOGS = [];
function saveLog(entry) {
  RECENT_LOGS.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (RECENT_LOGS.length > 30) RECENT_LOGS.pop();
}

// ============================================================
// RUTEO POR CÓDIGO DE CASILLERO (OCR)
// ============================================================

const CHUTE_BY_COUNTRY = {
  VE: 1, // Venezuela
  CR: 2, // Costa Rica
  GT: 3, // Guatemala
  DO: 4, // República Dominicana
  CU: 5, // Cuba
};

const MANUAL_CHUTE = 6;

const PREFIX_ALIASES = {
  V: 'VE',
};

const KNOWN_PREFIXES = [
  ...Object.keys(CHUTE_BY_COUNTRY),
  ...Object.keys(PREFIX_ALIASES),
];

const sortedPrefixes = [...KNOWN_PREFIXES].sort((a, b) => b.length - a.length);
const CODE_REGEX = new RegExp(
  `(?<![A-Z0-9])(${sortedPrefixes.join('|')})-?(\\d{3,8})(?!\\d)`,
  'g'
);

function normalizeOcrText(ocr) {
  if (!ocr) return '';
  if (Array.isArray(ocr)) return ocr.join('\n');
  if (typeof ocr === 'object') return JSON.stringify(ocr);
  return String(ocr);
}

// Extrae el texto OCR sin importar cómo lo llame la máquina
function extractOcrCandidate(data) {
  const possibleKeys = ['ocr_text', 'ocr', 'ocrText', 'OCR', 'text', 'ocr_result', 'ocrResult'];
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
  for (const m of text.matchAll(CODE_REGEX)) {
    const prefix = m[1];
    const country = PREFIX_ALIASES[prefix] || prefix;
    matches.push({ code: m[0], country });
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

// upload.any() permite recibir tanto JSON puro como multipart/form-data (con o sin fotos)
app.post('/api/webhook/scanner', upload.any(), (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Si llegó como texto plano que parece JSON, intentamos parsearlo
  let parsedBody = req.body;
  if (typeof req.body === 'string') {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (_) {
      parsedBody = { raw_text_body: req.body };
    }
  }

  const data = (parsedBody && parsedBody.raw) ? parsedBody.raw : (parsedBody || {});

  // Resumen de archivos si la máquina adjuntó imágenes en este mismo endpoint
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

  // Advertencias (sin bloquear ni estrangular la petición)
  const warnings = [];
  if (!data.code) warnings.push('missing_code');
  if (!data.weight || Number(data.weight) <= 0) warnings.push('missing_or_zero_weight');
  if (!data.hid) warnings.push('missing_hid');

  // Buscamos el campo OCR y decidimos el chute
  const ocrCandidate = extractOcrCandidate(data);
  const routing = resolveChute(ocrCandidate.rawValue);

  const decisionSummary = {
    ip,
    contentType: req.headers['content-type'] || 'unknown',
    receivedKeys: Object.keys(data),
    warnings,
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

  // Siempre responde 200 con sort_Port para que la máquina no se trabe,
  // e incluye "debug_info" para inspección.
  return res.status(200).json({
    result: 'Success',
    sort_Port: routing.chute,
    debug_info: decisionSummary,
  });
});

// --- VISOR EN VIVO DESDE EL NAVEGADOR / TELÉFONO ---
app.get('/api/webhook/logs', (req, res) => {
  res.status(200).json({
    total_stored: RECENT_LOGS.length,
    logs: RECENT_LOGS,
  });
});

// --- ENDPOINT "ATRAPATODO" PARA FOTOS ---
app.post('/api/webhook/upload-image-test', upload.any(), (req, res) => {
  console.log('\n=== NUEVA PETICIÓN DE FOTOS RECIBIDA ===');
  console.log(`Content-Type: ${req.headers['content-type']}`);

  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Campos de texto (Fields/JSON):', JSON.stringify(req.body, null, 2));
  } else {
    console.log('Campos de texto: Ninguno detectado');
  }

  if (req.files && req.files.length > 0) {
    req.files.forEach((file, index) => {
      console.log(`Archivo [${index}]: FieldName='${file.fieldname}', FileName='${file.originalname}', MimeType='${file.mimetype}', Size=${file.size} bytes`);
    });
  } else {
    console.log('Archivos adjuntos: Ninguno detectado');
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
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = { resolveChute };