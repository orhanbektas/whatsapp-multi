function parseProfilePool(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function createEmulatorManager({
  clock = () => new Date().toISOString(),
  profilePool = parseProfilePool(process.env.EMULATOR_PROFILE_POOL),
  strategy = String(process.env.EMULATOR_PROFILE_STRATEGY || 'sticky').toLowerCase(),
} = {}) {
  const state = {
    selectedProfile: null,
    lastStartAt: null,
    lastStopAt: null,
    runningProfiles: new Set(),
    roundRobinIndex: 0,
  };

  function normalizeProfile(profileName) {
    const trimmed = String(profileName || '').trim();
    return trimmed || null;
  }

  function isKnownProfile(profileName) {
    if (!profilePool.length) return true;
    return profilePool.includes(profileName);
  }

  function nextRoundRobinProfile() {
    if (!profilePool.length) return null;
    const idx = state.roundRobinIndex % profilePool.length;
    const profile = profilePool[idx];
    state.roundRobinIndex = (idx + 1) % profilePool.length;
    return profile;
  }

  function pickProfile(explicitProfile = null) {
    const manual = normalizeProfile(explicitProfile);
    if (manual) return manual;

    if (strategy === 'round_robin') {
      return nextRoundRobinProfile() || state.selectedProfile;
    }

    return state.selectedProfile;
  }

  async function listProfiles() {
    return profilePool.map((name) => ({
      name,
      selected: state.selectedProfile === name,
      running: state.runningProfiles.has(name),
    }));
  }

  async function status() {
    return {
      selectedProfile: state.selectedProfile,
      runningProfiles: Array.from(state.runningProfiles),
      lastStartAt: state.lastStartAt,
      lastStopAt: state.lastStopAt,
      strategy,
      profilePool,
      roundRobinIndex: state.roundRobinIndex,
    };
  }

  async function select(profileName) {
    const target = normalizeProfile(profileName);
    if (target && !isKnownProfile(target)) {
      return { ok: false, reason: 'profile_not_allowed', profile: target, profilePool };
    }

    state.selectedProfile = target;
    return { ok: true, selectedProfile: state.selectedProfile };
  }

  async function start(profileName) {
    const target = pickProfile(profileName);
    if (!target) {
      return { ok: false, reason: 'profile_required', strategy, profilePool };
    }

    if (!isKnownProfile(target)) {
      return { ok: false, reason: 'profile_not_allowed', profile: target, profilePool };
    }

    state.runningProfiles.add(target);
    state.selectedProfile = target;
    state.lastStartAt = clock();

    return {
      ok: true,
      profile: target,
      startedAt: state.lastStartAt,
      strategy,
    };
  }

  async function stop(profileName) {
    const target = normalizeProfile(profileName) || state.selectedProfile;
    if (!target) {
      return { ok: false, reason: 'profile_required' };
    }

    state.runningProfiles.delete(target);
    state.lastStopAt = clock();

    return {
      ok: true,
      profile: target,
      stoppedAt: state.lastStopAt,
    };
  }

  async function ensureActive({ emulatorProfile } = {}) {
    const target = pickProfile(emulatorProfile);
    if (!target) {
      return { ok: true, skipped: true, reason: 'no_profile_selected', strategy };
    }

    if (!isKnownProfile(target)) {
      return { ok: false, reason: 'profile_not_allowed', profile: target, profilePool, strategy };
    }

    if (!state.runningProfiles.has(target)) {
      const started = await start(target);
      return { ...started, emulatorProfile: started.profile || null };
    }

    state.selectedProfile = target;
    return { ok: true, alreadyRunning: true, profile: target, emulatorProfile: target, strategy };
  }

  return {
    listProfiles,
    status,
    select,
    start,
    stop,
    ensureActive,
  };
}

module.exports = { createEmulatorManager };
