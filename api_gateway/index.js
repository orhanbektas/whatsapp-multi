const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://evolution:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const GATEWAY_API_KEYS = (process.env.GATEWAY_API_KEYS || '').split(',').map(k => k.trim());
const REGISTRAR_URL = process.env.REGISTRAR_URL || 'http://registrar:4001';
const PORT = process.env.PORT || 4000;

function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || !GATEWAY_API_KEYS.includes(key)) {
    return res.status(401).json({ error: 'Geçersiz API key' });
  }
  next();
}

function evo(p) { return `${EVOLUTION_URL}${p}`; }
function evoHeaders() { return { apikey: EVOLUTION_API_KEY }; }

// ── Admin paneli ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// v1 API'den gelen { instance: { instanceName, status } } yapısını düzleştir
function normalizeInstances(data) {
  if (!Array.isArray(data)) return [];
  return data.map(item => {
    const inst = item.instance || item;
    return {
      name: inst.instanceName || inst.name,
      connectionStatus: inst.status || inst.connectionStatus || 'unknown',
      ownerJid: inst.ownerJid || null,
    };
  });
}

// ── Panel endpoint'leri (auth olmadan, internal) ──
app.get('/panel/instances', async (req, res) => {
  try {
    const r = await axios.get(evo('/instance/fetchInstances'), { headers: evoHeaders() });
    res.json(normalizeInstances(r.data));
  } catch (e) { res.json([]); }
});

app.post('/panel/instances', async (req, res) => {
  const { instanceName } = req.body;
  if (!instanceName) return res.status(400).json({ error: 'instanceName zorunlu' });
  try {
    await axios.post(evo('/instance/create'), {
      instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
    }, { headers: evoHeaders() });
    res.json({ success: true, instanceName });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/panel/instances/:name/qr', async (req, res) => {
  try {
    const r = await axios.get(evo(`/instance/connect/${req.params.name}`), { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/panel/instances/:name/status', async (req, res) => {
  try {
    const r = await axios.get(evo(`/instance/connectionState/${req.params.name}`), { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.json({ state: 'unknown' }); }
});

app.delete('/panel/instances/:name', async (req, res) => {
  try {
    const r = await axios.delete(evo(`/instance/delete/${req.params.name}`), { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API endpoint'leri (x-api-key zorunlu) ──
app.get('/api/instances', auth, async (req, res) => {
  try {
    const r = await axios.get(evo('/instance/fetchInstances'), { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/instances/:name/status', auth, async (req, res) => {
  try {
    const r = await axios.get(evo(`/instance/connectionState/${req.params.name}`), { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/instances/:name/qr', auth, async (req, res) => {
  try {
    const r = await axios.get(evo(`/instance/connect/${req.params.name}`), { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/instances/:name', auth, async (req, res) => {
  try {
    const r = await axios.delete(evo(`/instance/delete/${req.params.name}`), { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Onboard: tek çağrıyla numara ekle ──
app.post('/api/onboard', auth, async (req, res) => {
  const { instanceName, label } = req.body;
  if (!instanceName) return res.status(400).json({ error: 'instanceName zorunlu' });
  try {
    await axios.post(evo('/instance/create'), {
      instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
    }, { headers: evoHeaders() });

    let qrData = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const qr = await axios.get(evo(`/instance/connect/${instanceName}`), { headers: evoHeaders() });
        if (qr.data?.base64 || qr.data?.code) { qrData = qr.data; break; }
      } catch (_) {}
    }

    res.json({
      success: true, instanceName, label: label || instanceName, qr: qrData,
      panelUrl: `http://localhost:4000`,
      message: qrData ? 'QR hazır, panel\'den tarayın.' : 'Instance oluşturuldu, panel\'den QR alın.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

// ── Mesaj gönderimi ──
app.post('/api/send/text', auth, async (req, res) => {
  const { instanceName, to, message } = req.body;
  try {
    const r = await axios.post(evo(`/message/sendText/${instanceName}`), {
      number: to, text: message
    }, { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message, detail: e.response?.data }); }
});

app.post('/api/send/media', auth, async (req, res) => {
  const { instanceName, to, mediatype, url, caption } = req.body;
  try {
    const r = await axios.post(evo(`/message/sendMedia/${instanceName}`), {
      number: to, mediatype, media: url, caption
    }, { headers: evoHeaders() });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message, detail: e.response?.data }); }
});

app.post('/api/send/bulk', auth, async (req, res) => {
  const { instanceName, messages } = req.body;
  const results = [];
  for (const msg of messages) {
    try {
      const r = await axios.post(evo(`/message/sendText/${instanceName}`), {
        number: msg.to, text: msg.message
      }, { headers: evoHeaders() });
      results.push({ to: msg.to, status: 'ok', data: r.data });
    } catch (e) {
      results.push({ to: msg.to, status: 'error', error: e.message });
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  res.json(results);
});

// ── Kayıt (Registrar) proxy endpoint'leri ──
// Yeni numara kaydı: SMS doğrulama ile sıfırdan WhatsApp kurulumu

app.post('/panel/register/start', async (req, res) => {
  try {
    const r = await axios.post(`${REGISTRAR_URL}/register/start`, req.body);
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

app.post('/panel/register/verify', async (req, res) => {
  try {
    const r = await axios.post(`${REGISTRAR_URL}/register/verify`, req.body);
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: e.message });
  }
});

app.get('/panel/register/sessions', async (req, res) => {
  try {
    const r = await axios.get(`${REGISTRAR_URL}/register/sessions`);
    res.json(r.data);
  } catch (e) {
    res.json([]);
  }
});

app.get('/panel/register/adb-status', async (req, res) => {
  try {
    const r = await axios.get(`${REGISTRAR_URL}/adb/status`);
    res.json(r.data);
  } catch (e) {
    res.json({ connected: false, ready: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`WhatsApp Manager :${PORT} hazır`));
