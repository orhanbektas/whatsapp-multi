/**
 * WhatsApp Registrar — BlueStacks ADB Otomasyon
 *
 * Akış:
 *  1. POST /register/start  → BlueStacks'te WhatsApp açılır, numara girilir, SMS gönderilir
 *  2. POST /register/verify → SMS kodu girilir, kayıt tamamlanır,
 *                             Evolution API instance oluşturulur + pairing code ile bağlanır
 */

const express = require('express');
const axios   = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const { parsePhoneNumber } = require('libphonenumber-js');

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

const EVOLUTION_URL     = process.env.EVOLUTION_URL     || 'http://evolution:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const PORT              = process.env.PORT              || 4001;
const ADB_HOST          = process.env.ADB_HOST          || 'host.docker.internal';
const ADB_PORT          = process.env.ADB_PORT          || '5555';
const DEVICE            = `${ADB_HOST}:${ADB_PORT}`;
// 'com.whatsapp' → normal | 'com.whatsapp.w4b' → WhatsApp Business
const WA_PACKAGE        = process.env.WA_PACKAGE || 'com.whatsapp';

// Aktif oturumlar: normalPhone → { state, countryCode, nationalNumber, instanceName }
const sessions = {};

// ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function adb(cmd) {
  const { stdout } = await execAsync(`adb -s ${DEVICE} ${cmd}`, { timeout: 30000 });
  return stdout.trim();
}

async function adbShell(cmd) {
  return adb(`shell ${cmd}`);
}

/** BlueStacks'e bağlan, true/false döner */
async function adbConnect() {
  try {
    const { stdout } = await execAsync(`adb connect ${DEVICE}`, { timeout: 10000 });
    return stdout.includes('connected');
  } catch { return false; }
}

/** Cihazın erişilebilir olduğunu doğrula */
async function deviceReady() {
  try {
    const out = await adb('get-state');
    return out.trim() === 'device';
  } catch { return false; }
}

// ── UIAutomator yardımcıları ──────────────────────────────────────────────────

/** Ekran XML'ini çek */
async function getUiXml() {
  try {
    await adbShell('uiautomator dump /sdcard/ui.xml');
    await sleep(300);
    return adbShell('cat /sdcard/ui.xml');
  } catch { return ''; }
}

/**
 * XML içinde text / content-desc / resource-id ile element bul,
 * bounds orta noktasını döndür: { x, y } veya null
 */
function findCenter(xml, searches) {
  for (const [attr, val] of Object.entries(searches)) {
    const esc = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Önce: attribute="value" ... bounds="[x1,y1][x2,y2]"
    const re1 = new RegExp(`${attr}="${esc}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
    const m1  = xml.match(re1);
    if (m1) return center(m1);

    // Sonra: bounds önce gelip attribute sonra gelebilir (farklı sıra)
    const re2 = new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*${attr}="${esc}"`, 'i');
    const m2  = xml.match(re2);
    if (m2) return center(m2);
  }
  return null;
}

function center(m) {
  return {
    x: Math.floor((parseInt(m[1]) + parseInt(m[3])) / 2),
    y: Math.floor((parseInt(m[2]) + parseInt(m[4])) / 2),
  };
}

/** Element varsa tıkla, yoksa false döndür */
async function tapIf(searches) {
  const xml = await getUiXml();
  const pos  = findCenter(xml, searches);
  if (!pos) return false;
  await adbShell(`input tap ${pos.x} ${pos.y}`);
  await sleep(800);
  return true;
}

/** Element çıkana kadar bekle (max timeoutMs) */
async function waitFor(searches, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const xml = await getUiXml();
    if (findCenter(xml, searches)) return true;
    await sleep(2000);
  }
  return false;
}

/** Ekranda belirtilen metin var mı? */
async function screenContains(text) {
  const xml = await getUiXml();
  return xml.toLowerCase().includes(text.toLowerCase());
}

// ── WhatsApp otomasyon adımları ───────────────────────────────────────────────

/** WhatsApp'ı sıfırla ve başlat */
async function resetAndLaunchWhatsApp() {
  await adbShell(`am force-stop ${WA_PACKAGE}`).catch(() => {});
  await sleep(500);
  // Hata olursa (paket yüklü değil gibi) devam et
  await adbShell(`pm clear ${WA_PACKAGE}`).catch(() => {});
  await sleep(1000);
  await adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1`);
  await sleep(4000);
}

/** Karşılama ekranlarını geç (Türkçe + İngilizce) */
async function dismissWelcomeScreens() {
  const buttons = [
    // Türkçe
    { text: 'Kabul et ve devam et' },
    { text: 'KABUL ET VE DEVAM ET' },
    { text: 'Kabul et' },
    { text: 'Devam et' },
    { text: 'Tamam' },
    { text: 'İzin ver' },
    // İngilizce
    { text: 'AGREE AND CONTINUE' }, { text: 'Agree and continue' },
    { text: 'AGREE' }, { text: 'Agree' },
    { text: 'Continue' }, { text: 'CONTINUE' },
    { text: 'OK' }, { text: 'Allow' },
  ];
  for (let i = 0; i < 8; i++) {
    let clicked = false;
    for (const b of buttons) {
      if (await tapIf(b)) { clicked = true; await sleep(2000); break; }
    }
    if (!clicked) break;
  }
}

/** Odaklanmış text alanını güvenilir şekilde temizle (CTRL+A adb'de güvenilir değil) */
async function clearCurrentField(maxChars = 30) {
  await adbShell('input keyevent KEYCODE_MOVE_END');
  await sleep(100);
  for (let i = 0; i < maxChars; i++) {
    await adbShell('input keyevent KEYCODE_DEL');
    await sleep(20);
  }
}

/**
 * Ülke seçici picker'ı açar, calling code ile arar ve ilk sonucu seçer.
 * Örn: callingCode="27" → South Africa / Güney Afrika
 */
async function selectCountryFromPicker(callingCode) {
  const opened = await tapIf({ 'resource-id': `${WA_PACKAGE}:id/registration_country` });
  if (!opened) {
    console.warn('[ADB] registration_country bulunamadı, ülke seçimi atlanıyor');
    return false;
  }
  await sleep(1500);

  // Sağ üstteki arama ikonuna tıkla — önce content-desc ile dene,
  // bulunamazsa ekran boyutuna göre koordinat hesapla
  const searchByAttr =
    await tapIf({ 'content-desc': 'Ara' })
    || await tapIf({ 'content-desc': 'Search' })
    || await tapIf({ 'resource-id': `${WA_PACKAGE}:id/search_menu_item` })
    || await tapIf({ 'resource-id': `${WA_PACKAGE}:id/menu_search` });

  if (!searchByAttr) {
    // Koordinat yedek: ekran genişliğinin %95, yüksekliğin %4 (sağ üst köşe)
    try {
      const sizeOut = await adbShell('wm size');
      const m = sizeOut.match(/(\d+)x(\d+)/);
      if (m) {
        const sx = Math.floor(parseInt(m[1]) * 0.95);
        const sy = Math.floor(parseInt(m[2]) * 0.04);
        console.log(`[ADB] Arama ikonu koordinatla tıklanıyor: (${sx}, ${sy})`);
        await adbShell(`input tap ${sx} ${sy}`);
      }
    } catch (e) {
      console.warn('[ADB] Ekran boyutu alınamadı:', e.message);
    }
  }
  await sleep(800);

  // Arama alanını odakla (bazı sürümlerde otomatik açılır)
  await tapIf({ 'resource-id': `${WA_PACKAGE}:id/search_src_text` })
    || await tapIf({ hint: 'Search' })
    || await tapIf({ hint: 'Ara' });

  await sleep(400);
  await clearCurrentField(10);
  await adbShell(`input text "${callingCode}"`);
  await sleep(1500);

  // Sonuç listesinden seç
  const xml = await getUiXml();
  const pos = findCenter(xml, { text: `+${callingCode}` })
           || findCenter(xml, { text: callingCode });
  if (pos) {
    console.log(`[ADB] +${callingCode} bulundu, tıklanıyor: (${pos.x}, ${pos.y})`);
    await adbShell(`input tap ${pos.x} ${pos.y}`);
    await sleep(1000);
    return true;
  }

  // Debug: XML'in ilgili parçasını logla
  console.warn(`[ADB] +${callingCode} XML'de bulunamadı`);
  const snippet = xml.replace(/<node /g, '\n<node ').substring(0, 3000);
  console.warn('[ADB] Picker XML:\n', snippet);

  // Son çare: Enter
  await adbShell('input keyevent KEYCODE_ENTER');
  await sleep(1000);
  return true;
}

/**
 * Kayıt ekranında ülke kodunu ve numarayı gir.
 * UI dump element adları:
 *   - registration_country → ülke seçici dropdown (picker)
 *   - registration_phone   → ulusal numara alanı
 *   - registration_submit  → İLERİ butonu
 */
async function enterPhoneNumber(countryCode, nationalNumber) {
  // 1. Ülke kodunu picker'dan seç
  await selectCountryFromPicker(countryCode);

  // 2. Numara alanına tıkla
  await tapIf({ 'resource-id': `${WA_PACKAGE}:id/registration_phone` })
    || await tapIf({ hint: 'Telefon numarası' })
    || await tapIf({ hint: 'Phone number' });
  await sleep(400);

  // 3. Mevcut içeriği güvenilir şekilde temizle
  await clearCurrentField(20);

  // 4. Ulusal numarayı yaz
  for (const digit of nationalNumber) {
    await adbShell(`input text "${digit}"`);
    await sleep(80);
  }
  await sleep(300);
}

/** İleri / Sonraki butonuna bas */
async function clickNext() {
  return await tapIf({ 'resource-id': `${WA_PACKAGE}:id/registration_submit` })
    || await tapIf({ text: 'İleri' })  || await tapIf({ text: 'Sonraki' })
    || await tapIf({ text: 'Next' })   || await tapIf({ text: 'NEXT' })
    || await tapIf({ text: 'Done' })   || await tapIf({ text: 'DONE' })
    || await tapIf({ 'content-desc': 'Next' }) || await tapIf({ 'content-desc': 'İleri' });
}

/** "Bu numara doğru mu?" onay diyaloğunu kabul et */
async function confirmPhoneNumber() {
  await sleep(2000);
  await tapIf({ text: 'Tamam' }) || await tapIf({ text: 'Evet' })
    || await tapIf({ text: 'OK' }) || await tapIf({ text: 'Yes' })
    || await tapIf({ text: 'Continue' }) || await tapIf({ text: 'Devam et' });
}

/** SMS doğrulama kodunu gir */
async function enterSmsCode(code) {
  const digits = code.replace(/\D/g, '');
  const found = await tapIf({ 'resource-id': `${WA_PACKAGE}:id/verify_sms_code_input` })
    || await tapIf({ hint: 'Enter code' })
    || await tapIf({ 'class': 'android.widget.EditText' });
  await sleep(300);
  // Her haneyi ayrı ayrı yaz (bazı sürümler 6 ayrı kutu kullanır)
  for (const d of digits) {
    await adbShell(`input text "${d}"`);
    await sleep(200);
  }
  return found;
}

/** WhatsApp ana ekranına ulaşıldı mı? */
async function waitForHomeScreen(timeoutMs = 90000) {
  return waitFor(
    { text: 'Chats' },
    timeoutMs
  ) || waitFor(
    { 'resource-id': `${WA_PACKAGE}:id/home_tab_layout` },
    timeoutMs
  );
}

/** Profil kurulum ekranlarını atla */
async function skipProfileSetup() {
  for (const t of [{ text: 'Skip' }, { text: 'Not now' }, { text: 'Later' }]) {
    await tapIf(t);
    await sleep(1000);
  }
}

/**
 * Linked Devices → Link a Device → Link with phone number
 * Pairing code'u gir
 */
async function linkWithPairingCode(pairingCode) {
  // Ayarlar menüsüne git
  await tapIf({ 'content-desc': 'More options' }) || await tapIf({ 'content-desc': 'Menu' });
  await sleep(1000);
  await tapIf({ text: 'Settings' }) || await tapIf({ text: 'SETTINGS' });
  await sleep(1500);

  await tapIf({ text: 'Linked devices' }) || await tapIf({ text: 'Linked Devices' });
  await sleep(1500);

  await tapIf({ text: 'Link a device' }) || await tapIf({ text: 'LINK A DEVICE' });
  await sleep(2000);

  // QR yerine telefon numarasıyla bağlan seçeneği
  await tapIf({ text: 'Link with phone number' })
    || await tapIf({ text: 'Use phone number instead' });
  await sleep(2000);

  // Pairing code giriş alanı
  await tapIf({ 'class': 'android.widget.EditText' });
  await sleep(300);
  const clean = pairingCode.replace(/[^A-Z0-9]/gi, '');
  await adbShell(`input text "${clean}"`);
  await sleep(500);

  // Onayla
  await tapIf({ text: 'Link' }) || await tapIf({ text: 'OK' }) || await tapIf({ text: 'Connect' });
  await sleep(3000);
}

// ── Proxy yönetimi ────────────────────────────────────────────────────────────

/**
 * Android global HTTP proxy'sini ayarla.
 * proxyStr: "host:port" veya "http://user:pass@host:port"
 */
async function setAndroidProxy(proxyStr) {
  if (!proxyStr) return;
  try {
    let host, port;
    if (proxyStr.includes('://')) {
      const u = new URL(proxyStr);
      host = u.hostname;
      port = u.port || 8080;
    } else {
      [host, port] = proxyStr.split(':');
    }
    await adbShell(`settings put global http_proxy ${host}:${port}`);
    console.log(`[PROXY] Ayarlandı: ${host}:${port}`);
  } catch (e) {
    console.warn('[PROXY] Ayarlanamadı:', e.message);
  }
}

/** Android global proxy'yi temizle */
async function clearAndroidProxy() {
  try {
    await adbShell('settings put global http_proxy :0');
    console.log('[PROXY] Temizlendi');
  } catch {}
}

// ── Yardımcı: telefon numarası normalize ─────────────────────────────────────

function parsePhone(phone) {
  const withPlus = phone.startsWith('+') ? phone : '+' + phone.replace(/^00/, '');
  try {
    const p = parsePhoneNumber(withPlus);
    return { normalPhone: p.number.replace('+', ''), countryCode: String(p.countryCallingCode), nationalNumber: p.nationalNumber };
  } catch {
    const digits = phone.replace(/\D/g, '');
    return { normalPhone: digits, countryCode: '90', nationalNumber: digits.slice(2) };
  }
}

// ── API Endpoint'leri ─────────────────────────────────────────────────────────

/**
 * POST /register/start
 * { phone: "+905321234567" }
 * → BlueStacks'te WhatsApp açılır, numara girilir, SMS gönderilir
 */
app.post('/register/start', async (req, res) => {
  const { phone, proxy } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone zorunlu (örn: +905321234567)' });

  const { normalPhone, countryCode, nationalNumber } = parsePhone(phone);
  const instanceName = 'wa_' + normalPhone;

  console.log(`[KAYIT] Başlıyor: ${normalPhone} CC:${countryCode} NR:${nationalNumber}${proxy ? ' | PROXY: ' + proxy : ''}`);

  try {
    // ADB bağlantı kontrolü
    const connected = await adbConnect();
    if (!connected || !(await deviceReady())) {
      return res.status(503).json({
        error: 'BlueStacks ADB bağlantısı kurulamadı.',
        hint: 'BlueStacks açık mı? ADB etkin mi? (BlueStacks → Tercihler → Gelişmiş → ADB etkinleştir)',
      });
    }

    // Proxy varsa Android'e uygula
    if (proxy) await setAndroidProxy(proxy);

    sessions[normalPhone] = { state: 'starting', countryCode, nationalNumber, instanceName, proxy };

    await resetAndLaunchWhatsApp();
    await dismissWelcomeScreens();
    await sleep(1000);
    await enterPhoneNumber(countryCode, nationalNumber);
    await clickNext();
    await confirmPhoneNumber();

    sessions[normalPhone].state = 'sms_sent';
    console.log(`[KAYIT] SMS gönderildi: ${normalPhone}`);

    res.json({
      success: true,
      phone: normalPhone,
      instanceName,
      proxy: proxy || null,
      message: 'WhatsApp başlatıldı, SMS kodu gönderildi. Kodu girin.',
    });

  } catch (err) {
    console.error(`[KAYIT HATA] ${normalPhone}:`, err.message);
    await clearAndroidProxy();
    delete sessions[normalPhone];
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /register/verify
 * { phone: "+905321234567", code: "123456" }
 * → Kodu girer, kaydı tamamlar, Evolution instance oluşturur + pairing code ile bağlar
 */
app.post('/register/verify', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone ve code zorunlu' });

  const { normalPhone } = parsePhone(phone);
  const session = sessions[normalPhone];
  if (!session) return res.status(404).json({ error: 'Aktif oturum yok. Önce /register/start çağırın.' });

  console.log(`[KAYIT] Kod doğrulama: ${normalPhone} → ${code}`);

  try {
    session.state = 'verifying';

    await enterSmsCode(code);

    const registered = await waitForHomeScreen(90000);
    if (!registered) {
      return res.status(400).json({
        error: 'WhatsApp kaydı tamamlanamadı. Kod yanlış veya süresi dolmuş olabilir.',
      });
    }

    await skipProfileSetup();
    console.log(`[KAYIT] WhatsApp kaydı tamamlandı: ${normalPhone}`);

    // Evolution API instance oluştur
    let pairingCode = null;
    try {
      await axios.post(`${EVOLUTION_URL}/instance/create`, {
        instanceName: session.instanceName,
        qrcode: false,
        integration: 'WHATSAPP-BAILEYS',
      }, { headers: { apikey: EVOLUTION_API_KEY } });

      await sleep(2000);

      // Pairing code al (Evolution API v1)
      const r = await axios.get(`${EVOLUTION_URL}/instance/connect/${session.instanceName}`, {
        headers: { apikey: EVOLUTION_API_KEY },
      });
      pairingCode = r.data?.pairingCode || r.data?.code || null;
    } catch (evoErr) {
      console.warn('[EVO]', evoErr.response?.data?.message || evoErr.message);
    }

    if (pairingCode) {
      console.log(`[KAYIT] Pairing code bağlanıyor: ${pairingCode}`);
      await linkWithPairingCode(pairingCode);
      session.state = 'linked';
    } else {
      session.state = 'registered';
      console.warn('[KAYIT] Pairing code alınamadı, manuel bağlantı gerekebilir.');
    }

    // Kayıt tamamlandı — proxy'yi temizle
    await clearAndroidProxy();
    delete sessions[normalPhone];

    res.json({
      success: true,
      instanceName: session.instanceName,
      phone: normalPhone,
      pairingCode,
      message: pairingCode
        ? `Tamamlandı! "${session.instanceName}" Evolution panelinde aktif.`
        : `WhatsApp kaydedildi. Evolution panelinden manuel QR ile bağlayın.`,
    });

  } catch (err) {
    console.error(`[KAYIT VERIFY HATA] ${normalPhone}:`, err.message);
    await clearAndroidProxy();
    res.status(500).json({ error: err.message });
  }
});

/** GET /adb/status — BlueStacks bağlantısını kontrol et */
app.get('/adb/status', async (req, res) => {
  try {
    const connected = await adbConnect();
    const ready     = connected && await deviceReady();
    let devices     = '';
    try { devices = (await execAsync('adb devices')).stdout; } catch {}
    res.json({ connected, ready, device: DEVICE, devices });
  } catch (e) {
    res.json({ connected: false, ready: false, error: e.message });
  }
});

/** GET /register/sessions — Aktif oturumlar */
app.get('/register/sessions', (req, res) => {
  res.json(Object.entries(sessions).map(([phone, s]) => ({
    phone, instanceName: s.instanceName, state: s.state,
  })));
});

app.get('/health', (req, res) => res.json({ status: 'ok', device: DEVICE }));

app.listen(PORT, () =>
  console.log(`Registrar (ADB) :${PORT} | BlueStacks hedef: ${DEVICE}`)
);
