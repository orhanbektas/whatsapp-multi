# CLAUDE.md

Bu dosya, Claude Code'un (claude.ai/code) bu depoda çalışırken izlemesi gereken rehberi içerir.

## Genel Bakış

Bu repo, çoklu WhatsApp hesap yönetimi için iki özel Node.js servisinden oluşur:
- `api_gateway` (4000): dış API + admin paneli + orkestrasyon/proxy katmanı
- `registrar` (4001): BlueStacks/ADB ile SMS tabanlı WhatsApp kayıt otomasyonu

Docker tarafında entegre servisler:
- Evolution API (Baileys tabanlı)
- PostgreSQL + Redis (Evolution kalıcılık/önbellek)
- Opsiyonel Chatwoot + Sidekiq profili

## Sık Kullanılan Komutlar

### Ortam hazırlığı
```bash
cp .env.example .env
# Çalıştırmadan önce gerekli secret/key alanlarını doldurun
```

### Docker ile çalışma (önerilen)
```bash
# Çekirdek stack
docker compose up -d

# Chatwoot/Sidekiq profili ile
docker compose --profile chatwoot up -d

# Sadece uygulama servislerini yeniden build et
docker compose up -d --build gateway
docker compose up -d --build registrar

# Log ve durum
docker compose logs -f gateway
docker compose logs -f registrar
docker compose ps

# Stack'i durdur
docker compose down
```

### Lokal geliştirme (Node servislerini Docker dışı çalıştırma)
```bash
# bağımlılıkları kur
cd api_gateway && npm install
cd registrar && npm install

# servisleri çalıştır
cd api_gateway && node index.js
cd registrar && npm start
```

### Health check
```bash
curl http://localhost:4000/health
curl http://localhost:4001/health
curl http://localhost:4000/panel/register/adb-status
```

### Test ve lint durumu
- Bu repoda tanımlı bir test suite yok.
- Bu repoda tanımlı bir lint script/config yok.
- Tekil test çalıştırma komutu bulunmuyor.
- Değişiklik doğrulaması manuel endpoint kontrolleri + `docker compose logs` ile yapılıyor.

## Mimari (Büyük Resim)

### 1) Dış sınır ve politika katmanı: Gateway
`api_gateway/index.js` dışarıya açılan ana sınırdır:
- `/panel/*` ve `/` admin yüzeyi; panel auth zorunludur (`PANEL_TOKEN` veya Basic Auth)
- `/api/*` endpoint’leri `GATEWAY_API_KEYS` içindeki `x-api-key` ile korunur
- Gateway, doğrulama/rate-limit uygulayıp şu servislere proxy yapar:
  - Evolution API (`EVOLUTION_URL`)
  - Registrar (`REGISTRAR_URL`, `x-registrar-token` header’ı ile)

Admin UI tek sayfa olarak `api_gateway/public/index.html` dosyasından servis edilir ve `/panel/*` uç noktalarını kullanır.

### 2) Durum tutan otomasyon motoru: Registrar
`registrar/index.js`, ADB + WhatsApp UI otomasyonunu yürütür:
- `execFile` ile `adb`/`adb shell` komutlarını çalıştırır
- `uiautomator dump` XML çıktısından UI elemanı bulup tıklama/yazma yapar
- Kayıt akışı: uygulama reset/launch, ülke seçimi, telefon girişi, OTP doğrulama
- Uygunsa Evolution pairing code ile eşleştirme yapar

Durum modeli:
- Oturumlar in-memory `sessions` objesinde (normalize telefon numarası anahtarıyla) tutulur
- Tek cihazda eşzamanlı çakışmayı engellemek için global `deviceLock` kullanılır
- TTL (`REGISTRATION_SESSION_TTL_MS`) ile oturum/lock temizliği yapılır
- Registrar yeniden başlarsa aktif oturum bilgileri kaybolur

### 3) Servisler arası kayıt akışı
1. Panel, gateway’e `POST /panel/register/start` çağrısı yapar
2. Gateway, registrar’a `POST /register/start` proxy eder
3. Registrar, WhatsApp’ı SMS kodu aşamasına kadar otomatik ilerletir
4. Panel, OTP ile `POST /panel/register/verify` çağrısı yapar
5. Registrar OTP’yi girer, WhatsApp ana ekrana geçişi bekler
6. Registrar Evolution instance oluşturur/bağlar ve mümkünse pairing code ile linkler

### 4) Docker çalışma düzeni
`docker-compose.yml` bağımlılık zinciri:
- `evolution` -> sağlıklı `postgres` + `redis`
- `registrar` -> `evolution`
- `gateway` -> `evolution` + `registrar`
- `chatwoot`/`sidekiq` -> yalnızca `--profile chatwoot` ile

Not: Node uygulama container’ları başlangıçta `npm install` çalıştırır; ilk açılış daha yavaş ve ağ bağımlıdır.

## Yüksek Sinyalli Dosyalar

- `api_gateway/index.js` — auth sınırları, doğrulama, Evolution/Registrar proxy akışları
- `api_gateway/public/index.html` — admin panel akışları (instance, QR, SMS kayıt)
- `registrar/index.js` — ADB yardımcıları, UI XML parse, session/lock yaşam döngüsü
- `docker-compose.yml` — servis grafiği, env map, healthcheck, profile yapısı
- `.env.example` — zorunlu ortam değişkenleri sözleşmesi
- `scripts/init.sql` — Postgres içinde `evolution` DB oluşturma

## Davranışı Belirleyen Ortam Değişkenleri

- `GATEWAY_API_KEYS` — `/api/*` erişim anahtarları
- `PANEL_TOKEN` veya `PANEL_BASIC_USER` + `PANEL_BASIC_PASS` — panel auth
- `REGISTRAR_INTERNAL_TOKEN` — gateway <-> registrar ortak gizli anahtar
- `EVOLUTION_URL` / `EVOLUTION_API_KEY` — Evolution hedefi + API kimlik doğrulama
- `REGISTRAR_URL` — gateway -> registrar baz URL
- `REQUEST_TIMEOUT_MS` — upstream HTTP timeout
- `ADB_HOST` / `ADB_PORT` — BlueStacks ADB hedefi
- `WA_PACKAGE` — WhatsApp paket adı (`com.whatsapp` veya `com.whatsapp.w4b`)
- `REGISTRATION_SESSION_TTL_MS` — registrar oturum/lock TTL süresi

## Operasyonel Dikkat Noktaları

- Panel route’ları mevcut kodda auth korumalıdır; panel erişim sorunu varsa önce panel auth env’lerini kontrol edin.
- Registrar otomasyonu WhatsApp UI/locale/sürüm farklarına karşı kırılgandır (text/resource-id/timing bağımlılığı).
- Registrar state kalıcı değil, sadece process memory’de tutulur.
- `scripts/setup_chatwoot.sh` içinde `chatwoot_rails` kullanılıyor; compose servis adı `chatwoot` olduğu için script güncellemesi gerekebilir.