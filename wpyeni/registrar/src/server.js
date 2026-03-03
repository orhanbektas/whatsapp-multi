const express = require('express');
const { createAdb } = require('./adb');
const { createDeviceRuntime } = require('./device');
const { createEmulatorManager } = require('./emulator/manager');
const { createWhatsAppFlow } = require('./whatsapp');
const { createPolicy } = require('./policy');
const { applyDeviceLevelProxy } = require('./proxy');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function toIso(date = new Date()) {
  return date.toISOString();
}

function toMs(value) {
  return new Date(value).getTime();
}

function createRegistrarServer({
  internalToken = process.env.REGISTRAR_INTERNAL_TOKEN,
  port = Number(process.env.REGISTRAR_PORT || 4101),
  adb = createAdb(),
  emulatorManager = createEmulatorManager(),
  deviceRuntime = createDeviceRuntime({
    adb,
    emulatorManager,
    deviceMode: process.env.REGISTRAR_DEVICE_MODE || 'legacy',
  }),
  whatsappFlow = createWhatsAppFlow({ adb }),
  policy = createPolicy(),
} = {}) {
  const app = express();
  const sessions = new Map();

  const verifyMaxAttempts = Number(process.env.REGISTRATION_VERIFY_MAX_ATTEMPTS || 5);
  const verifyMinIntervalMs = Number(process.env.REGISTRATION_VERIFY_MIN_INTERVAL_MS || 7000);
  const verifyWindowMs = Number(process.env.REGISTRATION_VERIFY_WINDOW_MS || 15 * 60 * 1000);
  const sessionTtlMs = Number(process.env.REGISTRATION_SESSION_TTL_MS || 30 * 60 * 1000);
  const verifiedRetentionMs = Number(process.env.REGISTRATION_VERIFIED_RETENTION_MS || 5 * 60 * 1000);

  function buildError({ message, errorCode, reason = null, retryable = false, details = null, ...rest }) {
    return {
      success: false,
      message,
      errorCode,
      reason,
      retryable,
      details,
      ...rest,
    };
  }

  function buildSuccess(data = {}) {
    return {
      success: true,
      ...data,
    };
  }

  function purgeExpiredSessions() {
    const now = Date.now();
    for (const [phone, session] of sessions.entries()) {
      const lastMs = toMs(session.updatedAt || session.startedAt || toIso());
      const verifiedAtMs = session.verifiedAt ? toMs(session.verifiedAt) : null;

      if (session.status === 'verified' && verifiedAtMs && now - verifiedAtMs > verifiedRetentionMs) {
        sessions.delete(phone);
        continue;
      }

      if (now - lastMs > sessionTtlMs) {
        sessions.delete(phone);
      }
    }
  }

  const cleanupTimer = setInterval(purgeExpiredSessions, Math.max(5000, Math.floor(sessionTtlMs / 2)));
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      success: true,
      service: 'registrar',
      status: 'ok',
      deviceMode: deviceRuntime.deviceMode,
      verifyPolicy: {
        maxAttempts: verifyMaxAttempts,
        minIntervalMs: verifyMinIntervalMs,
        verifyWindowMs,
      },
      sessionPolicy: {
        ttlMs: sessionTtlMs,
        verifiedRetentionMs,
      },
    });
  });

  app.use((req, res, next) => {
    if (!internalToken) {
      return res.status(500).json(buildError({
        message: 'REGISTRAR_INTERNAL_TOKEN is not configured.',
        errorCode: 'config_error',
        reason: 'missing_internal_token',
        retryable: false,
      }));
    }

    const token = req.header('x-registrar-token');
    if (token !== internalToken) {
      return res.status(401).json(buildError({
        message: 'Unauthorized registrar token.',
        errorCode: 'unauthorized',
        reason: 'invalid_internal_token',
        retryable: false,
      }));
    }

    return next();
  });

  app.get('/adb/status', async (_req, res) => {
    try {
      const devices = await deviceRuntime.listDevices();
      return res.json(buildSuccess({
        selectedDeviceSerial: typeof adb.getDefaultDevice === 'function' ? adb.getDefaultDevice() : null,
        devices,
        stabilityStatus: typeof deviceRuntime.getStabilityStatus === 'function' ? deviceRuntime.getStabilityStatus() : null,
      }));
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'adb_status_failed',
        reason: 'adb_status_failed',
        retryable: true,
      }));
    }
  });

  app.get('/emulator/devices', async (_req, res) => {
    try {
      const profiles = await emulatorManager.listProfiles();
      return res.json(buildSuccess({ profiles }));
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'emulator_profiles_failed',
        reason: 'emulator_profiles_failed',
        retryable: true,
      }));
    }
  });

  app.get('/emulator/status', async (_req, res) => {
    try {
      const status = await emulatorManager.status();
      return res.json(buildSuccess({ status }));
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'emulator_status_failed',
        reason: 'emulator_status_failed',
        retryable: true,
      }));
    }
  });

  app.post('/emulator/select', async (req, res) => {
    try {
      const result = await emulatorManager.select(req.body?.profile || null);
      return res.status(result.ok === false ? 400 : 200).json({
        success: result.ok !== false,
        ...result,
      });
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'emulator_select_failed',
        reason: 'emulator_select_failed',
        retryable: true,
      }));
    }
  });

  app.post('/emulator/start', async (req, res) => {
    try {
      const result = await emulatorManager.start(req.body?.profile || null);
      return res.status(result.ok === false ? 400 : 200).json({ success: result.ok !== false, ...result });
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'emulator_start_failed',
        reason: 'emulator_start_failed',
        retryable: true,
      }));
    }
  });

  app.post('/emulator/stop', async (req, res) => {
    try {
      const result = await emulatorManager.stop(req.body?.profile || null);
      return res.status(result.ok === false ? 400 : 200).json({ success: result.ok !== false, ...result });
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'emulator_stop_failed',
        reason: 'emulator_stop_failed',
        retryable: true,
      }));
    }
  });

  app.get('/register/sessions', (_req, res) => {
    const all = Array.from(sessions.values()).map((session) => ({
      phone: session.phone,
      deviceSerial: session.deviceSerial,
      emulatorProfile: session.emulatorProfile || null,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      verifiedAt: session.verifiedAt || null,
      verifyAttempts: session.verifyAttempts || 0,
      lastVerifyAt: session.lastVerifyAt || null,
      firstOtpAt: session.firstOtpAt || null,
      proxyKey: session.proxyKey || null,
      proxyCountryCode: session.proxyCountryCode || null,
      proxyWarnings: session.proxyWarnings || [],
      proxyApplyStatus: session.proxyApplyStatus || null,
      stabilityStatus: session.stabilityStatus || null,
    }));

    return res.json(buildSuccess({ sessions: all }));
  });

  app.post('/register/start', async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) {
        return res.status(400).json(buildError({
          message: 'phone is required.',
          errorCode: 'validation_error',
          reason: 'phone_required',
          retryable: false,
        }));
      }

      const current = sessions.get(phone) || null;
      const startPolicy = policy.evaluateStart({ payload: req.body || {}, session: current });
      if (!startPolicy.ok) {
        return res.status(400).json(buildError({
          message: 'proxy_policy_rejected',
          errorCode: 'proxy_policy_rejected',
          reason: startPolicy.reason,
          retryable: false,
          details: { warnings: startPolicy.warnings || [] },
        }));
      }

      const requestedProfile = req.body?.emulatorProfile || null;
      const runtimeResult = await deviceRuntime.ensureRuntimeReady({
        serial: req.body?.deviceSerial || null,
        emulatorProfile: requestedProfile,
      });

      if (!runtimeResult.ok) {
        return res.status(503).json(buildError({
          message: 'Device runtime is not ready.',
          errorCode: runtimeResult.reason === 'device_not_ready' ? 'device_not_ready' : 'device_runtime_not_ready',
          reason: runtimeResult.reason,
          retryable: true,
          details: {
            warnings: startPolicy.warnings || [],
            emulatorProfile: requestedProfile,
          },
        }));
      }

      const deviceSerial = runtimeResult.deviceSerial;
      let proxyApplyStatus = { applied: false, reason: 'no_proxy' };

      if (startPolicy.proxy) {
        proxyApplyStatus = await applyDeviceLevelProxy({
          adb,
          deviceSerial,
          proxy: startPolicy.proxy,
          enabled: policy.rules.enableDeviceLevelApply,
        });
      }

      const flowResult = await whatsappFlow.driveToPhoneInput(deviceSerial, {
        maxSteps: Number(process.env.REGISTRATION_PHONE_MAX_STEPS || 12),
      });

      if (!flowResult.ok) {
        return res.status(409).json(buildError({
          message: 'Phone input screen could not be reached.',
          errorCode: 'otp_state_mismatch',
          reason: flowResult.reason,
          retryable: true,
          details: {
            traces: flowResult.traces,
            proxyKey: startPolicy.proxyKey || null,
            proxyWarnings: startPolicy.warnings || [],
            proxyApplyStatus,
          },
          phone,
          deviceSerial,
        }));
      }

      const now = toIso();
      sessions.set(phone, {
        ...(current || {}),
        phone,
        deviceSerial,
        emulatorProfile: runtimeResult.emulatorProfile || requestedProfile || null,
        status: 'otp_wait',
        startedAt: (current && current.startedAt) || now,
        updatedAt: now,
        verifiedAt: null,
        verifyAttempts: 0,
        lastVerifyAt: null,
        firstOtpAt: null,
        proxy: startPolicy.proxy || null,
        proxyKey: startPolicy.proxyKey || null,
        proxyCountryCode: (startPolicy.proxy && startPolicy.proxy.countryCode) || null,
        proxyWarnings: startPolicy.warnings || [],
        proxyApplyStatus,
        stabilityStatus: runtimeResult.stabilityStatus || null,
      });

      return res.json(buildSuccess({
        message: 'Registration started. OTP is expected on bound device.',
        phone,
        deviceSerial,
        emulatorProfile: runtimeResult.emulatorProfile || requestedProfile || null,
        state: flowResult.state,
        proxyKey: startPolicy.proxyKey || null,
        proxyWarnings: startPolicy.warnings || [],
        proxyApplyStatus,
        stabilityStatus: runtimeResult.stabilityStatus || null,
      }));
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'register_start_failed',
        reason: 'unexpected_error',
        retryable: true,
      }));
    }
  });

  app.post('/register/verify', async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      const otp = String(req.body?.otp || '').replace(/\D/g, '');

      if (!phone) {
        return res.status(400).json(buildError({
          message: 'phone is required.',
          errorCode: 'validation_error',
          reason: 'phone_required',
          retryable: false,
        }));
      }
      if (!otp) {
        return res.status(400).json(buildError({
          message: 'otp is required.',
          errorCode: 'validation_error',
          reason: 'otp_required',
          retryable: false,
        }));
      }

      const session = sessions.get(phone);
      if (!session) {
        return res.status(404).json(buildError({
          message: 'session_not_found',
          errorCode: 'session_not_found',
          reason: 'session_not_found',
          retryable: false,
          phone,
        }));
      }

      if (req.body?.deviceSerial && req.body.deviceSerial !== session.deviceSerial) {
        return res.status(409).json(buildError({
          message: 'device_mismatch',
          errorCode: 'device_not_ready',
          reason: 'device_mismatch',
          retryable: false,
          details: {
            expectedDeviceSerial: session.deviceSerial,
            providedDeviceSerial: req.body.deviceSerial,
          },
          phone,
          deviceSerial: session.deviceSerial,
        }));
      }

      if (req.body?.emulatorProfile && session.emulatorProfile && req.body.emulatorProfile !== session.emulatorProfile) {
        return res.status(409).json(buildError({
          message: 'emulator_profile_mismatch',
          errorCode: 'device_not_ready',
          reason: 'emulator_profile_mismatch',
          retryable: false,
          details: {
            expectedEmulatorProfile: session.emulatorProfile,
            providedEmulatorProfile: req.body.emulatorProfile,
          },
          phone,
          deviceSerial: session.deviceSerial,
        }));
      }

      if (session.emulatorProfile) {
        const emuStatus = await emulatorManager.status();
        if (!Array.isArray(emuStatus.runningProfiles) || !emuStatus.runningProfiles.includes(session.emulatorProfile)) {
          return res.status(503).json(buildError({
            message: 'Bound emulator profile is not running.',
            errorCode: 'device_not_ready',
            reason: 'emulator_profile_not_running',
            retryable: true,
            details: { expectedEmulatorProfile: session.emulatorProfile },
            phone,
            deviceSerial: session.deviceSerial,
          }));
        }
      }

      const verifyPolicy = policy.evaluateVerify({ payload: req.body || {}, session });
      if (!verifyPolicy.ok) {
        return res.status(409).json(buildError({
          message: 'proxy_policy_rejected',
          errorCode: 'proxy_policy_rejected',
          reason: verifyPolicy.reason,
          retryable: false,
          details: {
            warnings: verifyPolicy.warnings || [],
            expectedProxyKey: verifyPolicy.expectedProxyKey || session.proxyKey || null,
            providedProxyKey: verifyPolicy.providedProxyKey || null,
          },
          phone,
          deviceSerial: session.deviceSerial,
        }));
      }

      const nowMs = Date.now();
      if ((session.verifyAttempts || 0) >= verifyMaxAttempts) {
        return res.status(429).json(buildError({
          message: 'Verify attempt limit exceeded.',
          errorCode: 'verify_attempt_limit',
          reason: 'verify_attempt_limit',
          retryable: false,
          details: {
            maxAttempts: verifyMaxAttempts,
            verifyAttempts: session.verifyAttempts || 0,
          },
          phone,
          deviceSerial: session.deviceSerial,
        }));
      }

      if (session.lastVerifyAt && nowMs - toMs(session.lastVerifyAt) < verifyMinIntervalMs) {
        return res.status(429).json(buildError({
          message: 'Verify called too frequently.',
          errorCode: 'verify_too_frequent',
          reason: 'verify_too_frequent',
          retryable: true,
          details: {
            minIntervalMs: verifyMinIntervalMs,
            lastVerifyAt: session.lastVerifyAt,
          },
          phone,
          deviceSerial: session.deviceSerial,
        }));
      }

      const windowStartMs = session.firstOtpAt ? toMs(session.firstOtpAt) : nowMs;
      if (nowMs - windowStartMs > verifyWindowMs) {
        const expiredNow = toIso();
        sessions.set(phone, {
          ...session,
          status: 'expired',
          updatedAt: expiredNow,
        });

        return res.status(409).json(buildError({
          message: 'Verify window expired.',
          errorCode: 'verify_window_expired',
          reason: 'verify_window_expired',
          retryable: false,
          details: {
            verifyWindowMs,
            firstOtpAt: session.firstOtpAt || null,
          },
          phone,
          deviceSerial: session.deviceSerial,
        }));
      }

      const ready = await deviceRuntime.ensureReady(session.deviceSerial);
      if (!ready) {
        return res.status(503).json(buildError({
          message: 'Bound device is not ready.',
          errorCode: 'device_not_ready',
          reason: 'device_not_ready',
          retryable: true,
          phone,
          deviceSerial: session.deviceSerial,
        }));
      }

      const beforeEvidence = await whatsappFlow.captureEvidence(session.deviceSerial, `verify-before-${phone}`);
      if (!whatsappFlow.hasStrongOtpIndicators(beforeEvidence.xml)) {
        const now = toIso();
        const attemptCount = (session.verifyAttempts || 0) + 1;
        sessions.set(phone, {
          ...session,
          status: 'verify_pending',
          updatedAt: now,
          verifyAttempts: attemptCount,
          lastVerifyAt: now,
          firstOtpAt: session.firstOtpAt || now,
          proxyWarnings: verifyPolicy.warnings || session.proxyWarnings || [],
        });

        return res.status(409).json(buildError({
          message: 'OTP screen is not confidently detected.',
          errorCode: 'otp_state_mismatch',
          reason: 'otp_state_mismatch',
          retryable: true,
          details: {
            state: beforeEvidence.state,
            signals: whatsappFlow.stateSignals(beforeEvidence.xml),
            before: {
              uiXmlPath: beforeEvidence.uiXmlPath,
              screenshotPath: beforeEvidence.screenshotPath,
            },
          },
          phone,
          deviceSerial: session.deviceSerial,
          state: beforeEvidence.state,
          uiXmlPath: beforeEvidence.uiXmlPath,
          screenshotPath: beforeEvidence.screenshotPath,
        }));
      }

      for (const digit of otp) {
        await adb.shell(session.deviceSerial, ['input', 'text', digit]);
        await sleep(120);
      }

      const homeWait = await whatsappFlow.waitForStrongHomeState(session.deviceSerial, {
        timeoutMs: Number(process.env.HOME_WAIT_MS || 20000),
        pollMs: Number(process.env.HOME_WAIT_POLL_MS || 1000),
        evidenceLabelPrefix: `verify-after-${phone}`,
      });
      const afterEvidence = homeWait.evidence;
      const verified = Boolean(homeWait.confirmed && afterEvidence && whatsappFlow.hasStrongHomeIndicators(afterEvidence.xml));

      const now = toIso();
      const attemptCount = (session.verifyAttempts || 0) + 1;
      const nextSession = {
        ...session,
        status: verified ? 'verified' : 'verify_pending',
        updatedAt: now,
        verifiedAt: verified ? now : session.verifiedAt || null,
        verifyAttempts: attemptCount,
        lastVerifyAt: now,
        firstOtpAt: session.firstOtpAt || now,
        proxyWarnings: verifyPolicy.warnings || session.proxyWarnings || [],
      };
      sessions.set(phone, nextSession);

      if (!verified) {
        return res.status(409).json(buildError({
          message: 'OTP submitted but home screen is not strongly confirmed yet.',
          errorCode: 'home_not_confirmed',
          reason: 'home_not_confirmed',
          retryable: true,
          details: {
            before: {
              state: beforeEvidence.state,
              uiXmlPath: beforeEvidence.uiXmlPath,
              screenshotPath: beforeEvidence.screenshotPath,
            },
            after: afterEvidence
              ? {
                  state: afterEvidence.state,
                  signals: whatsappFlow.stateSignals(afterEvidence.xml),
                  uiXmlPath: afterEvidence.uiXmlPath,
                  screenshotPath: afterEvidence.screenshotPath,
                }
              : null,
          },
          phone,
          deviceSerial: session.deviceSerial,
          state: afterEvidence?.state || null,
          uiXmlPath: afterEvidence?.uiXmlPath || null,
          screenshotPath: afterEvidence?.screenshotPath || null,
        }));
      }

      return res.json(buildSuccess({
        message: 'OTP verified and home screen strongly detected.',
        phone,
        deviceSerial: session.deviceSerial,
        emulatorProfile: session.emulatorProfile || null,
        state: whatsappFlow.STATE.HOME,
        verifyAttempts: attemptCount,
        uiXmlPath: afterEvidence?.uiXmlPath || null,
        screenshotPath: afterEvidence?.screenshotPath || null,
        details: {
          before: {
            state: beforeEvidence.state,
            uiXmlPath: beforeEvidence.uiXmlPath,
            screenshotPath: beforeEvidence.screenshotPath,
          },
          after: afterEvidence
            ? {
                state: afterEvidence.state,
                signals: whatsappFlow.stateSignals(afterEvidence.xml),
                uiXmlPath: afterEvidence.uiXmlPath,
                screenshotPath: afterEvidence.screenshotPath,
              }
            : null,
        },
        proxyKey: session.proxyKey || null,
        proxyWarnings: verifyPolicy.warnings || session.proxyWarnings || [],
      }));
    } catch (error) {
      return res.status(500).json(buildError({
        message: error.message,
        errorCode: 'register_verify_failed',
        reason: 'unexpected_error',
        retryable: true,
      }));
    }
  });

  function listen() {
    return app.listen(port, () => {
      console.log(`[registrar] listening on :${port}`);
    });
  }

  return {
    app,
    sessions,
    listen,
    purgeExpiredSessions,
    deps: {
      adb,
      emulatorManager,
      deviceRuntime,
      whatsappFlow,
      policy,
    },
  };
}

module.exports = { createRegistrarServer };
