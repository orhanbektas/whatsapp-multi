const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json({ limit: '512kb' }));

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://evolution:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const GATEWAY_API_KEYS = (process.env.GATEWAY_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
const REGISTRAR_URL = process.env.REGISTRAR_URL || 'http://registrar:4001';
const REGISTRAR_INTERNAL_TOKEN = process.env.REGISTRAR_INTERNAL_TOKEN || '';
const PANEL_TOKEN = process.env.PANEL_TOKEN || '';
const PANEL_BASIC_USER = process.env.PANEL_BASIC_USER || '';
const PANEL_BASIC_PASS = process.env.PANEL_BASIC_PASS || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const PORT = Number(process.env.PORT || 4000);

if (!EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_KEY zorunludur.');
if (!GATEWAY_API_KEYS.length) throw new Error('GATEWAY_API_KEYS zorunludur.');
if (!REGISTRAR_INTERNAL_TOKEN) throw new Error('REGISTRAR_INTERNAL_TOKEN zorunludur.');
if (!PANEL_TOKEN && !(PANEL_BASIC_USER && PANEL_BASIC_PASS)) {
  throw new Error('Panel auth için PANEL_TOKEN veya PANEL_BASIC_USER/PANEL_BASIC_PASS tanımlayın.');
}

const evoClient = axios.create({
  baseURL: EVOLUTION_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: { apikey: EVOLUTION_API_KEY },
});

const registrarClient = axios.create({
  baseURL: REGISTRAR_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: { 'x-registrar-token': REGISTRAR_INTERNAL_TOKEN },
});

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

function sanitizeErrorMessage(err, fallback = 'İşlem başarısız oldu.') {
  if (err?.code === 'ECONNABORTED') return 'İşlem zaman aşımına uğradı.';
  return err?.response?.data?.error || err?.response?.data?.message || fallback;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, chunk) => {
    const [k, ...rest] = chunk.trim().split('=');
    if (!k) return acc;
    acc[k] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function parseBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const [username, ...rest] = decoded.split(':');
    return { username, password: rest.join(':') };
  } catch {
    return null;
  }
}

function isPanelAuthorized(req) {
  const cookies = parseCookies(req);
  const headerToken = req.headers['x-panel-token'];
  const bearerToken = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  const cookieToken = cookies.panel_token;

  if (PANEL_TOKEN && (headerToken === PANEL_TOKEN || bearerToken === PANEL_TOKEN || cookieToken === PANEL_TOKEN)) {
    return true;
  }

  if (PANEL_BASIC_USER && PANEL_BASIC_PASS) {
    const basic = parseBasicAuth(req);
    if (basic && basic.username === PANEL_BASIC_USER && basic.password === PANEL_BASIC_PASS) {
      return true;
    }
  }

  return false;
}

function panelAuth(req, res, next) {
  if (req.method === 'GET' && req.path === '/' && PANEL_TOKEN && req.query?.panelToken === PANEL_TOKEN) {
    res.setHeader('Set-Cookie', `panel_token=${encodeURIComponent(PANEL_TOKEN)}; Path=/; HttpOnly; SameSite=Strict`);
    return res.redirect('/');
  }

  if (isPanelAuthorized(req)) return next();

  if (PANEL_BASIC_USER && PANEL_BASIC_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Panel"');
  }

  return res.status(401).json({ error: 'Panel erişimi için yetki gerekli.' });
}

function apiAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || !GATEWAY_API_KEYS.includes(key)) {
    return res.status(401).json({ error: 'Geçersiz API key.' });
  }
  return next();
}

function createRateLimiter({ windowMs, max }) {
  const bucket = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const item = bucket.get(ip) || { count: 0, resetAt: now + windowMs };

    if (now > item.resetAt) {
      item.count = 0;
      item.resetAt = now + windowMs;
    }

    item.count += 1;
    bucket.set(ip, item);

    if (item.count > max) {
      return res.status(429).json({ error: 'Çok fazla istek. Lütfen daha sonra tekrar deneyin.' });
    }

    return next();
  };
}

function isValidInstanceName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{3,60}$/.test(name);
}

function isValidPhone(phone) {
  return typeof phone === 'string' && /^\+?[1-9]\d{7,14}$/.test(phone.trim());
}

function isValidCode(code) {
  return typeof code === 'string' && /^\d{4,8}$/.test(code.trim());
}

function isValidProxy(proxy) {
  if (proxy == null || proxy === '') return true;
  if (typeof proxy !== 'string') return false;
  if (proxy.length > 200) return false;
  if (/[;&|`$<>\\]/.test(proxy)) return false;
  if (proxy.includes('://')) {
    try {
      const u = new URL(proxy);
      return ['http:', 'https:'].includes(u.protocol) && Boolean(u.hostname) && /^\d{1,5}$/.test(u.port || '8080');
    } catch {
      return false;
    }
  }
  return /^[a-zA-Z0-9.-]+:\d{1,5}$/.test(proxy);
}

function normalizeInstances(data) {
  if (!Array.isArray(data)) return [];
  return data.map((item) => {
    const inst = item.instance || item;
    return {
      name: inst.instanceName || inst.name,
      connectionStatus: inst.status || inst.connectionStatus || 'unknown',
      ownerJid: inst.ownerJid || null,
    };
  });
}

const panelLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });
const sensitivePanelLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 15 });
const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 180 });

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', panelAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/panel/instances', panelAuth, panelLimiter, async (req, res) => {
  try {
    const r = await evoClient.get('/instance/fetchInstances');
    return res.json(normalizeInstances(r.data));
  } catch {
    return res.json([]);
  }
});

app.post('/panel/instances', panelAuth, sensitivePanelLimiter, async (req, res) => {
  const { instanceName } = req.body || {};
  if (!isValidInstanceName(instanceName)) {
    return res.status(400).json({ error: 'instanceName 3-60 karakter olmalı (harf/rakam/_/-).' });
  }

  try {
    await evoClient.post('/instance/create', {
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });
    return res.json({ success: true, instanceName });
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Instance oluşturulamadı.') });
  }
});

app.get('/panel/instances/:name/qr', panelAuth, panelLimiter, async (req, res) => {
  const { name } = req.params;
  if (!isValidInstanceName(name)) {
    return res.status(400).json({ error: 'Geçersiz instance adı.' });
  }

  try {
    const r = await evoClient.get(`/instance/connect/${encodeURIComponent(name)}`);
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'QR alınamadı.') });
  }
});

app.get('/panel/instances/:name/status', panelAuth, panelLimiter, async (req, res) => {
  const { name } = req.params;
  if (!isValidInstanceName(name)) {
    return res.status(400).json({ error: 'Geçersiz instance adı.' });
  }

  try {
    const r = await evoClient.get(`/instance/connectionState/${encodeURIComponent(name)}`);
    return res.json(r.data);
  } catch {
    return res.json({ state: 'unknown' });
  }
});

app.delete('/panel/instances/:name', panelAuth, sensitivePanelLimiter, async (req, res) => {
  const { name } = req.params;
  if (!isValidInstanceName(name)) {
    return res.status(400).json({ error: 'Geçersiz instance adı.' });
  }

  try {
    const r = await evoClient.delete(`/instance/delete/${encodeURIComponent(name)}`);
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Instance silinemedi.') });
  }
});

app.post('/panel/register/start', panelAuth, sensitivePanelLimiter, async (req, res) => {
  const { phone, proxy } = req.body || {};
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: 'Geçerli telefon numarası girin.' });
  }
  if (!isValidProxy(proxy)) {
    return res.status(400).json({ error: 'Geçersiz proxy formatı.' });
  }

  try {
    const r = await registrarClient.post('/register/start', { phone, proxy });
    return res.json(r.data);
  } catch (e) {
    const msg = sanitizeErrorMessage(e, 'Kayıt başlatılamadı.');
    const status = e.response?.status || 502;
    return res.status(status).json({ error: msg });
  }
});

app.post('/panel/register/verify', panelAuth, sensitivePanelLimiter, async (req, res) => {
  const { phone, code } = req.body || {};
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: 'Geçerli telefon numarası girin.' });
  }
  if (!isValidCode(code)) {
    return res.status(400).json({ error: 'Doğrulama kodu 4-8 haneli olmalı.' });
  }

  try {
    const r = await registrarClient.post('/register/verify', { phone, code });
    return res.json(r.data);
  } catch (e) {
    const masked = maskPhone(phone);
    console.warn(`[PANEL VERIFY] başarısız ${masked}: ${sanitizeErrorMessage(e)}`);
    const msg = sanitizeErrorMessage(e, 'Doğrulama tamamlanamadı.');
    const status = e.response?.status || 502;
    return res.status(status).json({ error: msg });
  }
});

app.get('/panel/register/sessions', panelAuth, panelLimiter, async (req, res) => {
  try {
    const r = await registrarClient.get('/register/sessions');
    return res.json(r.data);
  } catch {
    return res.json({ lock: null, sessions: [] });
  }
});

app.get('/panel/register/adb-status', panelAuth, panelLimiter, async (req, res) => {
  try {
    const r = await registrarClient.get('/adb/status');
    return res.json(r.data);
  } catch (e) {
    return res.json({ connected: false, ready: false, error: sanitizeErrorMessage(e) });
  }
});

app.use('/api', apiAuth, apiLimiter);

app.get('/api/instances', async (req, res) => {
  try {
    const r = await evoClient.get('/instance/fetchInstances');
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Instance listesi alınamadı.') });
  }
});

app.get('/api/instances/:name/status', async (req, res) => {
  const { name } = req.params;
  if (!isValidInstanceName(name)) return res.status(400).json({ error: 'Geçersiz instance adı.' });

  try {
    const r = await evoClient.get(`/instance/connectionState/${encodeURIComponent(name)}`);
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Durum alınamadı.') });
  }
});

app.get('/api/instances/:name/qr', async (req, res) => {
  const { name } = req.params;
  if (!isValidInstanceName(name)) return res.status(400).json({ error: 'Geçersiz instance adı.' });

  try {
    const r = await evoClient.get(`/instance/connect/${encodeURIComponent(name)}`);
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'QR alınamadı.') });
  }
});

app.delete('/api/instances/:name', async (req, res) => {
  const { name } = req.params;
  if (!isValidInstanceName(name)) return res.status(400).json({ error: 'Geçersiz instance adı.' });

  try {
    const r = await evoClient.delete(`/instance/delete/${encodeURIComponent(name)}`);
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Instance silinemedi.') });
  }
});

app.post('/api/onboard', async (req, res) => {
  const { instanceName, label } = req.body || {};
  if (!isValidInstanceName(instanceName)) {
    return res.status(400).json({ error: 'Geçerli instanceName girin.' });
  }

  try {
    await evoClient.post('/instance/create', {
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });

    let qrData = null;
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const qr = await evoClient.get(`/instance/connect/${encodeURIComponent(instanceName)}`);
        if (qr.data?.base64 || qr.data?.code) {
          qrData = qr.data;
          break;
        }
      } catch {}
    }

    return res.json({
      success: true,
      instanceName,
      label: typeof label === 'string' && label.trim() ? label.trim() : instanceName,
      qr: qrData,
      panelUrl: 'http://localhost:4000',
      message: qrData ? 'QR hazır, panelden tarayın.' : 'Instance oluşturuldu, panelden QR alın.',
    });
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Onboard işlemi başarısız oldu.') });
  }
});

app.post('/api/send/text', async (req, res) => {
  const { instanceName, to, message } = req.body || {};
  if (!isValidInstanceName(instanceName) || !isValidPhone(String(to || '')) || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'instanceName, to ve message alanları geçerli olmalıdır.' });
  }

  try {
    const r = await evoClient.post(`/message/sendText/${encodeURIComponent(instanceName)}`, {
      number: to,
      text: message,
    });
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Mesaj gönderilemedi.') });
  }
});

app.post('/api/send/media', async (req, res) => {
  const { instanceName, to, mediatype, url, caption } = req.body || {};
  if (
    !isValidInstanceName(instanceName)
    || !isValidPhone(String(to || ''))
    || typeof mediatype !== 'string'
    || typeof url !== 'string'
    || !/^https?:\/\//.test(url)
  ) {
    return res.status(400).json({ error: 'Geçersiz media payload.' });
  }

  try {
    const r = await evoClient.post(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
      number: to,
      mediatype,
      media: url,
      caption: typeof caption === 'string' ? caption : '',
    });
    return res.json(r.data);
  } catch (e) {
    return res.status(502).json({ error: sanitizeErrorMessage(e, 'Media gönderilemedi.') });
  }
});

app.post('/api/send/bulk', async (req, res) => {
  const { instanceName, messages } = req.body || {};
  if (!isValidInstanceName(instanceName) || !Array.isArray(messages) || messages.length < 1 || messages.length > 100) {
    return res.status(400).json({ error: 'Geçerli instanceName ve 1-100 arası messages zorunlu.' });
  }

  const invalid = messages.some((msg) => !isValidPhone(String(msg?.to || '')) || typeof msg?.message !== 'string' || !msg.message.trim());
  if (invalid) return res.status(400).json({ error: 'messages içindeki to/message alanları geçersiz.' });

  const results = [];
  for (const msg of messages) {
    try {
      const r = await evoClient.post(`/message/sendText/${encodeURIComponent(instanceName)}`, {
        number: msg.to,
        text: msg.message,
      });
      results.push({ to: msg.to, status: 'ok', data: r.data });
    } catch (e) {
      results.push({ to: msg.to, status: 'error', error: sanitizeErrorMessage(e, 'Gönderim hatası') });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return res.json(results);
});

app.listen(PORT, () => {
  console.log(`WhatsApp Manager :${PORT} hazır`);
});
