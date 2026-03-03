#!/usr/bin/env bash
set -euo pipefail

REGISTRAR_URL="${REGISTRAR_URL:-http://localhost:4101}"
REGISTRAR_TOKEN="${REGISTRAR_TOKEN:-change-me}"
PHONE="${SMOKE_PHONE_OTP:-15550000002}"
PHONE_2="${SMOKE_PHONE_OTP_2:-15550000003}"
DEVICE_SERIAL="${SMOKE_DEVICE_SERIAL:-}"
EMU_PROFILE="${SMOKE_EMULATOR_PROFILE:-}"

build_req() {
  local phone="$1"
  node -e "const [p, ds, ep]=process.argv.slice(1); console.log(JSON.stringify({ phone: p, deviceSerial: ds || undefined, emulatorProfile: ep || undefined }));" "$phone" "$DEVICE_SERIAL" "$EMU_PROFILE"
}

call_start() {
  local phone="$1"
  local req
  req="$(build_req "$phone")"
  curl -sS -X POST "${REGISTRAR_URL}/register/start" -H "content-type: application/json" -H "x-registrar-token: ${REGISTRAR_TOKEN}" --data "$req"
}

JSON1="$(call_start "$PHONE")"
JSON2="$(call_start "$PHONE_2")"

echo "${JSON1}__SEP__${JSON2}" | node -e "
const raw=require('fs').readFileSync(0,'utf8');
const [a,b]=raw.split('__SEP__');
const first=JSON.parse(a);
const second=JSON.parse(b);

function classify(reason) {
  const r=String(reason || '').toLowerCase();
  if (r.includes('proxy')) return 'proxy_failure';
  if (r.includes('device_')) return 'cihaz_yok';
  if (r.includes('guard') || r.includes('phone_input_not_reached') || r.includes('otp_state_mismatch')) return 'ui_mismatch';
  return 'sms_wait';
}

function isOtpHandoffOk(d) {
  const msg = String(d.message || '').toLowerCase();
  return Boolean(d.success && (msg.includes('otp') || d.state === 'otp_verify' || d.state === 'phone_input'));
}

if (!isOtpHandoffOk(first)) {
  const reason = first.reason || first.message || 'unknown';
  console.error('FAIL(phone_to_otp#1):', reason);
  console.error('class=' + classify(reason));
  process.exit(5);
}

if (!isOtpHandoffOk(second)) {
  const reason = second.reason || second.message || 'unknown';
  console.error('FAIL(phone_to_otp#2):', reason);
  console.error('class=' + classify(reason));
  process.exit(5);
}

const explicitProfile = process.env.SMOKE_EMULATOR_PROFILE && String(process.env.SMOKE_EMULATOR_PROFILE).trim() !== '';
if (!explicitProfile) {
  const p1 = first.emulatorProfile || null;
  const p2 = second.emulatorProfile || null;

  if (!p1 || !p2) {
    console.error('FAIL(profile_rotation): emulatorProfile missing in start response(s).');
    console.error('class=profile_rotation_missing');
    process.exit(6);
  }

  if (p1 === p2) {
    console.error('FAIL(profile_rotation): round_robin did not rotate profile.');
    console.error('firstProfile=' + p1 + ' secondProfile=' + p2);
    console.error('class=profile_rotation_failed');
    process.exit(6);
  }

  console.log('OK: profile rotation passed', p1, '->', p2);
}

console.log('OK: phone_to_otp handoff passed (2/2)');
"