/**
 * NOYA — Control Panel Preview (Standalone Simulation)
 * Minimal, dependency-free controller for browser and CLI self-test.
 */

// ─── PURE LOGIC & CONFIGURATION ─────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  openAngle: 30,
  closeAngle: 85,
  holdMs: 200,
});

const DEFAULT_PRESETS = Object.freeze([30, 85]);

/**
 * Validates sequence parameters.
 * Requirements: integer angles (0-180), distinct angles, hold 50-5000ms.
 * Repeat interval setting has been removed.
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
 * Starts continuous open->hold->close->hold alternating sequence.
 * Runs until explicitly stopped.
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

// ─── BROWSER SIMULATION APP ─────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // Application State
    const state = {
      mode: 'manual', // 'manual' | 'auto'
      paused: false,
      config: { ...DEFAULT_CONFIG },
      servos: {
        1: { angle: 30, running: false, phase: 'idle', timer: null, statusText: null, presets: [...DEFAULT_PRESETS] },
        2: { angle: 30, running: false, phase: 'idle', timer: null, statusText: null, presets: [...DEFAULT_PRESETS] },
      },
      relays: {
        1: false,
        2: false,
      },
    };

    // DOM References
    const dom = {
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
    };

    // ── Helper UI Updates ──

    function updateServoUI(id) {
      const s = state.servos[id];
      const isS1 = id === 1;
      const angleElem = isS1 ? dom.servo1Angle : dom.servo2Angle;
      const sliderElem = isS1 ? dom.servo1Slider : dom.servo2Slider;
      const numberElem = isS1 ? dom.servo1Number : dom.servo2Number;
      const errorElem = isS1 ? dom.servo1Error : dom.servo2Error;
      const statusElem = isS1 ? dom.servo1Status : dom.servo2Status;

      angleElem.textContent = `${s.angle}°`;
      sliderElem.value = s.angle;
      numberElem.value = s.angle;
      numberElem.classList.remove('is-invalid');
      numberElem.removeAttribute('aria-invalid');
      errorElem.textContent = '';

      if (s.running) {
        statusElem.className = 'status-pill pill-running';
        statusElem.textContent = s.statusText || 'OPEN';
      } else if (state.paused) {
        statusElem.className = 'status-pill pill-paused';
        statusElem.textContent = 'PAUSED';
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
      const isPaused = state.paused;
      const isAuto = state.mode === 'auto';

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

        // Exact angle sliders/numbers and presets are manual only, locked when running or in auto
        const manualLocked = isPaused || isAuto || s.running;
        slider.disabled = manualLocked;
        number.disabled = manualLocked;
        p1Btn.disabled = manualLocked;
        p2Btn.disabled = manualLocked;
        pVal1.disabled = manualLocked;
        pVal2.disabled = manualLocked;

        // Run/Stop button: Start sequence when idle / Stop sequence when running
        // Usable in Auto & Manual; disabled ONLY when paused
        runBtn.disabled = isPaused;
        runBtn.textContent = s.running ? 'Stop sequence' : 'Start sequence';
        runBtn.setAttribute('aria-label', `${s.running ? 'Stop' : 'Start'} sequence for Servo ${id}`);
        runBtn.classList.toggle('btn-stop', s.running);

        badge.textContent = isAuto ? '(Locked in Auto)' : (s.running ? '(Sequence running)' : '(Manual only)');
      }

      dom.relay1Toggle.disabled = isPaused;
      dom.relay2Toggle.disabled = isPaused;
    }

    function updateStatusBar() {
      dom.statMode.textContent = state.mode.toUpperCase();
      dom.statSim.textContent = state.paused ? 'PAUSED' : 'ACTIVE';
      dom.statSim.className = `cell-val ${state.paused ? 'text-muted' : 'text-teal'}`;

      if (state.paused) {
        dom.statAutoDue.textContent = 'Suspended (Paused)';
      } else if (state.servos[1].running || state.servos[2].running) {
        const s1 = state.servos[1];
        const s2 = state.servos[2];
        if (s1.running && s2.running) {
          dom.statAutoDue.textContent = `Running (S1: ${s1.statusText}, S2: ${s2.statusText})`;
        } else if (s1.running) {
          dom.statAutoDue.textContent = `Running (Servo 1: ${s1.statusText})`;
        } else {
          dom.statAutoDue.textContent = `Running (Servo 2: ${s2.statusText})`;
        }
      } else if (state.mode === 'manual') {
        dom.statAutoDue.textContent = 'Standby (Manual)';
      } else {
        dom.statAutoDue.textContent = 'Standby (Auto idle)';
      }
    }

    // ── Sequence Controller Operations ──

    function startServo(id) {
      if (state.paused) return;
      startServoRunner(state.servos[id], state.config, () => {
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
      });
    }

    function stopServo(id) {
      stopServoRunner(state.servos[id], () => {
        updateServoUI(id);
        updateControlsDisabledState();
        updateStatusBar();
      });
    }

    function toggleServo(id) {
      if (state.paused) return;
      if (state.servos[id].running) {
        stopServo(id);
      } else {
        startServo(id);
      }
    }

    // ── Mode & Pause Transitions ──

    function setMode(newMode) {
      if (state.mode === newMode) return;
      state.mode = newMode;

      const isAuto = newMode === 'auto';
      dom.btnModeAuto.classList.toggle('active', isAuto);
      dom.btnModeAuto.setAttribute('aria-pressed', String(isAuto));
      dom.btnModeManual.classList.toggle('active', !isAuto);
      dom.btnModeManual.setAttribute('aria-pressed', String(!isAuto));

      if (isAuto) {
        // Auto selecting starts both
        if (!state.paused) {
          startServo(1);
          startServo(2);
        }
      } else {
        // Switching Manual stops both
        stopServo(1);
        stopServo(2);
      }

      updateControlsDisabledState();
      updateStatusBar();
    }

    function togglePause() {
      state.paused = !state.paused;

      if (state.paused) {
        // Pause stops both, clears all timers and disables movements except resume
        stopServo(1);
        stopServo(2);
        dom.btnPauseSim.textContent = 'Resume Sim';
        dom.btnPauseSim.classList.add('paused');
        dom.btnPauseSim.setAttribute('aria-pressed', 'true');
      } else {
        dom.btnPauseSim.textContent = 'Pause Sim';
        dom.btnPauseSim.classList.remove('paused');
        dom.btnPauseSim.setAttribute('aria-pressed', 'false');

        // Resume in Manual does not restart loops; Auto resume starts fresh loops
        if (state.mode === 'auto') {
          startServo(1);
          startServo(2);
        }
      }

      updateServoUI(1);
      updateServoUI(2);
      updateControlsDisabledState();
      updateStatusBar();
    }

    // ── Event Bindings ──

    dom.btnModeManual.addEventListener('click', () => setMode('manual'));
    dom.btnModeAuto.addEventListener('click', () => setMode('auto'));
    dom.btnPauseSim.addEventListener('click', togglePause);

    // Servo Start/Stop Sequence Buttons
    dom.servo1Run.addEventListener('click', () => toggleServo(1));
    dom.servo2Run.addEventListener('click', () => toggleServo(2));

    // Sliders
    function handleSliderInput(id, event) {
      if (state.mode !== 'manual' || state.paused || state.servos[id].running) return;
      state.servos[id].angle = Number(event.target.value);
      updateServoUI(id);
    }

    dom.servo1Slider.addEventListener('input', (e) => handleSliderInput(1, e));
    dom.servo2Slider.addEventListener('input', (e) => handleSliderInput(2, e));

    // Servo Numeric Inputs
    function applyServoNumberInput(id) {
      if (state.mode !== 'manual' || state.paused || state.servos[id].running) return;

      const isS1 = id === 1;
      const numInput = isS1 ? dom.servo1Number : dom.servo2Number;
      const errElem = isS1 ? dom.servo1Error : dom.servo2Error;

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

      state.servos[id].angle = res.value;
      updateServoUI(id);
    }

    function restoreServoNumberInput(id) {
      const isS1 = id === 1;
      const numInput = isS1 ? dom.servo1Number : dom.servo2Number;
      const errElem = isS1 ? dom.servo1Error : dom.servo2Error;

      numInput.value = state.servos[id].angle;
      numInput.classList.remove('is-invalid');
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
        errElem.textContent = '';
        numInput.classList.remove('is-invalid');
        numInput.removeAttribute('aria-invalid');
      });
    }

    bindServoNumberEvents(1, dom.servo1Number, dom.servo1Error);
    bindServoNumberEvents(2, dom.servo2Number, dom.servo2Error);

    // Servo Presets
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
      if (state.mode !== 'manual' || state.paused || state.servos[servoId].running) return;
      state.servos[servoId].angle = state.servos[servoId].presets[index];
      updateServoUI(servoId);
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

    // Relays
    function handleRelayChange(id, event) {
      if (state.paused) {
        event.target.checked = state.relays[id];
        return;
      }
      state.relays[id] = event.target.checked;
      updateRelayUI(id);
    }

    dom.relay1Toggle.addEventListener('change', (e) => handleRelayChange(1, e));
    dom.relay2Toggle.addEventListener('change', (e) => handleRelayChange(2, e));

    // Sequence Settings Form
    dom.settingsForm.addEventListener('submit', (e) => {
      e.preventDefault();

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

      state.config = result.values;
      dom.settingsFeedback.className = 'feedback-msg feedback-success';
      dom.settingsFeedback.textContent = 'Sequence parameters successfully applied.';

      // Restart any active loops with new config (no duplicate timers)
      [1, 2].forEach((id) => {
        if (state.servos[id].running && !state.paused) {
          startServo(id);
        }
      });
      updateStatusBar();
    });

    dom.btnResetSettings.addEventListener('click', () => {
      state.config = { ...DEFAULT_CONFIG };
      dom.cfgOpen.value = DEFAULT_CONFIG.openAngle;
      dom.cfgClose.value = DEFAULT_CONFIG.closeAngle;
      dom.cfgHold.value = DEFAULT_CONFIG.holdMs;

      dom.settingsFeedback.className = 'feedback-msg feedback-success';
      dom.settingsFeedback.textContent = 'Factory defaults restored (30°/85°, 200ms).';

      // Restart any active loops with new config (no duplicate timers)
      [1, 2].forEach((id) => {
        if (state.servos[id].running && !state.paused) {
          startServo(id);
        }
      });
      updateStatusBar();
    });

    // Initial Render
    updateServoUI(1);
    updateServoUI(2);
    updateRelayUI(1);
    updateRelayUI(2);
    updateControlsDisabledState();
    updateStatusBar();
  });
}

// ─── CLI SELF-TEST (NODE CLI) ───────────────────────────────────────────────

function runSelfTest() {
  let assertions = 0;
  function assert(cond, msg) {
    assertions++;
    if (!cond) throw new Error(`Self-test failed: ${msg}`);
  }

  // 1. Validation test cases (without repeat interval)
  const validDefault = validateSettings(DEFAULT_CONFIG);
  assert(validDefault.valid === true, 'Default configuration must be valid');
  assert(validDefault.values.openAngle === 30, 'Parsed open angle should be 30');
  assert(validDefault.values.closeAngle === 85, 'Parsed close angle should be 85');
  assert(validDefault.values.holdMs === 200, 'Parsed hold ms should be 200');
  assert(!('intervalSec' in validDefault.values), 'Repeat interval must not be present in validated values');

  assert(!validateSettings({ openAngle: 30, closeAngle: 30, holdMs: 200 }).valid, 'Identical open & close angles rejected');
  assert(!validateSettings({ openAngle: -1, closeAngle: 85, holdMs: 200 }).valid, 'Negative open angle rejected');
  assert(!validateSettings({ openAngle: 181, closeAngle: 85, holdMs: 200 }).valid, 'Open angle > 180 rejected');
  assert(!validateSettings({ openAngle: 30.5, closeAngle: 85, holdMs: 200 }).valid, 'Non-integer open angle rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: -1, holdMs: 200 }).valid, 'Negative close angle rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 181, holdMs: 200 }).valid, 'Close angle > 180 rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85.5, holdMs: 200 }).valid, 'Non-integer close angle rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 40 }).valid, 'Hold < 50ms rejected');
  assert(!validateSettings({ openAngle: 30, closeAngle: 85, holdMs: 5001 }).valid, 'Hold > 5000ms rejected');
  assert(!validateSettings(null).valid, 'null rejected');

  // 2. Servo angle validation test cases
  assert(validateServoAngle(30).valid === true && validateServoAngle(30).value === 30, 'Integer 30 should be valid');
  assert(validateServoAngle('0').valid === true && validateServoAngle('0').value === 0, 'String "0" should be valid');
  assert(validateServoAngle('180').valid === true && validateServoAngle('180').value === 180, 'String "180" should be valid');
  assert(validateServoAngle('  45  ').valid === true && validateServoAngle('  45  ').value === 45, 'Whitespace around "45" should be trimmed');
  assert(validateServoAngle('+30').valid === true && validateServoAngle('+30').value === 30, '"+30" should parse to 30');
  assert(validateServoAngle('-0').valid === true && Object.is(validateServoAngle('-0').value, 0), '"-0" should normalize to 0');
  assert(!validateServoAngle('').valid, 'Empty string angle rejected (avoid Number("") === 0)');
  assert(!validateServoAngle('   ').valid, 'Blank spaces rejected');
  assert(!validateServoAngle(null).valid, 'null rejected');
  assert(!validateServoAngle(undefined).valid, 'undefined rejected');
  assert(!validateServoAngle(-1).valid, 'Negative angle rejected');
  assert(!validateServoAngle(181).valid, 'Angle > 180 rejected');
  assert(!validateServoAngle(30.5).valid, 'Decimal number rejected');
  assert(!validateServoAngle('30.5').valid, 'Decimal string rejected');
  assert(!validateServoAngle('abc').valid, 'Non-numeric string rejected');
  assert(!validateServoAngle('1e2').valid, 'Scientific notation string rejected');

  // 3. Preset validation & independent defaults test cases
  assert(DEFAULT_PRESETS.length === 2 && DEFAULT_PRESETS[0] === 30 && DEFAULT_PRESETS[1] === 85, 'Default presets are 30 and 85');
  assert(validateServoAngle(DEFAULT_PRESETS[0]).valid && validateServoAngle(DEFAULT_PRESETS[1]).valid, 'Default preset angles must validate');
  assert(!validateServoAngle(-1).valid, 'Negative preset angle rejected');
  assert(!validateServoAngle(181).valid, 'Preset angle > 180 rejected');
  assert(!validateServoAngle('').valid, 'Blank preset angle rejected');
  assert(!validateServoAngle('45.5').valid, 'Decimal preset angle rejected');
  assert(validateServoAngle('0').value === 0, 'Preset 0° parses correctly');
  assert(validateServoAngle('180').value === 180, 'Preset 180° parses correctly');

  // 4. Lightweight Fake Timer for Runner Testing
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

  // 5. Continuous alternating sequence tests (Open -> Hold -> Close -> Hold alternating)
  const fakeTimer = createFakeTimer();
  const testServo1 = { angle: 0, running: false, phase: 'idle', timer: null, statusText: null };
  const cfg = { openAngle: 30, closeAngle: 85, holdMs: 200 };

  startServoRunner(testServo1, cfg, null, fakeTimer);
  assert(testServo1.running === true, 'Runner sets running=true on start');
  assert(testServo1.phase === 'open', 'Phase starts at open');
  assert(testServo1.angle === 30, 'Angle moves immediately to openAngle 30°');
  assert(testServo1.statusText === 'OPEN', 'Status text is OPEN during open phase');
  assert(fakeTimer.count === 1, 'Exactly one timer scheduled for hold delay');

  // Tick 1 holdMs -> transitions to close
  fakeTimer.tick(200);
  assert(testServo1.phase === 'close', 'After holdMs, phase transitions to close');
  assert(testServo1.angle === 85, 'Angle moves to closeAngle 85°');
  assert(testServo1.statusText === 'CLOSE', 'Status text is CLOSE during close phase');
  assert(fakeTimer.count === 1, 'Next hold timer scheduled');

  // Tick 2 holdMs -> transitions back to open
  fakeTimer.tick(200);
  assert(testServo1.phase === 'open', 'After second holdMs, phase transitions back to open');
  assert(testServo1.angle === 30, 'Angle returns to openAngle 30°');
  assert(testServo1.statusText === 'OPEN', 'Status text is OPEN again');

  // Tick 3 holdMs -> transitions back to close
  fakeTimer.tick(200);
  assert(testServo1.phase === 'close', 'Cycle 2 close phase');
  assert(testServo1.angle === 85, 'Angle moves to closeAngle 85° again');

  // 6. Stop cancels timer, holds current angle, and clears running state
  stopServoRunner(testServo1, null, fakeTimer);
  assert(testServo1.running === false, 'Stop clears running state');
  assert(testServo1.timer === null, 'Stop nullifies timer ref');
  assert(testServo1.phase === 'idle', 'Stop sets phase to idle');
  assert(testServo1.statusText === null, 'Stop clears status text');
  assert(testServo1.angle === 85, 'Stop holds the current simulated angle (85°)');
  assert(fakeTimer.count === 0, 'Stop cancels timer from queue');

  // Verify cancelled timer never executes
  fakeTimer.tick(1000);
  assert(testServo1.angle === 85, 'Angle remains held after cancellation and further time passing');

  // 7. Restart with new config while running (no duplicate timers)
  startServoRunner(testServo1, cfg, null, fakeTimer);
  assert(testServo1.angle === 30, 'Restart starts at openAngle 30');
  assert(fakeTimer.count === 1, 'One timer active');

  // Apply new settings (restart active loop with new config)
  const newCfg = { openAngle: 40, closeAngle: 95, holdMs: 150 };
  startServoRunner(testServo1, newCfg, null, fakeTimer);
  assert(fakeTimer.count === 1, 'Restarting active loop replaces timer without duplicate');
  assert(testServo1.angle === 40, 'New open angle 40 applied');
  fakeTimer.tick(150);
  assert(testServo1.angle === 95, 'New close angle 95 applied after new holdMs');
  stopServoRunner(testServo1, null, fakeTimer);
  assert(fakeTimer.count === 0, 'Cleaned up timers');

  // 8. Independent multi-servo control
  const sA = { angle: 30, running: false, phase: 'idle', timer: null };
  const sB = { angle: 30, running: false, phase: 'idle', timer: null };
  startServoRunner(sA, cfg, null, fakeTimer);
  assert(sA.running === true && sB.running === false, 'Servo A running while Servo B remains idle');
  fakeTimer.tick(200);
  assert(sA.angle === 85 && sB.angle === 30, 'Only Servo A transitioned; Servo B untouched');
  stopServoRunner(sA, null, fakeTimer);
  assert(sA.running === false && sB.running === false, 'Both idle');

  // Exercise default adapters with browser-like receiver checks, not injected timers.
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const receiverTimer = createFakeTimer();
  try {
    globalThis.setTimeout = function (callback, delay) {
      assert(this === globalThis, 'setTimeout uses the global receiver');
      return receiverTimer.setTimeout(callback, delay);
    };
    globalThis.clearTimeout = function (id) {
      assert(this === globalThis, 'clearTimeout uses the global receiver');
      receiverTimer.clearTimeout(id);
    };
    const servo = { angle: 0, running: false, timer: null };
    startServoRunner(servo, cfg);
    receiverTimer.tick(200);
    assert(servo.angle === 85, 'Default timers advance the angle');
    startServoRunner(servo, cfg);
    assert(receiverTimer.count === 1, 'Default timers replace the previous loop');
    stopServoRunner(servo);
    assert(receiverTimer.count === 0, 'Default timers cancel on stop');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  // 9. DOM References Check against index.html (when running in Node)
  if (typeof require !== 'undefined') {
    const fs = require('fs');
    const path = require('path');
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      const requiredDomIds = [
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
      ];

      for (const id of requiredDomIds) {
        assert(html.includes(`id="${id}"`), `DOM element #${id} must exist in index.html`);
      }
      assert(!html.includes('id="cfg-interval"'), 'cfg-interval must be completely removed from index.html');
      assert(!html.includes('Auto Repeat Interval'), 'Auto Repeat Interval label must be removed from index.html');
    }
  }

  // ponytail: self-test logic complete
  return { ok: true, assertions };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_CONFIG,
    DEFAULT_PRESETS,
    validateSettings,
    validateServoAngle,
    startServoRunner,
    stopServoRunner,
    runSelfTest,
  };
}

// Auto-run if executed directly in node
if (typeof process !== 'undefined' && process.argv && (process.argv.includes('--test') || process.argv.includes('--self-test'))) {
  try {
    const res = runSelfTest();
    console.log(`[PASS] CLI self-test passed: ${res.assertions} assertions verified.`);
    process.exit(0);
  } catch (err) {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
  }
}
