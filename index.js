const express = require('express');
const multer = require('multer');

const app = express();

app.use(express.json());

// ============================================================
// RUTEO POR CÓDIGO DE CASILLERO (OCR)
// ============================================================

// Prefijo de país -> número de chute. Ajusta los números a como estén
// físicamente asignadas las salidas de la máquina.
const CHUTE_BY_COUNTRY = {
  VE: 1, // Venezuela
  CR: 2, // Costa Rica
  GT: 3, // Guatemala
  DO: 4, // República Dominicana
  CU: 5, // Cuba
};

// Chute para paquetes sin código, con código desconocido o con códigos
// de dos países distintos en la misma etiqueta (revisión manual).
const MANUAL_CHUTE = 6;

// Variantes que aparecen en etiquetas reales y a qué país corresponden.
// Ej: "V-0578342" es Venezuela escrito con una sola letra.
const PREFIX_ALIASES = {
  V: 'VE',
};

// Todos los prefijos que el buscador debe reconocer.
const KNOWN_PREFIXES = [
  ...Object.keys(CHUTE_BY_COUNTRY),
  ...Object.keys(PREFIX_ALIASES),
];

// Busca: prefijo + guion opcional + 3 a 8 dígitos.
// Ejemplos que encuentra: VE-1297892, CR390621, GT-793, GT-0000793, V-0578342
//
// - (?<![A-Z0-9]) evita agarrar el prefijo en medio de otra palabra
//   o número (ej. "WR01-502470471", "MIA-GT.ZOO").
// - No se permite espacio entre letras y números a propósito, para no
//   confundir estados de EE.UU. con códigos postales ("CO 80202", "PA 19104").
// - (?!\d) asegura que no se corte un número más largo a la mitad.
// Los prefijos más largos van primero para que "VE" gane antes que "V".
const sortedPrefixes = [...KNOWN_PREFIXES].sort((a, b) => b.length - a.length);
const CODE_REGEX = new RegExp(
  `(?<![A-Z0-9])(${sortedPrefixes.join('|')})-?(\\d{3,8})(?!\\d)`,
  'g'
);

// Convierte lo que mande la máquina (texto, arreglo, etc.) en un solo texto.
function normalizeOcrText(ocr) {
  if (!ocr) return '';
  if (Array.isArray(ocr)) return ocr.join('\n');
  if (typeof ocr === 'object') return JSON.stringify(ocr);
  return String(ocr);
}

// Devuelve { chute, country, matches, reason }
function resolveChute(rawOcr) {
  const text = normalizeOcrText(rawOcr).toUpperCase();

  if (!text.trim()) {
    return { chute: MANUAL_CHUTE, country: null, matches: [], reason: 'no_ocr_text' };
  }

  const matches = [];
  for (const m of text.matchAll(CODE_REGEX)) {
    const prefix = m[1];
    const country = PREFIX_ALIASES[prefix] || prefix;
    matches.push({ code: m[0], country });
  }

  if (matches.length === 0) {
    return { chute: MANUAL_CHUTE, country: null, matches, reason: 'no_code_found' };
  }

  const countries = [...new Set(matches.map((m) => m.country))];

  if (countries.length > 1) {
    return { chute: MANUAL_CHUTE, country: null, matches, reason: 'multiple_countries' };
  }

  const country = countries[0];
  return { chute: CHUTE_BY_COUNTRY[country], country, matches, reason: 'ok' };
}

// ============================================================
// ENDPOINTS
// ============================================================

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

  const routing = resolveChute(data.ocr_text);

  console.log(
    `[ROUTING] code=${data.code} reason=${routing.reason} ` +
    `country=${routing.country || '-'} chute=${routing.chute} ` +
    `matches=${JSON.stringify(routing.matches.map((m) => m.code))}`
  );

  return res.status(200).json({
    result: 'Success',
    sort_Port: routing.chute,
  });
});

// --- ENDPOINT "ATRAPATODO" PARA FOTOS ---
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

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
    message: 'Payload inspected successfully'
  });
});

app.get('/', (req, res) => {
  res.send('Scanner Webhook — Running');
});

// Solo arranca el servidor si se ejecuta directo (permite probar resolveChute aparte)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = { resolveChute };