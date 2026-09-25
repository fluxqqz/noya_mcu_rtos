/**
 * NOYA — ESP32 RTOS Control Panel Frontend Integration
 * Responsive, accessible, dependency-free controller for live MCU firmware and file:// preview.
 */

// ─── PURE CONFIGURATION & VALIDATION ────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  openAngle: 30,
  closeAngle: 85,
  holdMs: 200,
});

const DEFAULT_PRESETS = Object.freeze([30, 85]);

/**
 * Validates sequence parameters.
 * Requirements: integer angles (0-180), distinct angles, hold 50-5000ms.
 * Repeat interval setting has been removed per firmware contract.
 */
function validateSettings(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    return { valid: false, error: 'Invalid configuration object' };
  }

  const openAngle = Number(cfg.openAngle);
  const closeAngle = Number(cfg.closeAngle);
  const holdMs = Number(cfg.holdMs);

  if (!Number.isInteger(openAngle) || openAngle < 0 || openAngle > 180) {
    return { valid: false, error: 'Open angle must be an integer between 0° and 180°' };
  }
  if (!Number.isInteger(closeAngle) || closeAngle < 0 || closeAngle > 180) {
    return { valid: false, error: 'Close angle must be an integer between 0° and 180°' };
  }
  if (openAngle === closeAngle) {
    return { valid: false, error: 'Open and Close angles must be distinct' };
  }
  if (!Number.isInteger(holdMs) || holdMs < 50 || holdMs > 5000) {
    return { valid: false, error: 'Hold delay must be an integer between 50 ms and 5000 ms' };
  }

  return {
    valid: true,
    error: null,
    values: { openAngle, closeAngle, holdMs },
  };
}

/**
 * Validates manual servo angle command.
 * Requirements: integer in range 0..180.
 * Rejects blank, non-integer, decimals, scientific notation, and out-of-range values.
 * Avoids Number('') === 0 false positives.
 */
function validateServoAngle(input) {
  if (input === null || input === undefined) {
    return { valid: false, error: 'Angle cannot be blank' };
  }
  const str = String(input).trim();
  if (str === '') {
    return { valid: false, error: 'Angle cannot be blank' };
  }
  if (!/^[+-]?\d+$/.test(str)) {
    return { valid: false, error: 'Angle must be an integer between 0° and 180°' };
  }
  const num = Number(str);
  if (!Number.isInteger(num)) {
    return { valid: false, error: 'Angle must be an integer between 0° and 180°' };
  }
  if (num < 0 || num > 180) {
    return { valid: false, error: 'Angle must be between 0° and 180°' };
  }
  return { valid: true, error: null, value: num === 0 ? 0 : num };
}

/**
 * Formats an object into application/x-www-form-urlencoded string.
 */
function serializeFormUrlEncoded(data) {
  if (!data || typeof data !== 'object') return '';
  return new URLSearchParams(data).toString();
}

/**
 * Creates a clean default application state object.
 */
function createAppState(initial = {}) {
  return {
    connected: false,
    mode: 'manual', // 'manual' | 'auto'
    paused: false,
    config: { ...DEFAULT_CONFIG },
    sequenceDirty: false,
    servos: {
      1: { angle: 30, running: false, phase: 'idle', statusText: 'IDLE', timer: null, presets: [...DEFAULT_PRESETS] },
      2: { angle: 30, running: false, phase: 'idle', statusText: 'IDLE', timer: null, presets: [...DEFAULT_PRESETS] },
    },
    relays: {
      1: false,
      2: false,
    },
    device: {
      uptime: 0,
      freeHeap: 0,
      chipModel: 'ESP32 RTOS',
      staIp: 'disconnected',
      apIp: '192.168.10.1',
      mdns: 'mcu-eye-monster',
      wifiConnected: false,
      otaAuth: 'none (preexisting limitation)',
    },
    lastError: null,
    ...initial,
  };
}

/**
 * Synchronizes hardware status payload into application state.
 * Returns true if successfully parsed, false if malformed.
 */
function applyStatusToState(state, data) {
  if (!data || typeof data !== 'object') return false;

  state.mode = data.mode === 'auto' ? 'auto' : 'manual';
  state.paused = Boolean(data.paused);
  state.device.uptime = Number(data.uptime) || 0;
  state.device.freeHeap = Number(data.free_heap) || 0;
  state.device.chipModel = data.chip_model || 'ESP32 RTOS';
  state.device.wifiConnected = Boolean(data.wifi_connected);
  state.device.staIp = data.sta_ip || 'disconnected';
  state.device.apIp = data.ap_ip || '192.168.10.1';
  state.device.mdns = data.mdns || 'mcu-eye-monster';
  state.device.otaAuth = data.ota_auth || 'none (preexisting limitation)';

  if (Array.isArray(data.servos)) {
    data.servos.forEach((s) => {
      if (s && (s.id === 1 || s.id === 2)) {
        state.servos[s.id].angle = Number(s.angle) || 0;
        state.servos[s.id].running = Boolean(s.running);
        state.servos[s.id].phase = s.phase || 'idle';
        state.servos[s.id].statusText = s.status || '';
      }
    });
  }

  if (Array.isArray(data.relays)) {
    data.relays.forEach((r) => {
      if (r && (r.id === 1 || r.id === 2)) {
        state.relays[r.id] = r.state === 1;
      }
    });
  }

  if (data.sequence && typeof data.sequence === 'object') {
    state.config.openAngle = data.sequence.open_deg;
    state.config.closeAngle = data.sequence.close_deg;
    state.config.holdMs = data.sequence.hold_ms;
  }

  return true;
}

/**
 * Dispatches a POST mutation with form-urlencoded payload and X-Requested-With header.
 * Guarded against duplicate in-flight requests and bounded by timeout.
 */
async function postApiCommand(endpoint, params = {}, actionKey = null, pendingSet = new Set(), fetchFn = globalThis.fetch, timeoutMs = 4000) {
  if (actionKey) {
    if (pendingSet.has(actionKey)) return { ok: false, duplicate: true };
    pendingSet.add(actionKey);
  }

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const bodyStr = serializeFormUrlEncoded(params);
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: bodyStr,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return { ok: true, data };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Request timed out' : (err.message || 'Network error');
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timerId);
    if (actionKey) {
      pendingSet.delete(actionKey);
    }
  }
}

/**
 * Polls status from GET /api/status with timeout.
 */
async function fetchStatus(fetchFn = globalThis.fetch, timeoutMs = 3000) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn('/api/status', {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out' : (err.message || 'Offline');
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Starts continuous open->hold->close->hold alternating sequence.
 * Used for file:// simulation ONLY.
 */
function startServoRunner(servo, config, onUpdate, timerOps = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (id) => globalThis.clearTimeout(id),
}) {
  if (servo.timer) {
    timerOps.clearTimeout(servo.timer);
    servo.timer = null;
  }
  servo.running = true;
  servo.phase = 'open';
  servo.angle = config.openAngle;
  servo.statusText = 'OPEN';
  if (typeof onUpdate === 'function') onUpdate(servo);

  function next() {
    if (!servo.running) return;
    servo.phase = servo.phase === 'open' ? 'close' : 'open';
    servo.angle = servo.phase === 'open' ? config.openAngle : config.closeAngle;
    servo.statusText = servo.phase === 'open' ? 'OPEN' : 'CLOSE';
    if (typeof onUpdate === 'function') onUpdate(servo);
    servo.timer = timerOps.setTimeout(next, config.holdMs);
  }

  servo.timer = timerOps.setTimeout(next, config.holdMs);
}

/**
 * Stops continuous sequence on a servo.
 * Cancels timer, holds current angle, and clears running state.
 * Used for file:// simulation ONLY.
 */
function stopServoRunner(servo, onUpdate, timerOps = {
  clearTimeout: (id) => globalThis.clearTimeout(id),
}) {
  if (servo.timer) {
    timerOps.clearTimeout(servo.timer);
    servo.timer = null;
  }
  servo.running = false;
  servo.phase = 'idle';
  servo.statusText = null;
  if (typeof onUpdate === 'function') onUpdate(servo);
}

// ─── BROWSER APPLICATION RUNTIME ────────────────────────────────────────────

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const isFilePreview = window.location.protocol === 'file:';

    // Application State
    const state = createAppState({ connected: isFilePreview });
    const pendingActions = new Set();
    function isPending(actionKey) {
      return pendingActions.has(actionKey);
    }

    // DOM Elements Cache
    const dom = {
      appAlert: document.getElementById('app-alert'),
      appAlertText: document.getElementById('app-alert-text'),
      appAlertDismiss: document.getElementById('app-alert-dismiss'),
      demoBanner: document.getElementById('demo-banner'),

      btnModeManual: document.getElementById('btn-mode-manual'),
      btnModeAuto: document.getElementById('btn-mode-auto'),
      btnPauseSim: document.getElementById('btn-pause-sim'),
      statMode: document.getElementById('stat-mode'),
      statSim: document.getElementById('stat-sim'),
      statAutoDue: document.getElementById('stat-auto-due'),

      servo1Angle: document.getElementById('servo-1-angle'),
      servo1Slider: document.getElementById('servo-1-slider'),
      servo1Number: document.getElementById('servo-1-number'),
      servo1Preset1Btn: document.getElementById('servo-1-preset-1'),
      servo1Preset2Btn: document.getElementById('servo-1-preset-2'),
      servo1PresetVal1: document.getElementById('servo-1-preset-val-1'),
      servo1PresetVal2: document.getElementById('servo-1-preset-val-2'),
      servo1Preset1Err: document.getElementById('servo-1-preset-1-error'),
      servo1Preset2Err: document.getElementById('servo-1-preset-2-error'),
      servo1Error: document.getElementById('servo-1-error'),
      servo1Status: document.getElementById('servo-1-status'),
      servo1Run: document.getElementById('servo-1-run'),
      servo1ManualBadge: document.getElementById('servo-1-manual-badge'),

      servo2Angle: document.getElementById('servo-2-angle'),
      servo2Slider: document.getElementById('servo-2-slider'),
      servo2Number: document.getElementById('servo-2-number'),
      servo2Preset1Btn: document.getElementById('servo-2-preset-1'),
      servo2Preset2Btn: document.getElementById('servo-2-preset-2'),
      servo2PresetVal1: document.getElementById('servo-2-preset-val-1'),
      servo2PresetVal2: document.getElementById('servo-2-preset-val-2'),
      servo2Preset1Err: document.getElementById('servo-2-preset-1-error'),
      servo2Preset2Err: document.getElementById('servo-2-preset-2-error'),
      servo2Error: document.getElementById('servo-2-error'),
      servo2Status: document.getElementById('servo-2-status'),
      servo2Run: document.getElementById('servo-2-run'),
      servo2ManualBadge: document.getElementById('servo-2-manual-badge'),

      relay1Toggle: document.getElementById('relay-1-toggle'),
      relay1Text: document.getElementById('relay-1-text'),
      relay2Toggle: document.getElementById('relay-2-toggle'),
      relay2Text: document.getElementById('relay-2-text'),

      settingsForm: document.getElementById('settings-form'),
      cfgOpen: document.getElementById('cfg-open'),
      cfgClose: document.getElementById('cfg-close'),
      cfgHold: document.getElementById('cfg-hold'),
      settingsFeedback: document.getElementById('settings-feedback'),
      btnResetSettings: document.getElementById('btn-reset-settings'),
      btnSaveSettings: document.getElementById('btn-save-settings'),

      infoChip: document.getElementById('info-chip'),
      infoFw: document.getElementById('info-fw'),
      infoConnMode: document.getElementById('info-conn-mode'),
      infoUptime: document.getElementById('info-uptime'),
      infoHeap: document.getElementById('info-heap'),
      infoSta: document.getElementById('info-sta'),
      infoAp: document.getElementById('info-ap'),
      infoMdns: document.getElementById('info-mdns'),
      infoOtaAuth: document.getElementById('info-ota-auth'),
      otaLink: document.getElementById('ota-link'),
    };

    // ── Accessible Error Display ──

    function showError(msg) {
      if (dom.appAlert && dom.appAlertText) {
        dom.appAlertText.textContent = msg;
        dom.appAlert.style.display = 'flex';
      }
    }

    function clearError() {
      if (dom.appAlert) {
        dom.appAlert.style.display = 'none';
        if (dom.appAlertText) dom.appAlertText.textContent = '';
      }
    }

    if (dom.appAlertDismiss) {
      dom.appAlertDismiss.addEventListener('click', clearError);
    }

    // ── UI Rendering Helpers ──

    function formatUptime(seconds) {
      const s = Number(seconds) || 0;
      const hrs = Math.floor(s / 3600);
      const mins = Math.floor((s % 3600) / 60);
      const secs = s % 60;
      if (hrs > 0) {
        return `${hrs}h ${mins}m ${secs}s`;
      }
      return `${mins}m ${secs}s`;
    }

    function updateServoUI(id) {
      const s = state.servos[id];
      const isS1 = id === 1;
      const angleElem = isS1 ? dom.servo1Angle : dom.servo2Angle;
      const sliderElem = isS1 ? dom.servo1Slider : dom.servo2Slider;
      const numberElem = isS1 ? dom.servo1Number : dom.servo2Number;
      const errorElem = isS1 ? dom.servo1Error : dom.servo2Error;
      const statusElem = isS1 ? dom.servo1Status : dom.servo2Status;

      angleElem.textContent = `${s.angle}°`;

      // Avoid overwriting focused or actively edited angle inputs
      if (document.activeElement !== sliderElem) {
        sliderElem.value = s.angle;
      }
      if (document.activeElement !== numberElem && !numberElem.classList.contains('is-dirty')) {
        numberElem.value = s.angle;
        numberElem.classList.remove('is-invalid');
        numberElem.removeAttribute('aria-invalid');
        errorElem.textContent = '';
      }

      if (state.paused) {
        statusElem.className = 'status-pill pill-paused';
        statusElem.textContent = 'PAUSED';
      } else if (s.running) {
        statusElem.className = 'status-pill pill-running';
        statusElem.textContent = (s.phase || s.statusText || 'OPEN').toUpperCase();
      } else {
        statusElem.className = 'status-pill pill-idle';
        statusElem.textContent = 'IDLE';
      }
    }

    function updateRelayUI(id) {
      const on = state.relays[id];
      const toggle = id === 1 ? dom.relay1Toggle : dom.relay2Toggle;
      const label = id === 1 ? dom.relay1Text : dom.relay2Text;

      toggle.checked = on;
      toggle.setAttribute('aria-checked', String(on));
      label.textContent = on ? 'ON' : 'OFF';
      label.className = `relay-state ${on ? 'state-on' : ''}`;
    }

    function updateControlsDisabledState() {
      const isConnected = state.connected;
      const isPaused = state.paused;
      const isAuto = state.mode === 'auto';

      // Mode & Pause buttons
      dom.btnModeManual.disabled = !isConnected || isPending('mode');
      dom.btnModeAuto.disabled = !isConnected || isPending('mode');
      dom.btnPauseSim.disabled = !isConnected || isPending('pause');

      // Servo cards
      for (const id of [1, 2]) {
        const s = state.servos[id];
        const isS1 = id === 1;
        const slider = isS1 ? dom.servo1Slider : dom.servo2Slider;
        const number = isS1 ? dom.servo1Number : dom.servo2Number;
        const p1Btn = isS1 ? dom.servo1Preset1Btn : dom.servo2Preset1Btn;
        const p2Btn = isS1 ? dom.servo1Preset2Btn : dom.servo2Preset2Btn;
        const pVal1 = isS1 ? dom.servo1PresetVal1 : dom.servo2PresetVal1;
        const pVal2 = isS1 ? dom.servo1PresetVal2 : dom.servo2PresetVal2;
        const runBtn = isS1 ? dom.servo1Run : dom.servo2Run;
        const badge = isS1 ? dom.servo1ManualBadge : dom.servo2ManualBadge;

        // Manual controls disabled if offline, paused, auto mode, running, or action pending
        const manualLocked = !isConnected || isPaused || isAuto || s.running || isPending(`servo:${id}`) || isPending(`run:${id}`);
        slider.disabled = manualLocked;
        number.disabled = manualLocked;
        p1Btn.disabled = manualLocked;
        p2Btn.disabled = manualLocked;
        pVal1.disabled = manualLocked;
        pVal2.disabled = manualLocked;

        // Start/Stop sequence allowed in Manual OR Auto; disabled if offline, paused, or pending
        runBtn.disabled = !isConnected || isPaused || isPending(`run:${id}`);
        runBtn.textContent = s.running ? 'Stop sequence' : 'Start sequence';
        runBtn.setAttribute('aria-label', `${s.running ? 'Stop' : 'Start'} sequence for Servo ${id}`);
        runBtn.classList.toggle('btn-stop', s.running);

        if (!isConnected) {
          badge.textContent = '(Connecting...)';
        } else if (isPaused) {
          badge.textContent = '(Paused)';
        } else if (isAuto) {
          badge.textContent = '(Locked in Auto)';
        } else if (s.running) {
          badge.textContent = '(Sequence running)';
        } else {
          badge.textContent = '(Manual only)';
        }
      }

      // Relays
      const r1Locked = !isConnected || isPaused || isPending('relay:1');
      const r2Locked = !isConnected || isPaused || isPending('relay:2');
      dom.relay1Toggle.disabled = r1Locked;
      dom.relay2Toggle.disabled = r2Locked;

      // Settings form
      const settingsLocked = !isConnected || isPending('sequence') || isPending('sequence_reset');
      dom.cfgOpen.disabled = settingsLocked;
      dom.cfgClose.disabled = settingsLocked;
      dom.cfgHold.disabled = settingsLocked;
      dom.btnResetSettings.disabled = settingsLocked;
      if (dom.btnSaveSettings) dom.btnSaveSettings.disabled = settingsLocked;
    }

    function updateStatusBar() {
      if (!state.connected) {
        dom.statMode.textContent = 'OFFLINE';
        dom.statSim.textContent = 'DISCONNECTED';
        dom.statSim.className = 'cell-val text-muted';
        dom.statAutoDue.textContent = isFilePreview ? 'Simulation Stopped' : 'Connecting to MCU...';
        return;
      }

      dom.statMode.textContent = state.mode.toUpperCase();
      if (state.paused) {
        dom.statSim.textContent = 'PAUSED';
        dom.statSim.className = 'cell-val text-muted';
        dom.statAutoDue.textContent = 'Suspended (Paused)';
      } else {
        dom.statSim.textContent = isFilePreview ? 'ACTIVE (SIM)' : 'CONNECTED';
        dom.statSim.className = 'cell-val text-teal';

        const s1 = state.servos[1];
        const s2 = state.servos[2];
        if (s1.running && s2.running) {
          dom.statAutoDue.textContent = `Running (S1: ${s1.phase || s1.statusText}, S2: ${s2.phase || s2.statusText})`;
        } else if (s1.running) {
          dom.statAutoDue.textContent = `Running (Servo 1: ${s1.phase || s1.statusText})`;
        } else if (s2.running) {
          dom.statAutoDue.textContent = `Running (Servo 2: ${s2.phase || s2.statusText})`;
        } else if (state.mode === 'manual') {
          dom.statAutoDue.textContent = 'Standby (Manual)';
        } else {
          dom.statAutoDue.textContent = 'Standby (Auto idle)';
        }
      }
    }

    function syncSettingsFromStatus(seq) {
      if (!seq || typeof seq !== 'object') return;
      state.config.openAngle = seq.open_deg;
      state.config.closeAngle = seq.close_deg;
      state.config.holdMs = seq.hold_ms;

      const isFocused = document.activeElement === dom.cfgOpen ||
                        document.activeElement === dom.cfgClose ||
                        document.activeElement === dom.cfgHold;
      if (!isFocused && !state.sequenceDirty) {
        dom.cfgOpen.value = seq.open_deg;
        dom.cfgClose.value = seq.close_deg;
        dom.cfgHold.value = seq.hold_ms;
      }
    }

    function updateDeviceInfoUI(data) {
      if (!data) return;
      if (dom.infoChip) dom.infoChip.textContent = data.chip_model || 'ESP32 RTOS';
      if (dom.infoUptime) dom.infoUptime.textContent = formatUptime(data.uptime);
      if (dom.infoHeap) dom.infoHeap.textContent = `${Number(data.free_heap || 0).toLocaleString()} bytes`;
      if (dom.infoSta) dom.infoSta.textContent = `${data.sta_ip || 'disconnected'} (${data.wifi_connected ? 'Connected' : 'Disconnected'})`;
      if (dom.infoAp) dom.infoAp.textContent = data.ap_ip || '192.168.10.1';
      if (dom.infoMdns) dom.infoMdns.textContent = `http://${data.mdns || 'mcu-eye-monster'}.local`;
      if (dom.infoConnMode) dom.infoConnMode.textContent = isFilePreview ? 'Offline preview (file:// protocol)' : 'Live Hardware (HTTP Polling: 1s)';
    }

    async function executeApiPost(endpoint, params, actionKey) {
      const res = await postApiCommand(endpoint, params, actionKey, pendingActions, window.fetch);
      updateControlsDisabledState();
      if (!res.ok) {
        if (!res.duplicate) {
          showError(`Command failed (${endpoint}): ${res.error}`);
        }
      } else {
        clearError();
      }
      return res;
    }

    let pollInFlight = false;
    async function pollStatus() {
      if (isFilePreview || pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await fetchStatus(window.fetch);
        if (res.ok) {
          applyStatusToState(state, res.data);

          const isAuto = state.mode === 'auto';
          dom.btnModeAuto.classList.toggle('active', isAuto);
          dom.btnModeAuto.setAttribute('aria-pressed', String(isAuto));
          dom.btnModeManual.classList.toggle('active', !isAuto);
          dom.btnModeManual.setAttribute('aria-pressed', String(!isAuto));

          dom.btnPauseSim.textContent = state.paused ? 'Resume' : 'Pause';
          dom.btnPauseSim.classList.toggle('paused', state.paused);
          dom.btnPauseSim.setAttribute('aria-pressed', String(state.paused));

          updateServoUI(1);
          updateServoUI(2);
          updateRelayUI(1);
          updateRelayUI(2);
          syncSettingsFromStatus(res.data.sequence);
          updateDeviceInfoUI(res.data);

          if (!state.connected) {
            state.connected = true;
            clearError();
          }
        } else {
          if (state.connected) {
            state.connected = false;
            showError(`Device disconnected (${res.error}). Reconnecting...`);
          }
        }
      } finally {
        pollInFlight = false;
        updateControlsDisabledState();
        updateStatusBar();
      }
    }

    // ── Simulation Handlers (file:// protocol) ──

    function startServoSim(id) {
      if (state.paused) return;
      startServoRunner(state.servos[id], state.config, () => {
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
      });
    }

    function stopServoSim(id) {
      stopServoRunner(state.servos[id], () => {
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
      });
    }

    // ── User Interaction Handlers ──

    async function setMode(newMode) {
      if (!state.connected || isPending('mode') || state.mode === newMode) return;

      if (isFilePreview) {
        state.mode = newMode;
        const isAuto = newMode === 'auto';
        dom.btnModeAuto.classList.toggle('active', isAuto);
        dom.btnModeAuto.setAttribute('aria-pressed', String(isAuto));
        dom.btnModeManual.classList.toggle('active', !isAuto);
        dom.btnModeManual.setAttribute('aria-pressed', String(!isAuto));
        if (isAuto) {
          if (!state.paused) {
            startServoSim(1);
            startServoSim(2);
          }
        } else {
          stopServoSim(1);
          stopServoSim(2);
        }
        updateControlsDisabledState();
        updateStatusBar();
        return;
      }

      // Live HTTP POST /api/mode
      const res = await executeApiPost('/api/mode', { mode: newMode }, 'mode');
      if (res.ok) {
        state.mode = newMode;
        const isAuto = newMode === 'auto';
        dom.btnModeAuto.classList.toggle('active', isAuto);
        dom.btnModeAuto.setAttribute('aria-pressed', String(isAuto));
        dom.btnModeManual.classList.toggle('active', !isAuto);
        dom.btnModeManual.setAttribute('aria-pressed', String(!isAuto));
        if (isAuto && !state.paused) {
          state.servos[1].running = true;
          state.servos[2].running = true;
        } else if (!isAuto) {
          state.servos[1].running = false;
          state.servos[2].running = false;
        }
        updateServoUI(1);
        updateServoUI(2);
        updateControlsDisabledState();
        updateStatusBar();
      }
    }

    async function togglePause() {
      if (!state.connected || isPending('pause')) return;
      const nextPaused = !state.paused;

      if (isFilePreview) {
        state.paused = nextPaused;
        if (state.paused) {
          stopServoSim(1);
          stopServoSim(2);
          dom.btnPauseSim.textContent = 'Resume Sim';
          dom.btnPauseSim.classList.add('paused');
          dom.btnPauseSim.setAttribute('aria-pressed', 'true');
        } else {
          dom.btnPauseSim.textContent = 'Pause Sim';
          dom.btnPauseSim.classList.remove('paused');
          dom.btnPauseSim.setAttribute('aria-pressed', 'false');
          if (state.mode === 'auto') {
            startServoSim(1);
            startServoSim(2);
          }
        }
        updateServoUI(1);
        updateServoUI(2);
        updateControlsDisabledState();
        updateStatusBar();
        return;
      }

      // Live HTTP POST /api/pause
      const res = await executeApiPost('/api/pause', { paused: nextPaused ? 1 : 0 }, 'pause');
      if (res.ok) {
        state.paused = nextPaused;
        dom.btnPauseSim.textContent = state.paused ? 'Resume' : 'Pause';
        dom.btnPauseSim.classList.toggle('paused', state.paused);
        dom.btnPauseSim.setAttribute('aria-pressed', String(state.paused));
        if (state.paused) {
          state.servos[1].running = false;
          state.servos[2].running = false;
        } else if (state.mode === 'auto') {
          state.servos[1].running = true;
          state.servos[2].running = true;
        }
        updateServoUI(1);
        updateServoUI(2);
        updateControlsDisabledState();
        updateStatusBar();
      }
    }

    async function toggleServoRun(id) {
      if (!state.connected || state.paused || isPending(`run:${id}`)) return;
      const s = state.servos[id];
      const nextRunning = !s.running;

      if (isFilePreview) {
        if (nextRunning) startServoSim(id);
        else stopServoSim(id);
        return;
      }

      // Live HTTP POST /api/run
      const res = await executeApiPost('/api/run', { id, running: nextRunning ? 1 : 0 }, `run:${id}`);
      if (res.ok) {
        s.running = nextRunning;
        s.phase = nextRunning ? 'open' : 'idle';
        s.statusText = nextRunning ? 'OPEN' : 'IDLE';
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
      }
    }

    async function sendServoAngle(id, rawAngle) {
      if (!state.connected || state.paused || state.mode !== 'manual' || state.servos[id].running || isPending(`servo:${id}`)) return;
      const res = validateServoAngle(rawAngle);
      if (!res.valid) return;

      if (isFilePreview) {
        state.servos[id].angle = res.value;
        updateServoUI(id);
        return;
      }

      // Live HTTP POST /api/servo
      const apiRes = await executeApiPost('/api/servo', { id, angle: res.value }, `servo:${id}`);
      if (apiRes.ok) {
        state.servos[id].angle = res.value;
        updateServoUI(id);
      }
    }

    async function handleRelayToggle(id, newChecked) {
      if (!state.connected || state.paused || isPending(`relay:${id}`)) return;
      const oldChecked = !newChecked;

      // Optimistic UI state
      state.relays[id] = newChecked;
      updateRelayUI(id);

      if (isFilePreview) return;

      // Live HTTP POST /api/relay
      const res = await executeApiPost('/api/relay', { id, state: newChecked ? 1 : 0 }, `relay:${id}`);
      if (!res.ok) {
        // Rollback authoritative reconcile on error
        state.relays[id] = oldChecked;
        updateRelayUI(id);
        showError(`Relay ${id} toggle failed: ${res.error || 'communication error'}`);
      }
    }

    // ── Sliders & Angle Inputs Event Handlers ──

    function handleSliderInput(id, event) {
      const angle = Number(event.target.value);
      const angleElem = id === 1 ? dom.servo1Angle : dom.servo2Angle;
      const numberElem = id === 1 ? dom.servo1Number : dom.servo2Number;
      angleElem.textContent = `${angle}°`;
      if (!numberElem.classList.contains('is-dirty')) {
        numberElem.value = angle;
      }
    }

    function handleSliderChange(id, event) {
      sendServoAngle(id, event.target.value);
    }

    dom.servo1Slider.addEventListener('input', (e) => handleSliderInput(1, e));
    dom.servo1Slider.addEventListener('change', (e) => handleSliderChange(1, e));
    dom.servo2Slider.addEventListener('input', (e) => handleSliderInput(2, e));
    dom.servo2Slider.addEventListener('change', (e) => handleSliderChange(2, e));

    function applyServoNumberInput(id) {
      const isS1 = id === 1;
      const numInput = isS1 ? dom.servo1Number : dom.servo2Number;
      const errElem = isS1 ? dom.servo1Error : dom.servo2Error;

      numInput.classList.remove('is-dirty');

      if (numInput.validity && numInput.validity.badInput) {
        errElem.textContent = 'Angle must be an integer between 0° and 180°';
        numInput.classList.add('is-invalid');
        numInput.setAttribute('aria-invalid', 'true');
        return;
      }

      const res = validateServoAngle(numInput.value);
      if (!res.valid) {
        errElem.textContent = res.error;
        numInput.classList.add('is-invalid');
        numInput.setAttribute('aria-invalid', 'true');
        return;
      }

      errElem.textContent = '';
      numInput.classList.remove('is-invalid');
      numInput.removeAttribute('aria-invalid');
      sendServoAngle(id, res.value);
    }

    function restoreServoNumberInput(id) {
      const isS1 = id === 1;
      const numInput = isS1 ? dom.servo1Number : dom.servo2Number;
      const errElem = isS1 ? dom.servo1Error : dom.servo2Error;

      numInput.value = state.servos[id].angle;
      numInput.classList.remove('is-invalid', 'is-dirty');
      numInput.removeAttribute('aria-invalid');
      errElem.textContent = '';
    }

    function bindServoNumberEvents(id, numInput, errElem) {
      numInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyServoNumberInput(id);
        } else if (e.key === 'Escape') {
          restoreServoNumberInput(id);
        }
      });
      numInput.addEventListener('blur', () => applyServoNumberInput(id));
      numInput.addEventListener('input', () => {
        numInput.classList.add('is-dirty');
        errElem.textContent = '';
        numInput.classList.remove('is-invalid');
        numInput.removeAttribute('aria-invalid');
      });
    }

    bindServoNumberEvents(1, dom.servo1Number, dom.servo1Error);
    bindServoNumberEvents(2, dom.servo2Number, dom.servo2Error);

    // ── Presets Handlers ──

    function applyPresetInput(servoId, index, inputElem, btnElem, errElem) {
      if (inputElem.disabled) return;
      if (inputElem.validity && inputElem.validity.badInput) {
        errElem.textContent = 'Angle must be an integer between 0° and 180°';
        inputElem.classList.add('is-invalid');
        inputElem.setAttribute('aria-invalid', 'true');
        return;
      }

      const res = validateServoAngle(inputElem.value);
      if (!res.valid) {
        errElem.textContent = res.error;
        inputElem.classList.add('is-invalid');
        inputElem.setAttribute('aria-invalid', 'true');
        return;
      }

      state.servos[servoId].presets[index] = res.value;
      inputElem.value = res.value;
      inputElem.classList.remove('is-invalid');
      inputElem.removeAttribute('aria-invalid');
      errElem.textContent = '';
      btnElem.textContent = `Move to ${res.value}°`;
    }

    function restorePresetInput(servoId, index, inputElem, errElem) {
      inputElem.value = state.servos[servoId].presets[index];
      inputElem.classList.remove('is-invalid');
      inputElem.removeAttribute('aria-invalid');
      errElem.textContent = '';
    }

    function handlePresetClick(servoId, index) {
      if (!state.connected || state.mode !== 'manual' || state.paused || state.servos[servoId].running) return;
      sendServoAngle(servoId, state.servos[servoId].presets[index]);
    }

    function bindPresetEvents(servoId, index, inputElem, btnElem, errElem) {
      btnElem.addEventListener('click', () => handlePresetClick(servoId, index));
      inputElem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyPresetInput(servoId, index, inputElem, btnElem, errElem);
        } else if (e.key === 'Escape') {
          restorePresetInput(servoId, index, inputElem, errElem);
        }
      });
      inputElem.addEventListener('blur', () => applyPresetInput(servoId, index, inputElem, btnElem, errElem));
      inputElem.addEventListener('input', () => {
        errElem.textContent = '';
        inputElem.classList.remove('is-invalid');
        inputElem.removeAttribute('aria-invalid');
      });
    }

    bindPresetEvents(1, 0, dom.servo1PresetVal1, dom.servo1Preset1Btn, dom.servo1Preset1Err);
    bindPresetEvents(1, 1, dom.servo1PresetVal2, dom.servo1Preset2Btn, dom.servo1Preset2Err);
    bindPresetEvents(2, 0, dom.servo2PresetVal1, dom.servo2Preset1Btn, dom.servo2Preset1Err);
    bindPresetEvents(2, 1, dom.servo2PresetVal2, dom.servo2Preset2Btn, dom.servo2Preset2Err);

    // ── Global Buttons & Form Bindings ──

    dom.btnModeManual.addEventListener('click', () => setMode('manual'));
    dom.btnModeAuto.addEventListener('click', () => setMode('auto'));
    dom.btnPauseSim.addEventListener('click', togglePause);

    dom.servo1Run.addEventListener('click', () => toggleServoRun(1));
    dom.servo2Run.addEventListener('click', () => toggleServoRun(2));

    dom.relay1Toggle.addEventListener('change', (e) => handleRelayToggle(1, e.target.checked));
    dom.relay2Toggle.addEventListener('change', (e) => handleRelayToggle(2, e.target.checked));

    // Sequence Settings Form Dirty Tracking
    [dom.cfgOpen, dom.cfgClose, dom.cfgHold].forEach((el) => {
      if (el) el.addEventListener('input', () => { state.sequenceDirty = true; });
    });

    // Sequence Settings Form Submit
    dom.settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.connected || isPending('sequence')) return;

      const candidate = {
        openAngle: dom.cfgOpen.value.trim(),
        closeAngle: dom.cfgClose.value.trim(),
        holdMs: dom.cfgHold.value.trim(),
      };

      const result = validateSettings(candidate);
      if (!result.valid) {
        dom.settingsFeedback.className = 'feedback-msg feedback-error';
        dom.settingsFeedback.textContent = result.error;
        return;
      }

      if (isFilePreview) {
        state.config = result.values;
        state.sequenceDirty = false;
        dom.settingsFeedback.className = 'feedback-msg feedback-success';
        dom.settingsFeedback.textContent = 'Sequence parameters applied to simulation.';
        [1, 2].forEach((id) => {
          if (state.servos[id].running && !state.paused) {
            startServoSim(id);
          }
        });
        updateStatusBar();
        return;
      }

      // Live HTTP POST /api/sequence
      const res = await executeApiPost('/api/sequence', {
        open_deg: result.values.openAngle,
        close_deg: result.values.closeAngle,
        hold_ms: result.values.holdMs,
      }, 'sequence');

      if (res.ok) {
        state.config = result.values;
        state.sequenceDirty = false;
        dom.settingsFeedback.className = 'feedback-msg feedback-success';
        dom.settingsFeedback.textContent = 'Sequence parameters saved on device. Active loops restarted.';
      } else {
        dom.settingsFeedback.className = 'feedback-msg feedback-error';
        dom.settingsFeedback.textContent = res.error || 'Failed to apply sequence parameters.';
      }
    });

    // Sequence Settings Reset Defaults
    dom.btnResetSettings.addEventListener('click', async () => {
      if (!state.connected || isPending('sequence_reset')) return;

      if (isFilePreview) {
        state.config = { ...DEFAULT_CONFIG };
        state.sequenceDirty = false;
        dom.cfgOpen.value = DEFAULT_CONFIG.openAngle;
        dom.cfgClose.value = DEFAULT_CONFIG.closeAngle;
        dom.cfgHold.value = DEFAULT_CONFIG.holdMs;
        dom.settingsFeedback.className = 'feedback-msg feedback-success';
        dom.settingsFeedback.textContent = 'Factory defaults restored (30°/85°, 200ms).';
        [1, 2].forEach((id) => {
          if (state.servos[id].running && !state.paused) {
            startServoSim(id);
          }
        });
        updateStatusBar();
        return;
      }

      // Live HTTP POST /api/sequence/reset
      const res = await executeApiPost('/api/sequence/reset', {}, 'sequence_reset');
      if (res.ok) {
        state.config = { ...DEFAULT_CONFIG };
        state.sequenceDirty = false;
        dom.cfgOpen.value = DEFAULT_CONFIG.openAngle;
        dom.cfgClose.value = DEFAULT_CONFIG.closeAngle;
        dom.cfgHold.value = DEFAULT_CONFIG.holdMs;
        dom.settingsFeedback.className = 'feedback-msg feedback-success';
        dom.settingsFeedback.textContent = 'Factory defaults restored on device (30°/85°, 200ms).';
      } else {
        dom.settingsFeedback.className = 'feedback-msg feedback-error';
        dom.settingsFeedback.textContent = res.error || 'Failed to reset sequence defaults.';
      }
    });

    // ── Application Initialization ──

    if (isFilePreview) {
      if (dom.demoBanner) dom.demoBanner.style.display = 'flex';
      if (dom.infoConnMode) dom.infoConnMode.textContent = 'Offline preview (file:// protocol)';
      dom.btnPauseSim.textContent = 'Pause Sim';
      state.connected = true;
      updateServoUI(1);
      updateServoUI(2);
      updateRelayUI(1);
      updateRelayUI(2);
      updateControlsDisabledState();
      updateStatusBar();
    } else {
      if (dom.demoBanner) dom.demoBanner.style.display = 'none';
      if (dom.infoConnMode) dom.infoConnMode.textContent = 'Connecting...';
      updateControlsDisabledState();
      updateStatusBar();
      // Immediate poll on boot, then 1-second recurring poll
      pollStatus();
      setInterval(pollStatus, 1000);
    }
  });
}

// ─── CLI SELF-TEST (NODE CLI) ───────────────────────────────────────────────

async function runSelfTest() {
  let assertions = 0;
  function assert(cond, msg) {
    assertions++;
    if (!cond) throw new Error(`Self-test failed: ${msg}`);
  }

  // 1. Sequence Configuration Validation (3 parameters, no interval)
  const validDefault = validateSettings(DEFAULT_CONFIG);
  assert(validDefault.valid === true, 'Default sequence config must be valid');
  assert(validDefault.values.openAngle === 30, 'Parsed open angle should be 30');
  assert(validDefault.values.closeAngle === 85, 'Parsed close angle should be 85');
  assert(validDefault.values.holdMs === 200, 'Parsed hold ms should be 200');
  assert(!('intervalSec' in validDefault.values), 'Repeat interval must not exist in validated output');

  assert(!validateSettings({ openAngle: 30, closeAngle: 30, holdMs: 200 }).valid, 'Identical open & close angles rejected');
  assert(!validateSettings({ openAngle: -1, closeAngle: 85, holdMs: 200 }).valid, 'Negative open angle rejected');
  assert(!validateSettings({ openAngle: 181, closeAngle: 85, holdMs: 200 }).valid, 'Open angle > 180 rejected');
  assert(!validateSettings({ openAngle: 30.5, closeAngle: 85, holdMs: 200 }).valid, 'Non-integer open angle rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: -1, holdMs: 200 }).valid, 'Negative close angle rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 181, holdMs: 200 }).valid, 'Close angle > 180 rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85.5, holdMs: 200 }).valid, 'Non-integer close angle rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 49 }).valid, 'Hold delay < 50ms rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 5001 }).valid, 'Hold delay > 5000ms rejected');
  assert(!validateSettings(null).valid, 'Null config rejected');
  assert(!validateSettings(undefined).valid, 'Undefined config rejected');

  // 2. Servo Angle Validation (Integer 0..180)
  assert(validateServoAngle(30).valid === true && validateServoAngle(30).value === 30, 'Integer 30 should be valid');
  assert(validateServoAngle('0').valid === true && validateServoAngle('0').value === 0, 'String "0" should be valid');
  assert(validateServoAngle('180').valid === true && validateServoAngle('180').value === 180, 'String "180" should be valid');
  assert(validateServoAngle('  45  ').valid === true && validateServoAngle('  45  ').value === 45, 'Trimmed "45" should be valid');
  assert(validateServoAngle('+30').valid === true && validateServoAngle('+30').value === 30, '"+30" should parse to 30');
  assert(validateServoAngle('-0').valid === true && Object.is(validateServoAngle('-0').value, 0), '"-0" should normalize to 0');
  assert(!validateServoAngle('').valid, 'Empty string rejected (avoids Number("") === 0)');
  assert(!validateServoAngle('   ').valid, 'Whitespace string rejected');
  assert(!validateServoAngle(null).valid, 'Null angle rejected');
  assert(!validateServoAngle(undefined).valid, 'Undefined angle rejected');
  assert(!validateServoAngle(-1).valid, 'Negative angle rejected');
  assert(!validateServoAngle(181).valid, 'Angle > 180 rejected');
  assert(!validateServoAngle(30.5).valid, 'Decimal number rejected');
  assert(!validateServoAngle('30.5').valid, 'Decimal string rejected');
  assert(!validateServoAngle('abc').valid, 'Non-numeric string rejected');
  assert(!validateServoAngle('1e2').valid, 'Scientific notation rejected');

  // 3. Presets
  assert(DEFAULT_PRESETS.length === 2 && DEFAULT_PRESETS[0] === 30 && DEFAULT_PRESETS[1] === 85, 'Default presets are 30 and 85');
  assert(validateServoAngle(DEFAULT_PRESETS[0]).valid && validateServoAngle(DEFAULT_PRESETS[1]).valid, 'Default presets valid');

  // 4. Form UrlEncoding Serializer
  assert(serializeFormUrlEncoded({ id: 1, running: 1 }) === 'id=1&running=1', 'Form serialization produces urlencoded key-value pairs');
  assert(serializeFormUrlEncoded({ mode: 'auto' }) === 'mode=auto', 'Mode serialization');
  assert(serializeFormUrlEncoded({ open_deg: 30, close_deg: 85, hold_ms: 200 }) === 'open_deg=30&close_deg=85&hold_ms=200', 'Sequence serialization');

  // 5. API Mapping Verification (Endpoints & Parameters)
  const apiMap = [
    { name: 'run', url: '/api/run', params: { id: 1, running: 1 }, expected: 'id=1&running=1' },
    { name: 'run_stop', url: '/api/run', params: { id: 2, running: 0 }, expected: 'id=2&running=0' },
    { name: 'servo', url: '/api/servo', params: { id: 1, angle: 45 }, expected: 'id=1&angle=45' },
    { name: 'mode_auto', url: '/api/mode', params: { mode: 'auto' }, expected: 'mode=auto' },
    { name: 'mode_manual', url: '/api/mode', params: { mode: 'manual' }, expected: 'mode=manual' },
    { name: 'pause', url: '/api/pause', params: { paused: 1 }, expected: 'paused=1' },
    { name: 'resume', url: '/api/pause', params: { paused: 0 }, expected: 'paused=0' },
    { name: 'relay', url: '/api/relay', params: { id: 1, state: 1 }, expected: 'id=1&state=1' },
    { name: 'sequence', url: '/api/sequence', params: { open_deg: 30, close_deg: 85, hold_ms: 200 }, expected: 'open_deg=30&close_deg=85&hold_ms=200' },
    { name: 'sequence_reset', url: '/api/sequence/reset', params: {}, expected: '' },
  ];

  apiMap.forEach((entry) => {
    assert(serializeFormUrlEncoded(entry.params) === entry.expected, `API mapping for ${entry.name} matches parameter contract`);
  });

  // 6. State Reducer & Malformed Payload Handling
  const mockState = createAppState();
  const validStatus = {
    mode: 'auto',
    paused: false,
    uptime: 1234,
    free_heap: 184320,
    chip_model: 'ESP32-D0WD-V3',
    wifi_connected: true,
    sta_ip: '192.168.1.100',
    ap_ip: '192.168.10.1',
    mdns: 'mcu-eye-monster',
    servos: [
      { id: 1, angle: 30, running: true, phase: 'open', status: 'OPEN' },
      { id: 2, angle: 85, running: true, phase: 'close', status: 'CLOSE' },
    ],
    relays: [{ id: 1, state: 1 }, { id: 2, state: 0 }],
    sequence: { open_deg: 40, close_deg: 90, hold_ms: 300 },
  };

  assert(applyStatusToState(mockState, validStatus) === true, 'Valid status payload parses successfully');
  assert(mockState.mode === 'auto', 'Mode parsed as auto');
  assert(mockState.servos[1].running === true && mockState.servos[1].phase === 'open', 'Servo 1 running state parsed');
  assert(mockState.servos[2].angle === 85 && mockState.servos[2].phase === 'close', 'Servo 2 angle and phase parsed');
  assert(mockState.relays[1] === true && mockState.relays[2] === false, 'Relays parsed');
  assert(mockState.config.openAngle === 40 && mockState.config.holdMs === 300, 'Sequence config parsed');

  // Malformed payload resiliency checks
  assert(applyStatusToState(mockState, null) === false, 'Null payload handled safely');
  assert(applyStatusToState(mockState, undefined) === false, 'Undefined payload handled safely');
  assert(applyStatusToState(mockState, 'invalid string') === false, 'String payload handled safely');

  const partialMalformedStatus = {
    mode: 'manual',
    paused: true,
    servos: null,
    relays: 'not an array',
    sequence: undefined,
  };
  assert(applyStatusToState(mockState, partialMalformedStatus) === true, 'Partial malformed status parsed without crashing');
  assert(mockState.paused === true, 'Paused state updated');
  assert(mockState.mode === 'manual', 'Mode state updated to manual');

  // 7. Mocked Fetch & HTTP Transport Unit Tests
  const capturedRequests = [];
  const mockFetch = async (url, options) => {
    capturedRequests.push({ url, options });
    if (url === '/api/status') {
      return {
        ok: true,
        status: 200,
        json: async () => validStatus,
      };
    }
    if (url === '/api/run') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, id: 1, running: true }),
      };
    }
    if (url === '/api/relay') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, id: 1, state: 1 }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    };
  };

  // Test status polling
  const statusRes = await fetchStatus(mockFetch);
  assert(statusRes.ok === true, 'Mock fetchStatus succeeds');
  assert(statusRes.data.chip_model === 'ESP32-D0WD-V3', 'Status response contains device data');
  const lastReq = capturedRequests[capturedRequests.length - 1];
  assert(lastReq.options.headers['X-Requested-With'] === 'XMLHttpRequest', 'GET request has X-Requested-With header');

  // Test postApiCommand headers and body
  const testPending = new Set();
  const runPostRes = await postApiCommand('/api/run', { id: 1, running: 1 }, 'run:1', testPending, mockFetch);
  assert(runPostRes.ok === true, 'POST /api/run succeeds');
  assert(testPending.size === 0, 'Pending action set cleaned up after post');
  const postReq = capturedRequests[capturedRequests.length - 1];
  assert(postReq.options.method === 'POST', 'Method is POST');
  assert(postReq.options.headers['Content-Type'] === 'application/x-www-form-urlencoded', 'Content-Type is urlencoded');
  assert(postReq.options.headers['X-Requested-With'] === 'XMLHttpRequest', 'X-Requested-With header included on mutation');
  assert(postReq.options.body === 'id=1&running=1', 'Body is serialized form data');

  // 8. Offline & Reconnect Transition Tests
  const failingFetch = async () => {
    throw new TypeError('Failed to fetch (offline)');
  };
  const offlineRes = await fetchStatus(failingFetch);
  assert(offlineRes.ok === false, 'Failing fetch reports error');
  assert(offlineRes.error.includes('offline') || offlineRes.error.includes('Failed to fetch'), 'Error message contains failure detail');

  // Reconnect with working fetch
  const reconnectRes = await fetchStatus(mockFetch);
  assert(reconnectRes.ok === true, 'Subsequent working fetch reconnects successfully');

  // 9. Duplicate Request Prevention
  testPending.add('action:busy');
  const dupRes = await postApiCommand('/api/run', { id: 1, running: 1 }, 'action:busy', testPending, mockFetch);
  assert(dupRes.duplicate === true && dupRes.ok === false, 'Duplicate action rejected while previous is pending');
  testPending.delete('action:busy');

  // 10. Relay Rollback on Failed Mutation
  let testRelayState = false;
  async function testRelayMutation(id, desiredState, shouldFail) {
    const prev = testRelayState;
    testRelayState = desiredState; // Optimistic
    const failingPost = async () => { throw new Error('Relay hardware failure'); };
    const res = await postApiCommand('/api/relay', { id, state: desiredState ? 1 : 0 }, `relay:${id}`, new Set(), shouldFail ? failingPost : mockFetch);
    if (!res.ok) {
      testRelayState = prev; // Rollback
    }
    return res;
  }

  const failToggle = await testRelayMutation(1, true, true);
  assert(failToggle.ok === false, 'Relay mutation fails when server errors');
  assert(testRelayState === false, 'Relay rolled back to false on mutation failure');

  const succToggle = await testRelayMutation(1, true, false);
  assert(succToggle.ok === true, 'Relay mutation succeeds');
  assert(testRelayState === true, 'Relay updated to true on mutation success');

  // 11. Fake Timer for Simulation Runner Test
  function createFakeTimer() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
      setTimeout(fn, delay) {
        const id = nextId++;
        timers.set(id, { fn, due: now + delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      tick(ms) {
        now += ms;
        let ran = true;
        while (ran) {
          ran = false;
          let earliestId = null;
          let earliestDue = Infinity;
          for (const [id, t] of timers.entries()) {
            if (t.due <= now && t.due < earliestDue) {
              earliestId = id;
              earliestDue = t.due;
            }
          }
          if (earliestId !== null) {
            const { fn } = timers.get(earliestId);
            timers.delete(earliestId);
            fn();
            ran = true;
          }
        }
      },
      get count() {
        return timers.size;
      },
    };
  }

  const fakeTimer = createFakeTimer();
  const testServo = { angle: 0, running: false, phase: 'idle', timer: null, statusText: null };
  const testCfg = { openAngle: 30, closeAngle: 85, holdMs: 200 };

  startServoRunner(testServo, testCfg, null, fakeTimer);
  assert(testServo.running === true, 'Runner sets running = true');
  assert(testServo.phase === 'open', 'Starts at open phase');
  assert(testServo.angle === 30, 'Initial angle is openAngle');
  fakeTimer.tick(200);
  assert(testServo.phase === 'close', 'Transitions to close after holdMs');
  assert(testServo.angle === 85, 'Angle is closeAngle');
  fakeTimer.tick(200);
  assert(testServo.phase === 'open', 'Transitions back to open');
  stopServoRunner(testServo, null, fakeTimer);
  assert(testServo.running === false, 'Stopped runner has running = false');
  assert(fakeTimer.count === 0, 'Timers cleared after stop');

  // 12. DOM Contract Verification against root index.html
  if (typeof require !== 'undefined') {
    const fs = require('fs');
    const path = require('path');
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      const requiredDomIds = [
        'app-alert',
        'app-alert-text',
        'app-alert-dismiss',
        'demo-banner',
        'btn-mode-manual',
        'btn-mode-auto',
        'btn-pause-sim',
        'stat-mode',
        'stat-sim',
        'stat-auto-due',
        'card-servo-1',
        'servo-1-status',
        'servo-1-angle',
        'servo-1-slider',
        'servo-1-manual-badge',
        'servo-1-number',
        'servo-1-error',
        'servo-1-preset-1',
        'servo-1-preset-2',
        'servo-1-preset-details',
        'servo-1-preset-val-1',
        'servo-1-preset-val-2',
        'servo-1-preset-1-error',
        'servo-1-preset-2-error',
        'servo-1-run',
        'card-servo-2',
        'servo-2-status',
        'servo-2-angle',
        'servo-2-slider',
        'servo-2-manual-badge',
        'servo-2-number',
        'servo-2-error',
        'servo-2-preset-1',
        'servo-2-preset-2',
        'servo-2-preset-details',
        'servo-2-preset-val-1',
        'servo-2-preset-val-2',
        'servo-2-preset-1-error',
        'servo-2-preset-2-error',
        'servo-2-run',
        'relay-1-toggle',
        'relay-1-text',
        'relay-2-toggle',
        'relay-2-text',
        'details-settings',
        'settings-form',
        'cfg-open',
        'cfg-close',
        'cfg-hold',
        'settings-feedback',
        'btn-reset-settings',
        'details-device',
        'info-chip',
        'info-fw',
        'info-conn-mode',
        'info-uptime',
        'info-heap',
        'info-sta',
        'info-ap',
        'info-mdns',
        'info-ota-auth',
        'ota-link',
      ];

      for (const id of requiredDomIds) {
        assert(html.includes(`id="${id}"`), `DOM element #${id} must exist in index.html`);
      }
      assert(!html.includes('id="cfg-interval"'), 'cfg-interval must not exist in index.html');
      assert(!html.includes('Auto Repeat Interval'), 'Auto Repeat Interval label must not exist in index.html');
      assert(html.includes('href="/update"'), 'Working /update link must exist in index.html');
    }
  }

  return { ok: true, assertions };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_CONFIG,
    DEFAULT_PRESETS,
    validateSettings,
    validateServoAngle,
    serializeFormUrlEncoded,
    createAppState,
    applyStatusToState,
    postApiCommand,
    fetchStatus,
    startServoRunner,
    stopServoRunner,
    runSelfTest,
  };
}

if (typeof process !== 'undefined' && process.argv && (process.argv.includes('--test') || process.argv.includes('--self-test'))) {
  (async () => {
    try {
      const res = await runSelfTest();
      console.log(`[PASS] Embedded self-test passed: ${res.assertions} assertions verified.`);
      process.exit(0);
    } catch (err) {
      console.error(`[FAIL] ${err.message}`);
      process.exit(1);
    }
  })();
}
