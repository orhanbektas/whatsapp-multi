const { createAdb } = require('./adb');
const { createEmulatorManager } = require('./emulator/manager');

function boolFromEnv(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function createDeviceRuntime({
  adb = createAdb(),
  emulatorManager = createEmulatorManager(),
  deviceMode = process.env.REGISTRAR_DEVICE_MODE || 'legacy',
  readyTimeoutMs = Number(process.env.REGISTRAR_DEVICE_READY_TIMEOUT_MS || 30000),
  pollIntervalMs = Number(process.env.REGISTRAR_DEVICE_READY_POLL_MS || 1000),
  applyStability = boolFromEnv(process.env.REGISTRAR_APPLY_STABILITY_SETTINGS, false),
  stabilityTimezone = process.env.REGISTRAR_STABILITY_TIMEZONE || '',
  stabilityLocale = process.env.REGISTRAR_STABILITY_LOCALE || '',
  stabilityDisableAnimations = boolFromEnv(process.env.REGISTRAR_STABILITY_DISABLE_ANIMATIONS, true),
  stabilityStayAwake = boolFromEnv(process.env.REGISTRAR_STABILITY_STAY_AWAKE, true),
} = {}) {
  async function listDevices() {
    return adb.listDevices();
  }

  function matchDevice(device, criteria = {}) {
    if (criteria.serial && device.serial !== criteria.serial) return false;
    if (criteria.state && device.state !== criteria.state) return false;
    if (criteria.serialPrefix && !String(device.serial || '').startsWith(criteria.serialPrefix)) return false;
    return true;
  }

  async function selectDevice(criteria = {}) {
    const devices = await listDevices();

    const online = devices.filter((d) => d.state === 'device');
    const candidates = (online.length ? online : devices).filter((d) => matchDevice(d, criteria));

    if (!candidates.length) {
      return null;
    }

    const selected = candidates[0];
    adb.setDefaultDevice(selected.serial);
    return selected;
  }

  async function ensureReady(serial) {
    const targetSerial = serial || adb.getDefaultDevice();
    if (!targetSerial) {
      throw new Error('ensureReady requires device serial or previously selected default device.');
    }

    adb.setDefaultDevice(targetSerial);
    await adb.connect(targetSerial);

    const deadline = Date.now() + readyTimeoutMs;

    while (Date.now() < deadline) {
      if (await adb.deviceReady(targetSerial)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return false;
  }

  let lastStabilityStatus = {
    applied: false,
    reason: applyStability ? 'pending' : 'not_configured',
    updatedAt: null,
    settings: {
      timezone: stabilityTimezone || null,
      locale: stabilityLocale || null,
      disableAnimations: stabilityDisableAnimations,
      stayAwake: stabilityStayAwake,
    },
    actions: [],
  };

  async function runStabilityAction(deviceSerial, key, args) {
    try {
      await adb.shell(deviceSerial, args);
      return { key, ok: true, command: args.join(' ') };
    } catch (error) {
      return { key, ok: false, command: args.join(' '), error: error.message };
    }
  }

  async function applyStabilitySettings(deviceSerial) {
    if (!applyStability) {
      const status = {
        applied: false,
        reason: 'not_configured',
        updatedAt: new Date().toISOString(),
        settings: {
          timezone: stabilityTimezone || null,
          locale: stabilityLocale || null,
          disableAnimations: stabilityDisableAnimations,
          stayAwake: stabilityStayAwake,
        },
        actions: [],
      };
      lastStabilityStatus = status;
      return status;
    }

    const actions = [];

    if (stabilityTimezone) {
      actions.push(await runStabilityAction(deviceSerial, 'timezone', ['setprop', 'persist.sys.timezone', stabilityTimezone]));
    }

    if (stabilityLocale) {
      const normalizedLocale = String(stabilityLocale).replace('-', '_');
      actions.push(await runStabilityAction(deviceSerial, 'locale', ['setprop', 'persist.sys.locale', normalizedLocale]));
    }

    if (stabilityDisableAnimations) {
      actions.push(await runStabilityAction(deviceSerial, 'animator_duration_scale', ['settings', 'put', 'global', 'animator_duration_scale', '0']));
      actions.push(await runStabilityAction(deviceSerial, 'transition_animation_scale', ['settings', 'put', 'global', 'transition_animation_scale', '0']));
      actions.push(await runStabilityAction(deviceSerial, 'window_animation_scale', ['settings', 'put', 'global', 'window_animation_scale', '0']));
    }

    if (stabilityStayAwake) {
      actions.push(await runStabilityAction(deviceSerial, 'stay_on_while_plugged_in', ['settings', 'put', 'global', 'stay_on_while_plugged_in', '3']));
    }

    const hasFailed = actions.some((x) => !x.ok);
    const status = {
      applied: !hasFailed,
      reason: hasFailed ? 'partial_apply' : 'applied',
      updatedAt: new Date().toISOString(),
      settings: {
        timezone: stabilityTimezone || null,
        locale: stabilityLocale || null,
        disableAnimations: stabilityDisableAnimations,
        stayAwake: stabilityStayAwake,
      },
      actions,
    };
    lastStabilityStatus = status;
    return status;
  }

  async function ensureRuntimeReady(criteria = {}) {
    let emulatorProfile = criteria.emulatorProfile || null;
    if (deviceMode === 'emulator_manager') {
      const emu = await emulatorManager.ensureActive(criteria);
      if (emu && emu.ok === false) {
        return {
          ok: false,
          reason: emu.reason || 'emulator_not_ready',
          emulatorProfile: emu.profile || emulatorProfile,
          emulatorDetails: emu,
        };
      }
      emulatorProfile = emu?.emulatorProfile || emu?.profile || emulatorProfile;
    }

    const selected = await selectDevice(criteria);
    if (!selected) return { ok: false, reason: 'device_not_found', emulatorProfile };

    const ready = await ensureReady(selected.serial);
    if (!ready) return { ok: false, reason: 'device_not_ready', deviceSerial: selected.serial, emulatorProfile };

    const stabilityStatus = await applyStabilitySettings(selected.serial);

    return {
      ok: true,
      mode: deviceMode,
      deviceSerial: selected.serial,
      emulatorProfile,
      stabilityStatus,
    };
  }

  function getStabilityStatus() {
    return lastStabilityStatus;
  }

  return {
    deviceMode,
    listDevices,
    selectDevice,
    ensureReady,
    ensureRuntimeReady,
    getStabilityStatus,
  };
}

module.exports = { createDeviceRuntime };
