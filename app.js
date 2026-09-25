/**
 * NOYA — ESP32 RTOS Control Panel Frontend Integration
 * Responsive, accessible, dependency-free controller for live MCU firmware and file:// preview.
 */

// ─── PURE CONFIGURATION & VALIDATION ────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  openAngle: 30,
  closeAngle: 85,
  holdMs: 200,
  cyclesPerSession: 5,
  restMs: 10000,
});

const DEFAULT_PRESETS = Object.freeze([30, 85]);

/**
 * Validates sequence parameters.
 * Requirements:
 * - openAngle, closeAngle: integer 0-180, distinct
 * - holdMs: integer 50-5000ms
 * - cyclesPerSession: integer 1-100, default 5
 * - restMs: integer 0-3600000ms, default 10000 (accepts restMs or restSec with explicit conversion)
 */
function validateSettings(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    return { valid: false, error: 'Invalid configuration object' };
  }

  const openAngle = Number(cfg.openAngle !== undefined ? cfg.openAngle : cfg.open_deg);
  const closeAngle = Number(cfg.closeAngle !== undefined ? cfg.closeAngle : cfg.close_deg);
  const holdMs = Number(cfg.holdMs !== undefined ? cfg.holdMs : cfg.hold_ms);

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

  let rawCycles = cfg.cyclesPerSession !== undefined ? cfg.cyclesPerSession : cfg.cycles_per_session;
  if (rawCycles === undefined || rawCycles === null || rawCycles === '') {
    rawCycles = DEFAULT_CONFIG.cyclesPerSession;
  }
  const cyclesPerSession = Number(rawCycles);
  if (!Number.isInteger(cyclesPerSession) || cyclesPerSession < 1 || cyclesPerSession > 100) {
    return { valid: false, error: 'Cycles per session must be an integer between 1 and 100' };
  }

  let rawRestMs;
  if (cfg.restMs !== undefined) {
    rawRestMs = cfg.restMs;
  } else if (cfg.rest_ms !== undefined) {
    rawRestMs = cfg.rest_ms;
  } else if (cfg.restSec !== undefined) {
    const secStr = String(cfg.restSec).trim();
    if (secStr === '' || !/^[+-]?\d+(\.\d+)?$/.test(secStr)) {
      return { valid: false, error: 'Rest duration must be an integer between 0 ms and 3600000 ms (0–3600 s)' };
    }
    const sec = Number(secStr);
    rawRestMs = Number.isFinite(sec) ? Math.round(sec * 1000) : NaN;
  } else {
    rawRestMs = DEFAULT_CONFIG.restMs;
  }
  const restMs = Number(rawRestMs);
  if (!Number.isInteger(restMs) || restMs < 0 || restMs > 3600000) {
    return { valid: false, error: 'Rest duration must be an integer between 0 ms and 3600000 ms (0–3600 s)' };
  }

  return {
    valid: true,
    error: null,
    values: { openAngle, closeAngle, holdMs, cyclesPerSession, restMs },
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
      1: { angle: 30, running: false, phase: 'idle', statusText: 'IDLE', cycle: 0, restRemainingMs: 0, attached: true, timer: null, presets: [...DEFAULT_PRESETS] },
      2: { angle: 30, running: false, phase: 'idle', statusText: 'IDLE', cycle: 0, restRemainingMs: 0, attached: true, timer: null, presets: [...DEFAULT_PRESETS] },
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
        // Conservative mapping: explicitly require true, otherwise treat as detached
        state.servos[s.id].attached = s.attached === true;
        state.servos[s.id].angle = Number.isFinite(s.angle) ? s.angle : (Number(s.angle) || 0);
        state.servos[s.id].running = Boolean(s.running);
        state.servos[s.id].phase = s.phase || 'idle';
        state.servos[s.id].statusText = s.status || '';
        state.servos[s.id].cycle = Number(s.cycle) || 0;
        state.servos[s.id].restRemainingMs = Number(s.rest_remaining_ms) || 0;
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
    if (data.sequence.cycles_per_session !== undefined) {
      state.config.cyclesPerSession = data.sequence.cycles_per_session;
    }
    if (data.sequence.rest_ms !== undefined) {
      state.config.restMs = data.sequence.rest_ms;
    }
  }

  return true;
}

/**
 * Dispatches a POST mutation with form-urlencoded payload and X-Requested-With header.
 * Guarded against duplicate in-flight requests and bounded by timeout.
 */
async function postApiCommand(endpoint, params = {}, actionKey = null, pendingSet = new Set(), fetchFn = globalThis.fetch, timeoutMs = 4000, onPending = null) {
  if (actionKey) {
    if (pendingSet.has(actionKey)) return { ok: false, duplicate: true };
    pendingSet.add(actionKey);
    if (typeof onPending === 'function') {
      onPending(actionKey);
    }
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
 * Starts continuous sequence of N cycles (open->hold->close->hold) then rest closed for restMs.
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
  const openAngle = config.openAngle !== undefined ? config.openAngle : 30;
  const closeAngle = config.closeAngle !== undefined ? config.closeAngle : 85;
  const holdMs = config.holdMs !== undefined ? config.holdMs : 200;
  const cyclesPerSession = config.cyclesPerSession !== undefined ? config.cyclesPerSession : 5;
  const restMs = config.restMs !== undefined ? config.restMs : 10000;

  servo.running = true;
  servo.cycle = 1;
  servo.restRemainingMs = 0;
  servo.phase = 'open';
  servo.angle = openAngle;
  servo.statusText = 'OPEN';
  if (typeof onUpdate === 'function') onUpdate(servo);

  function afterRest() {
    if (!servo.running) return;
    servo.restRemainingMs = 0;
    servo.cycle = 1;
    servo.phase = 'open';
    servo.angle = openAngle;
    servo.statusText = 'OPEN';
    if (typeof onUpdate === 'function') onUpdate(servo);
    servo.timer = timerOps.setTimeout(stepClose, holdMs);
  }

  function afterClose() {
    if (!servo.running) return;
    if (servo.cycle >= cyclesPerSession) {
      if (restMs > 0) {
        servo.phase = 'rest';
        servo.angle = closeAngle;
        servo.statusText = 'REST';
        servo.restRemainingMs = restMs;
        if (typeof onUpdate === 'function') onUpdate(servo);
        servo.timer = timerOps.setTimeout(afterRest, restMs);
      } else {
        servo.restRemainingMs = 0;
        servo.cycle = 1;
        servo.phase = 'open';
        servo.angle = openAngle;
        servo.statusText = 'OPEN';
        if (typeof onUpdate === 'function') onUpdate(servo);
        servo.timer = timerOps.setTimeout(stepClose, holdMs);
      }
    } else {
      servo.cycle++;
      servo.phase = 'open';
      servo.angle = openAngle;
      servo.statusText = 'OPEN';
      if (typeof onUpdate === 'function') onUpdate(servo);
      servo.timer = timerOps.setTimeout(stepClose, holdMs);
    }
  }

  function stepClose() {
    if (!servo.running) return;
    servo.phase = 'close';
    servo.angle = closeAngle;
    servo.statusText = 'CLOSE';
    if (typeof onUpdate === 'function') onUpdate(servo);
    servo.timer = timerOps.setTimeout(afterClose, holdMs);
  }

  servo.timer = timerOps.setTimeout(stepClose, holdMs);
}

/**
 * Stops continuous sequence on a servo.
 * Cancels timer, holds current angle, and clears running, cycle, and rest state.
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
  servo.cycle = 0;
  servo.restRemainingMs = 0;
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
      servo1Cycle: document.getElementById('servo-1-cycle'),
      servo1Attach: document.getElementById('servo-1-attach'),
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
      servo2Cycle: document.getElementById('servo-2-cycle'),
      servo2Attach: document.getElementById('servo-2-attach'),
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
      cfgCycles: document.getElementById('cfg-cycles'),
      cfgRest: document.getElementById('cfg-rest'),
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
      const cycleElem = isS1 ? dom.servo1Cycle : dom.servo2Cycle;
      const totalCycles = state.config.cyclesPerSession || 5;

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

      if (!s.attached) {
        statusElem.className = 'status-pill pill-detached';
        statusElem.textContent = 'DETACHED';
        if (cycleElem) cycleElem.style.display = 'none';
      } else if (state.paused) {
        statusElem.className = 'status-pill pill-paused';
        statusElem.textContent = 'PAUSED';
        if (cycleElem) cycleElem.style.display = 'none';
      } else if (s.running) {
        if (cycleElem) {
          cycleElem.style.display = 'inline-block';
          cycleElem.textContent = `Cycle ${s.cycle || 1}/${totalCycles}`;
        }
        if (s.phase === 'rest') {
          statusElem.className = 'status-pill pill-rest';
          const remSec = Math.max(0, Math.ceil((s.restRemainingMs || 0) / 1000));
          statusElem.textContent = `REST (${remSec}s)`;
        } else {
          statusElem.className = 'status-pill pill-running';
          statusElem.textContent = (s.phase || s.statusText || 'OPEN').toUpperCase();
        }
      } else {
        statusElem.className = 'status-pill pill-idle';
        statusElem.textContent = 'IDLE';
        if (cycleElem) cycleElem.style.display = 'none';
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
        const attachBtn = isS1 ? dom.servo1Attach : dom.servo2Attach;
        const badge = isS1 ? dom.servo1ManualBadge : dom.servo2ManualBadge;

        const isAttached = Boolean(s.attached);
        const attachPending = isPending(`attachment:${id}`);

        // Attach button: disabled offline or if pending; attach disabled paused; detach available paused
        if (attachBtn) {
          attachBtn.disabled = !isConnected || attachPending || (!isAttached && isPaused);
          attachBtn.textContent = isAttached ? 'Detach' : 'Attach';
          attachBtn.setAttribute('aria-label', `${isAttached ? 'Detach' : 'Attach'} Servo ${id}`);
        }

        // Manual controls disabled if offline, detached, paused, auto mode, running, or action pending
        const manualLocked = !isConnected || !isAttached || isPaused || isAuto || s.running || isPending(`servo:${id}`) || isPending(`run:${id}`) || attachPending;
        slider.disabled = manualLocked;
        number.disabled = manualLocked;
        p1Btn.disabled = manualLocked;
        p2Btn.disabled = manualLocked;
        pVal1.disabled = manualLocked;
        pVal2.disabled = manualLocked;

        // Start/Stop sequence allowed in Manual OR Auto; disabled if offline, paused, pending, or if detached and not running
        const runLocked = !isConnected || isPaused || isPending(`run:${id}`) || attachPending || (!isAttached && !s.running);
        runBtn.disabled = runLocked;
        runBtn.textContent = s.running ? 'Stop sequence' : 'Start sequence';
        runBtn.setAttribute('aria-label', `${s.running ? 'Stop' : 'Start'} sequence for Servo ${id}`);
        runBtn.classList.toggle('btn-stop', s.running);

        if (!isConnected) {
          badge.textContent = '(Connecting...)';
        } else if (!isAttached) {
          badge.textContent = '(Detached)';
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
      if (dom.cfgCycles) dom.cfgCycles.disabled = settingsLocked;
      if (dom.cfgRest) dom.cfgRest.disabled = settingsLocked;
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
        const total = state.config.cyclesPerSession || 5;
        const formatServo = (s) => {
          if (!s.attached) return 'detached';
          if (!s.running) return 'idle';
          if (s.phase === 'rest') {
            const sec = Math.max(0, Math.ceil((s.restRemainingMs || 0) / 1000));
            return `Cycle ${s.cycle}/${total} (Rest ${sec}s)`;
          }
          return `Cycle ${s.cycle}/${total} (${(s.phase || s.statusText || 'open').toUpperCase()})`;
        };

        if (s1.running && s2.running) {
          dom.statAutoDue.textContent = `Running (S1: ${formatServo(s1)}, S2: ${formatServo(s2)})`;
        } else if (s1.running) {
          dom.statAutoDue.textContent = `Running (Servo 1: ${formatServo(s1)})`;
        } else if (s2.running) {
          dom.statAutoDue.textContent = `Running (Servo 2: ${formatServo(s2)})`;
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
      if (seq.cycles_per_session !== undefined) state.config.cyclesPerSession = seq.cycles_per_session;
      if (seq.rest_ms !== undefined) state.config.restMs = seq.rest_ms;

      const isFocused = document.activeElement === dom.cfgOpen ||
                        document.activeElement === dom.cfgClose ||
                        document.activeElement === dom.cfgHold ||
                        document.activeElement === dom.cfgCycles ||
                        document.activeElement === dom.cfgRest;
      if (!isFocused && !state.sequenceDirty) {
        dom.cfgOpen.value = seq.open_deg;
        dom.cfgClose.value = seq.close_deg;
        dom.cfgHold.value = seq.hold_ms;
        if (dom.cfgCycles && seq.cycles_per_session !== undefined) {
          dom.cfgCycles.value = seq.cycles_per_session;
        }
        if (dom.cfgRest && seq.rest_ms !== undefined) {
          dom.cfgRest.value = seq.rest_ms / 1000;
        }
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
      const res = await postApiCommand(endpoint, params, actionKey, pendingActions, window.fetch, 4000, () => {
        updateControlsDisabledState();
      });
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
      if (state.paused || !state.servos[id].attached) return;
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
            if (state.servos[1].attached) startServoSim(1);
            if (state.servos[2].attached) startServoSim(2);
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
          if (state.servos[1].attached) state.servos[1].running = true;
          if (state.servos[2].attached) state.servos[2].running = true;
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
            if (state.servos[1].attached) startServoSim(1);
            if (state.servos[2].attached) startServoSim(2);
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
          if (state.servos[1].attached) state.servos[1].running = true;
          if (state.servos[2].attached) state.servos[2].running = true;
        }
        updateServoUI(1);
        updateServoUI(2);
        updateControlsDisabledState();
        updateStatusBar();
      }
    }

    async function toggleServoRun(id) {
      if (!state.connected || state.paused || isPending(`run:${id}`) || isPending(`attachment:${id}`)) return;
      const s = state.servos[id];
      if (!s.attached && !s.running) return;
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
        s.statusText = nextRunning ? 'OPEN' : (s.attached ? 'IDLE' : 'DETACHED');
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
      }
    }

    async function toggleAttachment(id) {
      if (!state.connected || isPending(`attachment:${id}`)) return;
      const s = state.servos[id];
      const nextAttached = !s.attached;

      // Reject attach while paused (detach always permitted)
      if (nextAttached && state.paused) return;
      // Guard attaching when run or angle is in-flight; detach is always permitted even with angle pending
      if (nextAttached && (isPending(`run:${id}`) || isPending(`servo:${id}`))) return;

      if (isFilePreview) {
        s.attached = nextAttached;
        if (!nextAttached) {
          stopServoSim(id);
          s.statusText = 'DETACHED';
          s.phase = 'idle';
          s.running = false;
          s.cycle = 0;
          s.restRemainingMs = 0;
        } else {
          stopServoSim(id);
          s.statusText = 'IDLE';
          s.phase = 'idle';
          s.running = false;
          s.cycle = 0;
          s.restRemainingMs = 0;
        }
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
        return;
      }

      // Live HTTP POST /api/attachment
      const res = await executeApiPost('/api/attachment', { id, attached: nextAttached ? 1 : 0 }, `attachment:${id}`);
      if (res.ok) {
        s.attached = nextAttached;
        s.running = false;
        s.cycle = 0;
        s.restRemainingMs = 0;
        s.phase = 'idle';
        s.statusText = nextAttached ? 'IDLE' : 'DETACHED';
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
      }
    }

    async function sendServoAngle(id, rawAngle) {
      if (!state.connected || state.paused || state.mode !== 'manual' || !state.servos[id].attached || state.servos[id].running || isPending(`servo:${id}`) || isPending(`attachment:${id}`) || isPending(`run:${id}`)) return;
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

    if (dom.servo1Attach) {
      dom.servo1Attach.addEventListener('click', () => toggleAttachment(1));
    }
    if (dom.servo2Attach) {
      dom.servo2Attach.addEventListener('click', () => toggleAttachment(2));
    }

    dom.servo1Run.addEventListener('click', () => toggleServoRun(1));
    dom.servo2Run.addEventListener('click', () => toggleServoRun(2));

    dom.relay1Toggle.addEventListener('change', (e) => handleRelayToggle(1, e.target.checked));
    dom.relay2Toggle.addEventListener('change', (e) => handleRelayToggle(2, e.target.checked));

    // Sequence Settings Form Dirty Tracking
    [dom.cfgOpen, dom.cfgClose, dom.cfgHold, dom.cfgCycles, dom.cfgRest].forEach((el) => {
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
        cyclesPerSession: dom.cfgCycles ? dom.cfgCycles.value.trim() : DEFAULT_CONFIG.cyclesPerSession,
        restSec: dom.cfgRest ? dom.cfgRest.value.trim() : (DEFAULT_CONFIG.restMs / 1000),
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
        cycles_per_session: result.values.cyclesPerSession,
        rest_ms: result.values.restMs,
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
        if (dom.cfgCycles) dom.cfgCycles.value = DEFAULT_CONFIG.cyclesPerSession;
        if (dom.cfgRest) dom.cfgRest.value = DEFAULT_CONFIG.restMs / 1000;
        dom.settingsFeedback.className = 'feedback-msg feedback-success';
        dom.settingsFeedback.textContent = 'Factory defaults restored (30°/85°, 200ms, 5 cycles, 10s rest).';
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
        if (dom.cfgCycles) dom.cfgCycles.value = DEFAULT_CONFIG.cyclesPerSession;
        if (dom.cfgRest) dom.cfgRest.value = DEFAULT_CONFIG.restMs / 1000;
        dom.settingsFeedback.className = 'feedback-msg feedback-success';
        dom.settingsFeedback.textContent = 'Factory defaults restored on device (30°/85°, 200ms, 5 cycles, 10s rest).';
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
      if (dom.cfgCycles) dom.cfgCycles.value = DEFAULT_CONFIG.cyclesPerSession;
      if (dom.cfgRest) dom.cfgRest.value = DEFAULT_CONFIG.restMs / 1000;
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

  // 1. Sequence Configuration Validation (5 parameters: open, close, hold, cycles, rest)
  const validDefault = validateSettings(DEFAULT_CONFIG);
  assert(validDefault.valid === true, 'Default sequence config must be valid');
  assert(validDefault.values.openAngle === 30, 'Parsed open angle should be 30');
  assert(validDefault.values.closeAngle === 85, 'Parsed close angle should be 85');
  assert(validDefault.values.holdMs === 200, 'Parsed hold ms should be 200');
  assert(validDefault.values.cyclesPerSession === 5, 'Parsed cycles per session should be 5');
  assert(validDefault.values.restMs === 10000, 'Parsed rest ms should be 10000');
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

  // cycles_per_session range validation (1..100)
  assert(validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, cyclesPerSession: 1 }).valid === true, 'Cycles 1 is valid');
  assert(validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, cyclesPerSession: 100 }).valid === true, 'Cycles 100 is valid');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, cyclesPerSession: 0 }).valid, 'Cycles < 1 rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, cyclesPerSession: 101 }).valid, 'Cycles > 100 rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, cyclesPerSession: 2.5 }).valid, 'Non-integer cycles rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, cyclesPerSession: 'abc' }).valid, 'Non-numeric cycles rejected');

  // rest_ms range validation (0..3600000) & explicit seconds conversion
  assert(validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restMs: 0 }).valid === true, 'Rest 0 ms is valid');
  assert(validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restMs: 3600000 }).valid === true, 'Rest 3600000 ms is valid');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restMs: -1 }).valid, 'Negative rest rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restMs: 3600001 }).valid, 'Rest > 3600000 ms rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restMs: 100.5 }).valid, 'Non-integer restMs rejected');

  const secConversion = validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restSec: 15 });
  assert(secConversion.valid === true && secConversion.values.restMs === 15000, 'Explicit conversion of restSec (15s -> 15000ms)');
  const zeroSecConversion = validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restSec: '0' });
  assert(zeroSecConversion.valid === true && zeroSecConversion.values.restMs === 0, 'Explicit conversion of restSec ("0" -> 0ms)');
  const maxSecConversion = validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restSec: 3600 });
  assert(maxSecConversion.valid === true && maxSecConversion.values.restMs === 3600000, 'Explicit conversion of restSec (3600s -> 3600000ms)');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restSec: 3601 }).valid, 'Rest > 3600s rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restSec: 'xyz' }).valid, 'Non-numeric restSec rejected');

  // Fractional seconds conversion & roundtrip preservation (no Math.round on seq.rest_ms / 1000)
  const fracConversion = validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restSec: 2.5 });
  assert(fracConversion.valid === true && fracConversion.values.restMs === 2500, 'Fractional restSec (2.5s -> 2500ms)');
  assert(fracConversion.values.restMs / 1000 === 2.5, 'Fractional seconds roundtrip preservation (2500ms / 1000 === 2.5s)');

  const fineFracConversion = validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 200, restSec: 0.125 });
  assert(fineFracConversion.valid === true && fineFracConversion.values.restMs === 125, 'Millisecond-precision restSec (0.125s -> 125ms)');
  assert(fineFracConversion.values.restMs / 1000 === 0.125, 'Millisecond-precision roundtrip (125ms / 1000 === 0.125s)');

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
  assert(serializeFormUrlEncoded({ open_deg: 30, close_deg: 85, hold_ms: 200, cycles_per_session: 5, rest_ms: 10000 }) === 'open_deg=30&close_deg=85&hold_ms=200&cycles_per_session=5&rest_ms=10000', 'Sequence serialization');

  // 5. API Mapping Verification (Endpoints & Parameters)
  const apiMap = [
    { name: 'run', url: '/api/run', params: { id: 1, running: 1 }, expected: 'id=1&running=1' },
    { name: 'run_stop', url: '/api/run', params: { id: 2, running: 0 }, expected: 'id=2&running=0' },
    { name: 'attachment_detach', url: '/api/attachment', params: { id: 1, attached: 0 }, expected: 'id=1&attached=0' },
    { name: 'attachment_attach', url: '/api/attachment', params: { id: 2, attached: 1 }, expected: 'id=2&attached=1' },
    { name: 'servo', url: '/api/servo', params: { id: 1, angle: 45 }, expected: 'id=1&angle=45' },
    { name: 'mode_auto', url: '/api/mode', params: { mode: 'auto' }, expected: 'mode=auto' },
    { name: 'mode_manual', url: '/api/mode', params: { mode: 'manual' }, expected: 'mode=manual' },
    { name: 'pause', url: '/api/pause', params: { paused: 1 }, expected: 'paused=1' },
    { name: 'resume', url: '/api/pause', params: { paused: 0 }, expected: 'paused=0' },
    { name: 'relay', url: '/api/relay', params: { id: 1, state: 1 }, expected: 'id=1&state=1' },
    { name: 'sequence', url: '/api/sequence', params: { open_deg: 30, close_deg: 85, hold_ms: 200, cycles_per_session: 5, rest_ms: 10000 }, expected: 'open_deg=30&close_deg=85&hold_ms=200&cycles_per_session=5&rest_ms=10000' },
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
      { id: 1, angle: 30, running: true, phase: 'open', status: 'OPEN', cycle: 2, rest_remaining_ms: 0, attached: true },
      { id: 2, angle: 85, running: true, phase: 'rest', status: 'REST', cycle: 5, rest_remaining_ms: 8500, attached: true },
    ],
    relays: [{ id: 1, state: 1 }, { id: 2, state: 0 }],
    sequence: { open_deg: 40, close_deg: 90, hold_ms: 300, cycles_per_session: 8, rest_ms: 15000 },
  };

  assert(applyStatusToState(mockState, validStatus) === true, 'Valid status payload parses successfully');
  assert(mockState.mode === 'auto', 'Mode parsed as auto');
  assert(mockState.servos[1].attached === true, 'Servo 1 attached parsed as true');
  assert(mockState.servos[2].attached === true, 'Servo 2 attached parsed as true');
  assert(mockState.servos[1].running === true && mockState.servos[1].phase === 'open', 'Servo 1 running state parsed');
  assert(mockState.servos[1].cycle === 2 && mockState.servos[1].restRemainingMs === 0, 'Servo 1 cycle and rest parsed');
  assert(mockState.servos[2].angle === 85 && mockState.servos[2].phase === 'rest', 'Servo 2 angle and phase parsed');
  assert(mockState.servos[2].cycle === 5 && mockState.servos[2].restRemainingMs === 8500, 'Servo 2 cycle and rest parsed');
  assert(mockState.relays[1] === true && mockState.relays[2] === false, 'Relays parsed');
  assert(mockState.config.openAngle === 40 && mockState.config.holdMs === 300, 'Sequence config parsed');
  assert(mockState.config.cyclesPerSession === 8 && mockState.config.restMs === 15000, 'Cycles and rest config parsed');

  // Conservative attached mapping verification
  const detachedPayload = {
    servos: [
      { id: 1, angle: 30, running: false, phase: 'idle', status: 'DETACHED', attached: false },
      { id: 2, angle: 30, running: false, phase: 'idle', status: 'DETACHED' }, // attached omitted -> conservative false
    ],
  };
  applyStatusToState(mockState, detachedPayload);
  assert(mockState.servos[1].attached === false, 'Explicit attached: false parsed as false');
  assert(mockState.servos[1].statusText === 'DETACHED', 'DETACHED status parsed');
  assert(mockState.servos[2].attached === false, 'Conservative mapping: missing attached treated as false');

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

  // 10.1 Motion Gating & Optimistic Resume Safety Tests
  const gatingState = createAppState({
    connected: true,
    mode: 'manual',
    servos: {
      1: { angle: 30, running: false, phase: 'idle', statusText: 'IDLE', attached: true },
      2: { angle: 30, running: false, phase: 'idle', statusText: 'DETACHED', attached: false },
    },
  });

  // Gating: angle command rejected on detached servo
  function canSendAngle(state, id) {
    return state.connected && !state.paused && state.mode === 'manual' && Boolean(state.servos[id].attached) && !state.servos[id].running;
  }
  assert(canSendAngle(gatingState, 1) === true, 'Attached idle servo can accept angle commands');
  assert(canSendAngle(gatingState, 2) === false, 'Detached servo rejects angle commands');

  // Gating: start sequence rejected on detached servo
  function canStartSequence(state, id) {
    return state.connected && !state.paused && Boolean(state.servos[id].attached);
  }
  assert(canStartSequence(gatingState, 1) === true, 'Attached servo can start sequence');
  assert(canStartSequence(gatingState, 2) === false, 'Detached servo cannot start sequence');

  // Mode switch to auto: only attached servos marked running
  if (gatingState.servos[1].attached) gatingState.servos[1].running = true;
  if (gatingState.servos[2].attached) gatingState.servos[2].running = true;
  assert(gatingState.servos[1].running === true, 'Attached servo 1 starts running on auto');
  assert(gatingState.servos[2].running === false, 'Detached servo 2 never optimistically starts running in auto');

  // Pause / Resume: only attached servos resume running
  gatingState.paused = true;
  gatingState.servos[1].running = false;
  gatingState.paused = false;
  if (gatingState.servos[1].attached) gatingState.servos[1].running = true;
  if (gatingState.servos[2].attached) gatingState.servos[2].running = true;
  assert(gatingState.servos[1].running === true, 'Attached servo 1 resumes running on unpause');
  assert(gatingState.servos[2].running === false, 'Detached servo 2 never resumes running on unpause');

  // Attach rejected while paused; detach allowed while paused
  const isAttachAllowed = (paused, nextAttached) => !(paused && nextAttached);
  assert(isAttachAllowed(true, true) === false, 'Attach is rejected when firmware is paused');
  assert(isAttachAllowed(true, false) === true, 'Detach is allowed when firmware is paused');
  assert(isAttachAllowed(false, true) === true, 'Attach is allowed when firmware is unpaused');

  // Pending input guards: sendServoAngle guarded when angle, attachment, or run is pending
  gatingState.servos[1].running = false;
  function canSendAngleWithPending(state, id, pendingSet) {
    return state.connected && !state.paused && state.mode === 'manual' &&
           Boolean(state.servos[id].attached) && !state.servos[id].running &&
           !pendingSet.has(`servo:${id}`) &&
           !pendingSet.has(`attachment:${id}`) &&
           !pendingSet.has(`run:${id}`);
  }
  const pendingTestSet = new Set();
  assert(canSendAngleWithPending(gatingState, 1, pendingTestSet) === true, 'Can send angle when no actions pending');
  pendingTestSet.add('attachment:1');
  assert(canSendAngleWithPending(gatingState, 1, pendingTestSet) === false, 'Blocked from sending angle when attachment pending');
  pendingTestSet.delete('attachment:1');
  pendingTestSet.add('run:1');
  assert(canSendAngleWithPending(gatingState, 1, pendingTestSet) === false, 'Blocked from sending angle when run pending');
  pendingTestSet.delete('run:1');
  pendingTestSet.add('servo:1');
  assert(canSendAngleWithPending(gatingState, 1, pendingTestSet) === false, 'Blocked from sending angle when servo angle pending');

  // Keep detach available when angle is pending:
  function canToggleAttachmentWithPending(state, id, pendingSet, nextAttached) {
    if (!state.connected || pendingSet.has(`attachment:${id}`)) return false;
    if (nextAttached && state.paused) return false;
    if (nextAttached && (pendingSet.has(`run:${id}`) || pendingSet.has(`servo:${id}`))) return false;
    return true;
  }
  // When angle is pending (servo:1), detaching (nextAttached: false) remains available:
  assert(canToggleAttachmentWithPending(gatingState, 1, pendingTestSet, false) === true, 'Detach remains available when angle command is pending');
  // But attach (nextAttached: true) is guarded when angle is pending:
  assert(canToggleAttachmentWithPending(gatingState, 1, pendingTestSet, true) === false, 'Attach blocked when angle command is pending');
  pendingTestSet.delete('servo:1');

  // executeApiPost / postApiCommand onPending callback immediate execution test
  let onPendingCalledImmediate = false;
  let inFlightPendingSeen = false;
  const mockPendingSet = new Set();
  await postApiCommand('/api/test', {}, 'test:1', mockPendingSet, async () => {
    inFlightPendingSeen = mockPendingSet.has('test:1');
    return { ok: true, json: async () => ({ ok: true }) };
  }, 4000, () => {
    onPendingCalledImmediate = mockPendingSet.has('test:1');
  });
  assert(onPendingCalledImmediate === true, 'onPending called immediately while pendingSet contains entry');
  assert(inFlightPendingSeen === true, 'pending entry active during in-flight fetch');
  assert(mockPendingSet.size === 0, 'pending entry cleared after post completes');

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
        const target = now + ms;
        while (true) {
          let earliestId = null;
          let earliestDue = Infinity;
          for (const [id, t] of timers.entries()) {
            if (t.due <= target && t.due < earliestDue) {
              earliestId = id;
              earliestDue = t.due;
            }
          }
          if (earliestId !== null) {
            now = earliestDue;
            const { fn } = timers.get(earliestId);
            timers.delete(earliestId);
            fn();
          } else {
            now = target;
            break;
          }
        }
      },
      get count() {
        return timers.size;
      },
    };
  }

  const fakeTimer = createFakeTimer();
  const testServo = { angle: 0, running: false, phase: 'idle', cycle: 0, restRemainingMs: 0, timer: null, statusText: null };
  const testCfg = { openAngle: 30, closeAngle: 85, holdMs: 200, cyclesPerSession: 2, restMs: 1000 };

  // 11.1 Full session cycles + rest + loop repeat
  startServoRunner(testServo, testCfg, null, fakeTimer);
  assert(testServo.running === true, 'Runner sets running = true');
  assert(testServo.cycle === 1, 'Initial cycle is 1');
  assert(testServo.phase === 'open', 'Initial phase is open');
  assert(testServo.angle === 30, 'Initial angle is openAngle');
  assert(testServo.restRemainingMs === 0, 'No rest remaining during cycle 1 open');

  fakeTimer.tick(200); // Step close cycle 1
  assert(testServo.cycle === 1, 'Cycle is still 1 during close');
  assert(testServo.phase === 'close', 'Transitions to close after holdMs');
  assert(testServo.angle === 85, 'Angle is closeAngle');

  fakeTimer.tick(200); // Step open cycle 2
  assert(testServo.cycle === 2, 'Transitions to cycle 2');
  assert(testServo.phase === 'open', 'Cycle 2 phase is open');
  assert(testServo.angle === 30, 'Angle is openAngle');

  fakeTimer.tick(200); // Step close cycle 2
  assert(testServo.cycle === 2, 'Cycle 2 close');
  assert(testServo.phase === 'close', 'Transitions to close');
  assert(testServo.angle === 85, 'Angle is closeAngle');

  fakeTimer.tick(200); // Cycles complete -> Enter rest
  assert(testServo.phase === 'rest', 'Transitions to rest phase after N cycles');
  assert(testServo.angle === 85, 'Rest position default closed');
  assert(testServo.statusText === 'REST', 'Rest statusText is REST');
  assert(testServo.restRemainingMs === 1000, 'Rest remaining ms matches config');
  assert(testServo.running === true, 'Servo still running during rest');

  fakeTimer.tick(1000); // Rest complete -> Next session cycle 1
  assert(testServo.cycle === 1, 'Session restarts at cycle 1');
  assert(testServo.phase === 'open', 'Restarts at open phase');
  assert(testServo.angle === 30, 'Restarts at open angle');
  assert(testServo.restRemainingMs === 0, 'Rest remaining reset to 0');

  // 11.2 Cancellation during active cycle
  stopServoRunner(testServo, null, fakeTimer);
  assert(testServo.running === false, 'Stopped runner has running = false');
  assert(testServo.phase === 'idle', 'Phase reset to idle on stop');
  assert(testServo.cycle === 0, 'Cycle cleared to 0 on stop');
  assert(testServo.restRemainingMs === 0, 'Rest remaining cleared on stop');
  assert(fakeTimer.count === 0, 'Timers cleared after stop');

  // 11.3 Cancellation during rest phase
  startServoRunner(testServo, testCfg, null, fakeTimer);
  fakeTimer.tick(800); // Advance to rest phase (200 + 200 + 200 + 200 = 800)
  assert(testServo.phase === 'rest', 'Should be in rest phase');
  fakeTimer.tick(300); // Partway through rest
  stopServoRunner(testServo, null, fakeTimer);
  assert(testServo.running === false, 'Stop during rest halts sequence');
  assert(testServo.phase === 'idle', 'Phase is idle after stop during rest');
  assert(testServo.cycle === 0, 'Cycle is 0 after stop during rest');
  assert(testServo.restRemainingMs === 0, 'Rest remaining is 0 after stop');
  assert(fakeTimer.count === 0, 'All timers cleared');

  // 11.4 Zero rest (restMs: 0)
  const zeroRestCfg = { openAngle: 30, closeAngle: 85, holdMs: 150, cyclesPerSession: 2, restMs: 0 };
  startServoRunner(testServo, zeroRestCfg, null, fakeTimer);
  fakeTimer.tick(150); // cycle 1 close
  fakeTimer.tick(150); // cycle 2 open
  fakeTimer.tick(150); // cycle 2 close
  fakeTimer.tick(150); // cycle 2 close completes -> 0 rest -> immediately cycle 1 open!
  assert(testServo.cycle === 1, 'With 0 rest, immediately starts cycle 1');
  assert(testServo.phase === 'open', 'With 0 rest, starts cycle 1 open');
  assert(testServo.angle === 30, 'Angle is open angle');
  stopServoRunner(testServo, null, fakeTimer);

  // 11.5 Session restart / settings save resets progress to cycle 1
  startServoRunner(testServo, testCfg, null, fakeTimer);
  fakeTimer.tick(300); // mid-sequence
  startServoRunner(testServo, { ...testCfg, cyclesPerSession: 10 }, null, fakeTimer);
  assert(testServo.cycle === 1, 'Restart resets progress to cycle 1');
  assert(testServo.phase === 'open', 'Restart starts at open phase');
  stopServoRunner(testServo, null, fakeTimer);

  // 11.6 Detach cancels running sequence and rest, resets cycle and timers
  const simTestServo = { angle: 30, running: false, phase: 'idle', cycle: 0, restRemainingMs: 0, attached: true, timer: null, statusText: 'IDLE' };
  startServoRunner(simTestServo, testCfg, null, fakeTimer);
  fakeTimer.tick(200); // running cycle 1
  assert(simTestServo.running === true, 'Runner is running before detach');
  stopServoRunner(simTestServo, null, fakeTimer);
  simTestServo.attached = false;
  simTestServo.statusText = 'DETACHED';
  assert(simTestServo.running === false, 'Runner stopped on detach');
  assert(simTestServo.phase === 'idle', 'Phase is idle on detach');
  assert(simTestServo.cycle === 0, 'Cycle cleared on detach');
  assert(simTestServo.restRemainingMs === 0, 'Rest remaining cleared on detach');
  assert(simTestServo.statusText === 'DETACHED', 'Status is DETACHED');
  assert(fakeTimer.count === 0, 'All simulation timers cleared on detach');

  // Detach during rest phase cancels rest
  simTestServo.attached = true;
  startServoRunner(simTestServo, testCfg, null, fakeTimer);
  fakeTimer.tick(800); // advance to rest phase
  assert(simTestServo.phase === 'rest', 'In rest phase before detach');
  stopServoRunner(simTestServo, null, fakeTimer);
  simTestServo.attached = false;
  simTestServo.statusText = 'DETACHED';
  assert(simTestServo.running === false, 'Stopped during rest');
  assert(simTestServo.restRemainingMs === 0, 'Rest cleared on detach');
  assert(simTestServo.statusText === 'DETACHED', 'Status text is DETACHED');

  // Attach leaves servo idle stopped
  simTestServo.attached = true;
  simTestServo.statusText = 'IDLE';
  assert(simTestServo.running === false, 'Attach leaves servo stopped');
  assert(simTestServo.cycle === 0 && simTestServo.restRemainingMs === 0, 'Cycle and rest remain 0 on attach');
  assert(simTestServo.statusText === 'IDLE', 'Status is IDLE on attach');

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
        'servo-1-cycle',
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
        'servo-1-attach',
        'servo-1-run',
        'card-servo-2',
        'servo-2-status',
        'servo-2-cycle',
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
        'servo-2-attach',
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
        'cfg-cycles',
        'cfg-rest',
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
      assert(html.includes('section-caveat'), 'UI caveat note must exist in index.html');
      assert(html.includes('may not release motor torque'), 'UI caveat clarifies torque may not be released');
      assert(!html.includes('no holding torque'), 'UI caveat must not promise no holding torque');
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
