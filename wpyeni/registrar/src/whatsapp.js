const fs = require('fs/promises');
const path = require('path');
const {
  STATE,
  detectState,
  isTerminal,
  isGuardFailure,
  stateSignals,
  isStrongHomeState,
  isStrongOtpState,
} = require('./ui/stateMachine');
const { stateSelectors } = require('./ui/selectors');

function createWhatsAppFlow({
  adb,
  waPackage = process.env.WA_PACKAGE || 'com.whatsapp',
  artifactsDir = process.env.REGISTRAR_ARTIFACTS_DIR || path.resolve(__dirname, '../artifacts'),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!adb) {
    throw new Error('createWhatsAppFlow requires adb instance.');
  }

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  async function ensureArtifactsDir() {
    await fs.mkdir(artifactsDir, { recursive: true });
  }

  async function dumpUiXml(deviceSerial, label = 'ui') {
    const remotePath = '/sdcard/wpyeni-ui.xml';

    try {
      await adb.shell(deviceSerial, ['uiautomator', 'dump', remotePath]);
      const xml = await adb.shell(deviceSerial, ['cat', remotePath]);

      await ensureArtifactsDir();
      const filePath = path.join(artifactsDir, `${stamp()}-${label}.xml`);
      await fs.writeFile(filePath, xml || '', 'utf8');

      return {
        xml: String(xml || ''),
        filePath,
      };
    } catch (error) {
      await ensureArtifactsDir();
      const filePath = path.join(artifactsDir, `${stamp()}-${label}-error.xml`);
      const content = `<!-- dump failed: ${error.message} -->`;
      await fs.writeFile(filePath, content, 'utf8');
      return {
        xml: '',
        filePath,
        error: error.message,
      };
    }
  }

  async function takeScreenshot(deviceSerial, label = 'screen') {
    const remotePath = '/sdcard/wpyeni-screen.png';

    await adb.shell(deviceSerial, ['screencap', '-p', remotePath]);

    let binary;
    if (typeof adb.execBinary === 'function') {
      binary = await adb.execBinary(deviceSerial, ['exec-out', 'cat', remotePath]);
    } else {
      const textFallback = await adb.exec(deviceSerial, ['exec-out', 'cat', remotePath]);
      binary = Buffer.from(textFallback || '', 'binary');
    }

    await ensureArtifactsDir();
    const filePath = path.join(artifactsDir, `${stamp()}-${label}.png`);
    await fs.writeFile(filePath, Buffer.isBuffer(binary) ? binary : Buffer.from(binary || ''));

    return { filePath };
  }

  async function captureEvidence(deviceSerial, label) {
    const [uiDump, screenshot] = await Promise.all([
      dumpUiXml(deviceSerial, label),
      takeScreenshot(deviceSerial, label),
    ]);

    const state = detectState(uiDump.xml);

    return {
      label,
      state,
      uiXmlPath: uiDump.filePath,
      screenshotPath: screenshot.filePath,
      dumpError: uiDump.error || null,
      xml: uiDump.xml,
    };
  }

  async function launchApp(deviceSerial) {
    await adb.shell(deviceSerial, ['monkey', '-p', waPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
    await sleep(1800);
  }

  async function currentForegroundPackage(deviceSerial) {
    try {
      const out = await adb.shell(deviceSerial, ['dumpsys', 'activity', 'top']);
      const x = String(out || '').toLowerCase();
      if (x.includes(waPackage.toLowerCase())) return waPackage;
      if (x.includes('launcher')) return 'launcher';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async function tapByText(deviceSerial, text, xmlOverride = null) {
    const escaped = String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const xml = xmlOverride == null
      ? (await dumpUiXml(deviceSerial, `tap-${String(text).toLowerCase().replace(/\s+/g, '-')}`)).xml
      : String(xmlOverride || '');

    const re = new RegExp(`text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
    const alt = new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*text="${escaped}"`, 'i');

    const m = xml.match(re) || xml.match(alt);
    if (!m) return false;

    const x = Math.floor((Number(m[1]) + Number(m[3])) / 2);
    const y = Math.floor((Number(m[2]) + Number(m[4])) / 2);

    await adb.shell(deviceSerial, ['input', 'tap', String(x), String(y)]);
    await sleep(900);
    return true;
  }

  async function tapFirstMatchingText(deviceSerial, textList = []) {
    const { xml } = await dumpUiXml(deviceSerial, 'tap-candidates');
    for (const text of textList) {
      if (await tapByText(deviceSerial, text, xml)) {
        return true;
      }
    }
    return false;
  }

  async function tapFallback(deviceSerial, xRatio, yRatio) {
    const sizeOut = await adb.shell(deviceSerial, ['wm', 'size']);
    const m = String(sizeOut).match(/(\d+)x(\d+)/);
    if (!m) return false;

    const width = Number(m[1]);
    const height = Number(m[2]);
    const x = Math.floor(width * xRatio);
    const y = Math.floor(height * yRatio);
    await adb.shell(deviceSerial, ['input', 'tap', String(x), String(y)]);
    await sleep(1100);
    return true;
  }

  async function handleAlert(deviceSerial) {
    const matched = await tapFirstMatchingText(deviceSerial, stateSelectors.customRomAlert.actionTextAny);
    if (matched) return true;
    return tapFallback(deviceSerial, 0.72, 0.63);
  }

  async function handleWelcome(deviceSerial) {
    const matched = await tapFirstMatchingText(deviceSerial, stateSelectors.welcome.actionTextAny);
    if (matched) return true;
    return tapFallback(deviceSerial, 0.5, 0.93);
  }

  async function driveToPhoneInput(deviceSerial, { maxSteps = 12 } = {}) {
    const traces = [];

    await launchApp(deviceSerial);

    for (let step = 1; step <= maxSteps; step += 1) {
      const fg = await currentForegroundPackage(deviceSerial);
      if (fg !== waPackage) {
        await launchApp(deviceSerial);
      }

      const evidence = await captureEvidence(deviceSerial, `step-${step}`);
      traces.push({
        step,
        state: evidence.state,
        uiXmlPath: evidence.uiXmlPath,
        screenshotPath: evidence.screenshotPath,
      });

      if (isGuardFailure(evidence.state)) {
        return {
          ok: false,
          reason: 'guard_failed',
          guardState: evidence.state,
          traces,
        };
      }

      if (evidence.state === STATE.PHONE_INPUT) {
        return {
          ok: true,
          state: evidence.state,
          traces,
        };
      }

      if (evidence.state === STATE.CUSTOM_ROM_ALERT) {
        await handleAlert(deviceSerial);
        continue;
      }

      if (evidence.state === STATE.WELCOME || evidence.state === STATE.LAUNCH || evidence.state === STATE.UNKNOWN) {
        await handleWelcome(deviceSerial);
        continue;
      }

      if (isTerminal(evidence.state)) {
        return {
          ok: true,
          state: evidence.state,
          traces,
        };
      }
    }

    return {
      ok: false,
      reason: 'phone_input_not_reached',
      traces,
    };
  }

  function hasOtpIndicators(xml) {
    return detectState(xml) === STATE.OTP_VERIFY;
  }

  function hasStrongOtpIndicators(xml) {
    return isStrongOtpState(xml);
  }

  function hasStrongHomeIndicators(xml) {
    return isStrongHomeState(xml);
  }

  async function waitForStrongHomeState(deviceSerial, {
    timeoutMs = Number(process.env.HOME_WAIT_MS || 20000),
    pollMs = 1000,
    evidenceLabelPrefix = 'verify-home',
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastEvidence = null;

    while (Date.now() < deadline) {
      lastEvidence = await captureEvidence(deviceSerial, `${evidenceLabelPrefix}-${stamp()}`);
      if (hasStrongHomeIndicators(lastEvidence.xml)) {
        return {
          confirmed: true,
          evidence: {
            ...lastEvidence,
            state: STATE.HOME,
            signals: stateSignals(lastEvidence.xml),
          },
        };
      }

      await sleep(pollMs);
    }

    return {
      confirmed: false,
      evidence: lastEvidence
        ? {
            ...lastEvidence,
            signals: stateSignals(lastEvidence.xml),
          }
        : null,
    };
  }

  return {
    STATE,
    detectState,
    launchApp,
    currentForegroundPackage,
    dumpUiXml,
    takeScreenshot,
    captureEvidence,
    driveToPhoneInput,
    hasOtpIndicators,
    hasStrongOtpIndicators,
    hasStrongHomeIndicators,
    stateSignals,
    waitForStrongHomeState,
  };
}

module.exports = { createWhatsAppFlow };
