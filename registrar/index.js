/**
 * WhatsApp Registrar — BlueStacks ADB Otomasyon
 */

const express = require('express');
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parsePhoneNumber } = require('libphonenumber-js');

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json({ limit: '256kb' }));

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://evolution:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const REGISTRAR_INTERNAL_TOKEN = process.env.REGISTRAR_INTERNAL_TOKEN || '';
const PORT = Number(process.env.PORT || 4001);
const ADB_HOST = process.env.ADB_HOST || 'host.docker.internal';
const ADB_PORT = String(process.env.ADB_PORT || '5555');
const WA_PACKAGE = process.env.WA_PACKAGE || 'com.whatsapp';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const SESSION_TTL_MS = Number(process.env.REGISTRATION_SESSION_TTL_MS || 15 * 60 * 1000);

if (!EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_KEY zorunludur.');
if (!REGISTRAR_INTERNAL_TOKEN) throw new Error('REGISTRAR_INTERNAL_TOKEN zorunludur.');
if (!/^\d{2,5}$/.test(ADB_PORT)) throw new Error('ADB_PORT geçerli sayısal port olmalıdır.');
if (!/^[a-zA-Z0-9_.]+$/.test(WA_PACKAGE)) throw new Error('WA_PACKAGE geçersiz karakter içeriyor.');

const DEVICE = `${ADB_HOST}:${ADB_PORT}`;
const sessions = {};
let deviceLock = null;

const evoClient = axios.create({
  baseURL: EVOLUTION_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: { apikey: EVOLUTION_API_KEY },
});

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function sanitizeErrorMessage(err, fallback = 'İşlem başarısız oldu.') {
  if (err?.code === 'ECONNABORTED') return 'İşlem zaman aşımına uğradı.';
  return err?.response?.data?.error || err?.response?.data?.message || err?.message || fallback;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

function hasShellMetaChars(input) {
  return /[;&|`$<>\\]/.test(String(input || ''));
}

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  if (/\s/.test(host)) return false;
  const hostRegex = /^(localhost|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+)$/;
  return hostRegex.test(host);
}

function parseProxyInput(proxyStr) {
  if (!proxyStr) return null;
  if (typeof proxyStr !== 'string') return { error: 'proxy metin olmalıdır.' };
  const raw = proxyStr.trim();
  if (!raw) return null;
  if (raw.length > 200) return { error: 'proxy çok uzun.' };
  if (hasShellMetaChars(raw)) return { error: 'proxy geçersiz karakter içeriyor.' };

  let host;
  let port;

  if (raw.includes('://')) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { error: 'proxy URL formatı geçersiz.' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'proxy protokolü yalnızca http/https olabilir.' };
    }
    host = parsed.hostname;
    port = parsed.port || '8080';
  } else {
    const parts = raw.split(':');
    if (parts.length !== 2) return { error: 'proxy formatı host:port olmalıdır.' };
    [host, port] = parts;
  }

  if (!isValidHost(host)) return { error: 'proxy host geçersiz.' };
  if (!/^\d+$/.test(String(port))) return { error: 'proxy port sayısal olmalıdır.' };

  const numericPort = Number(port);
  if (numericPort < 1 || numericPort > 65535) return { error: 'proxy port 1-65535 aralığında olmalıdır.' };

  return { host, port: String(numericPort) };
}

async function runCommand(bin, args, timeout = REQUEST_TIMEOUT_MS) {
  const { stdout } = await execFileAsync(bin, args, {
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout || '').trim();
}

async function adb(args, timeout = REQUEST_TIMEOUT_MS) {
  if (!Array.isArray(args)) throw new Error('ADB komutu argüman listesi olmalıdır.');
  return runCommand('adb', ['-s', DEVICE, ...args], timeout);
}

async function adbShell(args, timeout = REQUEST_TIMEOUT_MS) {
  if (!Array.isArray(args)) throw new Error('ADB shell komutu argüman listesi olmalıdır.');
  return adb(['shell', ...args], timeout);
}

async function adbConnect() {
  try {
    const stdout = await runCommand('adb', ['connect', DEVICE], 10000);
    return /connected|already connected/i.test(stdout);
  } catch {
    return false;
  }
}

async function deviceReady() {
  try {
    const out = await adb(['get-state']);
    return out.trim() === 'device';
  } catch {
    return false;
  }
}

function parsePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const normalizedInput = phone.trim();
  if (!/^\+?[1-9]\d{7,14}$/.test(normalizedInput)) return null;

  const withPlus = normalizedInput.startsWith('+') ? normalizedInput : `+${normalizedInput}`;
  try {
    const parsed = parsePhoneNumber(withPlus);
    if (!parsed || !parsed.isValid()) return null;
    return {
      normalPhone: parsed.number.replace('+', ''),
      countryCode: String(parsed.countryCallingCode),
      nationalNumber: String(parsed.nationalNumber),
    };
  } catch {
    return null;
  }
}

function isValidCode(code) {
  return typeof code === 'string' && /^\d{4,8}$/.test(code.trim());
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

    next();
  };
}

function getSession(phone) {
  const s = sessions[phone];
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    delete sessions[phone];
    if (deviceLock?.phone === phone) deviceLock = null;
    return null;
  }
  return s;
}

function setSession(phone, patch) {
  sessions[phone] = { ...sessions[phone], ...patch, updatedAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
}

function finalizeSession(phone, state) {
  const s = sessions[phone];
  if (!s) return;
  s.state = state;
  s.updatedAt = Date.now();
  s.expiresAt = Date.now() + 60 * 1000;
}

function acquireLock(phone, phase) {
  if (deviceLock && deviceLock.phone !== phone) {
    return false;
  }
  deviceLock = {
    phone,
    phase,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  return true;
}

function refreshLock(phone, phase) {
  if (!deviceLock || deviceLock.phone !== phone) return;
  deviceLock.phase = phase;
  deviceLock.expiresAt = Date.now() + SESSION_TTL_MS;
}

function releaseLock(phone) {
  if (deviceLock?.phone === phone) {
    deviceLock = null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of Object.entries(sessions)) {
    if (now > session.expiresAt) {
      delete sessions[phone];
      if (deviceLock?.phone === phone) deviceLock = null;
    }
  }
  if (deviceLock && now > deviceLock.expiresAt) deviceLock = null;
}, 15000);

async function getUiXml() {
  try {
    await adbShell(['uiautomator', 'dump', '/sdcard/ui.xml']);
    await sleep(300);
    return adbShell(['cat', '/sdcard/ui.xml']);
  } catch {
    return '';
  }
}

function findCenter(xml, searches) {
  for (const [attr, val] of Object.entries(searches)) {
    const esc = String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re1 = new RegExp(`${attr}="${esc}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
    const m1 = xml.match(re1);
    if (m1) return center(m1);

    const re2 = new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*${attr}="${esc}"`, 'i');
    const m2 = xml.match(re2);
    if (m2) return center(m2);
  }
  return null;
}

function center(m) {
  return {
    x: Math.floor((parseInt(m[1], 10) + parseInt(m[3], 10)) / 2),
    y: Math.floor((parseInt(m[2], 10) + parseInt(m[4], 10)) / 2),
  };
}

async function tapIf(searches) {
  const xml = await getUiXml();
  const pos = findCenter(xml, searches);
  if (!pos) return false;
  await adbShell(['input', 'tap', String(pos.x), String(pos.y)]);
  await sleep(800);
  return true;
}

async function waitFor(searches, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const xml = await getUiXml();
    if (findCenter(xml, searches)) return true;
    await sleep(2000);
  }
  return false;
}

async function resetAndLaunchWhatsApp() {
  await adbShell(['am', 'force-stop', WA_PACKAGE]).catch(() => {});
  await sleep(500);
  await adbShell(['pm', 'clear', WA_PACKAGE]).catch(() => {});
  await sleep(1000);
  await adbShell(['monkey', '-p', WA_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1']);
  await sleep(4000);
}

async function dismissWelcomeScreens() {
  const buttons = [
    { text: 'Kabul et ve devam et' },
    { text: 'KABUL ET VE DEVAM ET' },
    { text: 'Kabul et' },
    { text: 'Devam et' },
    { text: 'Tamam' },
    { text: 'İzin ver' },
    { text: 'AGREE AND CONTINUE' }, { text: 'Agree and continue' },
    { text: 'AGREE' }, { text: 'Agree' },
    { text: 'Continue' }, { text: 'CONTINUE' },
    { text: 'OK' }, { text: 'Allow' },
  ];
  for (let i = 0; i < 8; i += 1) {
    let clicked = false;
    for (const b of buttons) {
      if (await tapIf(b)) { clicked = true; await sleep(2000); break; }
    }
    if (!clicked) break;
  }
}

async function clearCurrentField(maxChars = 30) {
  await adbShell(['input', 'keyevent', 'KEYCODE_MOVE_END']);
  await sleep(100);
  for (let i = 0; i < maxChars; i += 1) {
    await adbShell(['input', 'keyevent', 'KEYCODE_DEL']);
    await sleep(20);
  }
}

async function selectCountryFromPicker(callingCode) {
  const opened = await tapIf({ 'resource-id': `${WA_PACKAGE}:id/registration_country` });
  if (!opened) return false;

  await sleep(1500);

  const searchByAttr =
    await tapIf({ 'content-desc': 'Ara' })
    || await tapIf({ 'content-desc': 'Search' })
    || await tapIf({ 'resource-id': `${WA_PACKAGE}:id/search_menu_item` })
    || await tapIf({ 'resource-id': `${WA_PACKAGE}:id/menu_search` });

  if (!searchByAttr) {
    try {
      const sizeOut = await adbShell(['wm', 'size']);
      const m = sizeOut.match(/(\d+)x(\d+)/);
      if (m) {
        const sx = Math.floor(parseInt(m[1], 10) * 0.95);
        const sy = Math.floor(parseInt(m[2], 10) * 0.04);
        await adbShell(['input', 'tap', String(sx), String(sy)]);
      }
    } catch {}
  }

  await sleep(800);

  await tapIf({ 'resource-id': `${WA_PACKAGE}:id/search_src_text` })
    || await tapIf({ hint: 'Search' })
    || await tapIf({ hint: 'Ara' });

  await sleep(400);
  await clearCurrentField(10);
  await adbShell(['input', 'text', callingCode]);
  await sleep(1500);

  const xml = await getUiXml();
  const pos = findCenter(xml, { text: `+${callingCode}` }) || findCenter(xml, { text: callingCode });
  if (pos) {
    await adbShell(['input', 'tap', String(pos.x), String(pos.y)]);
    await sleep(1000);
    return true;
  }

  await adbShell(['input', 'keyevent', 'KEYCODE_ENTER']);
  await sleep(1000);
  return true;
}

async function enterPhoneNumber(countryCode, nationalNumber) {
  await selectCountryFromPicker(countryCode);

  await tapIf({ 'resource-id': `${WA_PACKAGE}:id/registration_phone` })
    || await tapIf({ hint: 'Telefon numarası' })
    || await tapIf({ hint: 'Phone number' });
  await sleep(400);

  await clearCurrentField(20);

  for (const digit of nationalNumber) {
    await adbShell(['input', 'text', digit]);
    await sleep(80);
  }
  await sleep(300);
}

async function clickNext() {
  return tapIf({ 'resource-id': `${WA_PACKAGE}:id/registration_submit` })
    || tapIf({ text: 'İleri' }) || tapIf({ text: 'Sonraki' })
    || tapIf({ text: 'Next' }) || tapIf({ text: 'NEXT' })
    || tapIf({ text: 'Done' }) || tapIf({ text: 'DONE' })
    || tapIf({ 'content-desc': 'Next' }) || tapIf({ 'content-desc': 'İleri' });
}

async function confirmPhoneNumber() {
  await sleep(2000);
  await tapIf({ text: 'Tamam' }) || await tapIf({ text: 'Evet' })
    || await tapIf({ text: 'OK' }) || await tapIf({ text: 'Yes' })
    || await tapIf({ text: 'Continue' }) || await tapIf({ text: 'Devam et' });
}

async function enterSmsCode(code) {
  const digits = code.replace(/\D/g, '');
  const found = await tapIf({ 'resource-id': `${WA_PACKAGE}:id/verify_sms_code_input` })
    || await tapIf({ hint: 'Enter code' })
    || await tapIf({ class: 'android.widget.EditText' });

  await sleep(300);
  for (const d of digits) {
    await adbShell(['input', 'text', d]);
    await sleep(200);
  }
  return found;
}

async function waitForHomeScreen(timeoutMs = 90000) {
  return waitFor({ text: 'Chats' }, timeoutMs) || waitFor({ 'resource-id': `${WA_PACKAGE}:id/home_tab_layout` }, timeoutMs);
}

async function skipProfileSetup() {
  for (const t of [{ text: 'Skip' }, { text: 'Not now' }, { text: 'Later' }]) {
    await tapIf(t);
    await sleep(1000);
  }
}

async function linkWithPairingCode(pairingCode) {
  await tapIf({ 'content-desc': 'More options' }) || await tapIf({ 'content-desc': 'Menu' });
  await sleep(1000);
  await tapIf({ text: 'Settings' }) || await tapIf({ text: 'SETTINGS' });
  await sleep(1500);

  await tapIf({ text: 'Linked devices' }) || await tapIf({ text: 'Linked Devices' });
  await sleep(1500);

  await tapIf({ text: 'Link a device' }) || await tapIf({ text: 'LINK A DEVICE' });
  await sleep(2000);

  await tapIf({ text: 'Link with phone number' }) || await tapIf({ text: 'Use phone number instead' });
  await sleep(2000);

  await tapIf({ class: 'android.widget.EditText' });
  await sleep(300);

  const clean = String(pairingCode || '').replace(/[^A-Z0-9]/gi, '');
  await adbShell(['input', 'text', clean]);
  await sleep(500);

  await tapIf({ text: 'Link' }) || await tapIf({ text: 'OK' }) || await tapIf({ text: 'Connect' });
  await sleep(3000);
}

async function setAndroidProxy(proxyConfig) {
  if (!proxyConfig) return;
  await adbShell(['settings', 'put', 'global', 'http_proxy', `${proxyConfig.host}:${proxyConfig.port}`]);
}

async function clearAndroidProxy() {
  try {
    await adbShell(['settings', 'put', 'global', 'http_proxy', ':0']);
  } catch {}
}

function requireInternalAuth(req, res, next) {
  if (req.path === '/health') return next();
  const token = req.headers['x-registrar-token'];
  if (!token || token !== REGISTRAR_INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Yetkisiz erişim.' });
  }
  return next();
}

app.use(requireInternalAuth);

const registerLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 12 });
app.use('/register/start', registerLimiter);
app.use('/register/verify', registerLimiter);

app.post('/register/start', async (req, res) => {
  const { phone, proxy } = req.body || {};

  const parsedPhone = parsePhone(phone);
  if (!parsedPhone) {
    return res.status(400).json({ error: 'Geçerli bir telefon numarası girin (örn: +905321234567).' });
  }

  const proxyConfig = parseProxyInput(proxy);
  if (proxyConfig?.error) {
    return res.status(400).json({ error: proxyConfig.error });
  }

  const { normalPhone, countryCode, nationalNumber } = parsedPhone;
  const maskedPhone = maskPhone(normalPhone);
  const instanceName = `wa_${normalPhone}`;

  const activeSession = getSession(normalPhone);
  if (activeSession && ['starting', 'sms_sent', 'verifying'].includes(activeSession.state)) {
    return res.status(409).json({ error: 'Bu numara için zaten aktif bir kayıt oturumu var.' });
  }

  if (!acquireLock(normalPhone, 'start')) {
    return res.status(423).json({ error: 'Cihaz şu anda başka bir kayıt işlemiyle meşgul.' });
  }

  setSession(normalPhone, {
    state: 'starting',
    countryCode,
    nationalNumber,
    instanceName,
    proxyApplied: Boolean(proxyConfig),
  });

  try {
    const connected = await adbConnect();
    if (!connected || !(await deviceReady())) {
      finalizeSession(normalPhone, 'failed');
      releaseLock(normalPhone);
      return res.status(503).json({
        error: 'BlueStacks ADB bağlantısı kurulamadı.',
        hint: 'BlueStacks açık mı ve ADB etkin mi kontrol edin.',
      });
    }

    if (proxyConfig) await setAndroidProxy(proxyConfig);

    await resetAndLaunchWhatsApp();
    await dismissWelcomeScreens();
    await sleep(1000);
    await enterPhoneNumber(countryCode, nationalNumber);
    await clickNext();
    await confirmPhoneNumber();

    setSession(normalPhone, { state: 'sms_sent' });
    refreshLock(normalPhone, 'sms_sent');

    console.log(`[KAYIT] SMS gönderildi: ${maskedPhone}`);

    return res.json({
      success: true,
      phone: normalPhone,
      instanceName,
      message: 'WhatsApp başlatıldı, SMS kodu gönderildi. Kodu girin.',
    });
  } catch (err) {
    console.error(`[KAYIT HATA] ${maskedPhone}: ${sanitizeErrorMessage(err)}`);
    await clearAndroidProxy();
    finalizeSession(normalPhone, 'failed');
    delete sessions[normalPhone];
    releaseLock(normalPhone);
    return res.status(500).json({ error: 'Kayıt başlatılamadı.' });
  }
});

app.post('/register/verify', async (req, res) => {
  const { phone, code } = req.body || {};

  const parsedPhone = parsePhone(phone);
  if (!parsedPhone) {
    return res.status(400).json({ error: 'Geçerli bir telefon numarası girin.' });
  }
  if (!isValidCode(String(code || ''))) {
    return res.status(400).json({ error: 'Doğrulama kodu 4-8 haneli olmalıdır.' });
  }

  const { normalPhone } = parsedPhone;
  const maskedPhone = maskPhone(normalPhone);
  const session = getSession(normalPhone);

  if (!session) {
    return res.status(404).json({ error: 'Aktif oturum yok. Önce /register/start çağırın.' });
  }

  if (!deviceLock || deviceLock.phone !== normalPhone) {
    return res.status(423).json({ error: 'Cihaz bu oturuma ait değil veya oturum süresi doldu.' });
  }

  let success = false;
  let pairingCode = null;

  try {
    setSession(normalPhone, { state: 'verifying' });
    refreshLock(normalPhone, 'verifying');

    await enterSmsCode(String(code));

    const registered = await waitForHomeScreen(90000);
    if (!registered) {
      return res.status(400).json({ error: 'WhatsApp kaydı tamamlanamadı. Kod yanlış veya süresi dolmuş olabilir.' });
    }

    await skipProfileSetup();

    try {
      await evoClient.post('/instance/create', {
        instanceName: session.instanceName,
        qrcode: false,
        integration: 'WHATSAPP-BAILEYS',
      });

      await sleep(2000);

      const connectRes = await evoClient.get(`/instance/connect/${session.instanceName}`);
      pairingCode = connectRes.data?.pairingCode || connectRes.data?.code || null;
    } catch (evoErr) {
      console.warn(`[EVO] ${sanitizeErrorMessage(evoErr, 'Evolution bağlantı hatası')}`);
    }

    if (pairingCode) {
      await linkWithPairingCode(pairingCode);
      setSession(normalPhone, { state: 'linked' });
    } else {
      setSession(normalPhone, { state: 'registered' });
    }

    success = true;

    return res.json({
      success: true,
      instanceName: session.instanceName,
      phone: normalPhone,
      pairingCode,
      message: pairingCode
        ? `Tamamlandı! "${session.instanceName}" Evolution panelinde aktif.`
        : 'WhatsApp kaydedildi. Evolution panelinden manuel QR ile bağlayın.',
    });
  } catch (err) {
    console.error(`[KAYIT VERIFY HATA] ${maskedPhone}: ${sanitizeErrorMessage(err)}`);
    return res.status(500).json({ error: 'Doğrulama tamamlanamadı.' });
  } finally {
    await clearAndroidProxy();
    finalizeSession(normalPhone, success ? 'completed' : 'failed');
    delete sessions[normalPhone];
    releaseLock(normalPhone);
  }
});

app.get('/adb/status', async (req, res) => {
  try {
    const connected = await adbConnect();
    const ready = connected && await deviceReady();
    let devices = '';
    try { devices = await runCommand('adb', ['devices'], 10000); } catch {}

    return res.json({ connected, ready, device: DEVICE, devices });
  } catch (e) {
    return res.json({ connected: false, ready: false, error: sanitizeErrorMessage(e) });
  }
});

app.get('/register/sessions', (req, res) => {
  const now = Date.now();
  const out = Object.entries(sessions).map(([phone, s]) => ({
    phone,
    instanceName: s.instanceName,
    state: s.state,
    expiresInMs: Math.max(0, s.expiresAt - now),
  }));
  res.json({
    lock: deviceLock ? { phone: deviceLock.phone, phase: deviceLock.phase, expiresInMs: Math.max(0, deviceLock.expiresAt - now) } : null,
    sessions: out,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', device: DEVICE }));

app.listen(PORT, () => {
  console.log(`Registrar (ADB) :${PORT} | BlueStacks hedef: ${DEVICE}`);
});
