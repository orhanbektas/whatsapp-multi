const { stateSelectors } = require('./selectors');

const STATE = Object.freeze({
  LAUNCH: 'launch',
  CUSTOM_ROM_ALERT: 'custom_rom_alert',
  WELCOME: 'welcome',
  PHONE_INPUT: 'phone_input',
  NOTIFICATION_PROMPT: 'notification_prompt',
  OTP_VERIFY: 'otp_verify',
  HOME: 'home',
  BLOCKED_QR: 'blocked_qr',
  BLOCKED_OVERFLOW: 'blocked_overflow',
  UNKNOWN: 'unknown',
});

function normalize(xml) {
  return String(xml || '').toLowerCase();
}

function hasAny(haystack, needles = []) {
  return needles.some((n) => haystack.includes(String(n).toLowerCase()));
}

function countAny(haystack, needles = []) {
  return needles.reduce((acc, n) => (haystack.includes(String(n).toLowerCase()) ? acc + 1 : acc), 0);
}

function stateSignals(xml) {
  const x = normalize(xml);

  const homeIdHits = countAny(x, stateSelectors.home.idAny);
  const homeTextHits = countAny(x, stateSelectors.home.textAny);
  const otpIdHits = countAny(x, stateSelectors.otpVerify.idAny);
  const otpTextHits = countAny(x, stateSelectors.otpVerify.textAny);

  return {
    homeIdHits,
    homeTextHits,
    homeHits: homeIdHits + homeTextHits,
    otpIdHits,
    otpTextHits,
    otpHits: otpIdHits + otpTextHits,
  };
}

function isStrongHomeState(xml) {
  const s = stateSignals(xml);
  return s.homeIdHits >= 1 || s.homeHits >= 2;
}

function isStrongOtpState(xml) {
  const s = stateSignals(xml);
  return s.otpIdHits >= 1 || s.otpHits >= 2;
}

function detectState(xml) {
  const x = normalize(xml);

  if (isStrongHomeState(x)) return STATE.HOME;
  if (isStrongOtpState(x)) return STATE.OTP_VERIFY;
  if (hasAny(x, stateSelectors.notificationPrompt.idAny) || hasAny(x, stateSelectors.notificationPrompt.textAny)) return STATE.NOTIFICATION_PROMPT;
  if (hasAny(x, stateSelectors.phoneInput.idAny) || hasAny(x, stateSelectors.phoneInput.textAny)) return STATE.PHONE_INPUT;
  if (hasAny(x, stateSelectors.customRomAlert.idAny) || hasAny(x, stateSelectors.customRomAlert.textAny)) return STATE.CUSTOM_ROM_ALERT;
  if (hasAny(x, stateSelectors.welcome.idAny) || hasAny(x, stateSelectors.welcome.textAny)) return STATE.WELCOME;
  if (hasAny(x, stateSelectors.blocked.qrOrLinkingTextAny)) return STATE.BLOCKED_QR;
  if (hasAny(x, stateSelectors.blocked.overflowTextAny)) return STATE.BLOCKED_OVERFLOW;
  if (hasAny(x, stateSelectors.launch.idAny) || hasAny(x, stateSelectors.launch.textAny)) return STATE.LAUNCH;

  return STATE.UNKNOWN;
}

function isTerminal(state) {
  return [STATE.PHONE_INPUT, STATE.OTP_VERIFY, STATE.HOME].includes(state);
}

function isGuardFailure(state) {
  return [STATE.BLOCKED_OVERFLOW, STATE.BLOCKED_QR].includes(state);
}

module.exports = {
  STATE,
  detectState,
  isTerminal,
  isGuardFailure,
  stateSignals,
  isStrongHomeState,
  isStrongOtpState,
};
