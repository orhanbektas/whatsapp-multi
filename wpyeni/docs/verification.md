# wpyeni Verification Matrix (Phase 7)

Bu doküman `wpyeni` için kontrollü doğrulama ve rollout akışını tanımlar.

## 1) Smoke Matrix

### A. Syntax / Boot
- registrar boot: `node wpyeni/registrar/index.js`
- gateway boot: `node wpyeni/gateway/index.js`
- health:
  - `GET /health` (gateway)
  - `GET /health` (registrar)
- Script: `scripts/smoke/01_health.sh`

### B. Device Ready
- `GET /adb/status` ve online device kontrolü (`state=device`)
- Script: `scripts/smoke/02_device_ready.sh`

### C. UI Flow (welcome -> phone)
- `POST /register/start`
- başarı kriteri: `success=true` ve `state=phone_input|otp_verify`
- Script: `scripts/smoke/03_welcome_to_phone.sh`

### D. UI Flow (phone -> otp handoff)
- `POST /register/start`
- başarı kriteri: OTP bekleme/handoff sinyali (`message` içinde OTP veya `state`)
- Script: `scripts/smoke/04_phone_to_otp.sh`

### E. Emulator Profile Rotation (Faz 8)
- `EMULATOR_PROFILE_STRATEGY=round_robin`
- `EMULATOR_PROFILE_POOL=emu-01,emu-02,...`
- `POST /register/start` çağrılarında `emulatorProfile` verilmezse profil otomatik round-robin seçilir.
- Seçilen profil response içinde `emulatorProfile` olarak döner, verify aynı profile bağlı kalır.
- `scripts/smoke/04_phone_to_otp.sh` artık ardışık 2 start çağrısı yapar ve explicit profil verilmemişse `emulatorProfile` rotasyonunu doğrular (`p1 !== p2`).
- Örnek:
  - `SMOKE_PHONE_OTP=15550000002 SMOKE_PHONE_OTP_2=15550000003 REGISTRAR_TOKEN=... ./wpyeni/scripts/smoke/04_phone_to_otp.sh`

### F. Stability Settings (Faz 8)
- Güvenli/operasyonel ayarlar (spoofing yok): timezone, locale, animation scales, stay-awake
- Env:
  - `REGISTRAR_APPLY_STABILITY_SETTINGS`
  - `REGISTRAR_STABILITY_TIMEZONE`
  - `REGISTRAR_STABILITY_LOCALE`
  - `REGISTRAR_STABILITY_DISABLE_ANIMATIONS`
  - `REGISTRAR_STABILITY_STAY_AWAKE`
- Uygulama sonucu `GET /adb/status` içinde `stabilityStatus` alanında raporlanır.

### G. Proxy/Policy
- geçerli proxy kabul
- private/auth-in-url proxy reddi
- start->verify same proxy kuralı
- session’da `proxyKey/proxyWarnings/proxyApplyStatus` doğrulaması
- profile rotasyon smoke hata sınıfları: `profile_rotation_missing`, `profile_rotation_failed`

## 2) Hata Sınıflandırması

- `cihaz_yok`
  - adb yok, device offline, runtime not ready
- `ui_mismatch`
  - beklenen welcome/phone/otp state bulunamadı
- `sms_wait`
  - OTP gecikmesi, verify için kod bekleniyor
- `proxy_failure`
  - proxy policy reject, proxy apply failed, same-proxy mismatch

## 3) Controlled Rollout

1. **Manuel test (zorunlu ilk adım)**
   - Panelden cihaz seç + emulator start
   - Start/verify akışını tek cihaz + tek numara ile dene
   - `registrar/artifacts` altında screenshot/xml kanıtlarını kontrol et

2. **Sınırlı otomasyon**
   - Smoke scriptlerini sırayla çalıştır:
     1) `01_health.sh`
     2) `02_device_ready.sh`
     3) `03_welcome_to_phone.sh`
     4) `04_phone_to_otp.sh`
   - Başarısızlıkta sınıf bazlı aksiyon al (cihaz/proxy/ui/sms)

3. **Tam akış**
   - Proxy policy açıkken 3-5 örnek akış
   - same-proxy-on-verify ihlali testleri
   - sonra geniş ölçekli operasyon

## 4) Guardrail Notları

- UI selector değişimi yapmadan önce XML + screenshot kanıtı alın.
- Device-level proxy auth desteği sınırlı olabilir; network-level yaklaşım tercih edilir.
- `proxyApplyStatus.applied=false` durumları "çalışıyor gibi ama cihazda uygulanmayan" sınıfında ayrıca izlenmelidir.
