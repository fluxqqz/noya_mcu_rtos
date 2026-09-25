/**
 * NOYA / Control Studio
 * Dual Mode: file:// Standalone Preview & Live ESP32 RTOS HTTP Dashboard.
 */

// ─── PURE DOMAIN LOGIC (SHARED: NODE / BROWSER) ─────────────────────────────

const SERVO_LIMITS = Object.freeze({
  minDeg: 0,
  maxDeg: 180,
  minUs: 500,
  maxUs: 2500,
  defaultDeg: 30,
});

const DEFAULT_SEQUENCE = Object.freeze({
  openAngle: 30,
  closeAngle: 85,
  holdMs: 200,
  intervalSec: 60,
});

const PIN_CONFIG = Object.freeze({
  servos: [5, 1, 12, 2, 3],
  relays: [4, 15],
  ultrasonic: { trig: 6, echo: 7 },
});

/**
 * Maps degrees (0-180) to servo pulse width in microseconds (500-2500).
 */
function degToMicroseconds(deg, minDeg = SERVO_LIMITS.minDeg, maxDeg = SERVO_LIMITS.maxDeg, minUs = SERVO_LIMITS.minUs, maxUs = SERVO_LIMITS.maxUs) {
  const clamped = Math.min(Math.max(Number(deg) || 0, minDeg), maxDeg);
  return Math.round(minUs + ((clamped - minDeg) * (maxUs - minUs)) / (maxDeg - minDeg));
}

/**
 * Validates sequence configuration parameters.
 */
function validateSequenceConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Invalid configuration object'], normalized: null };
  }

  const openAngle = Number(config.openAngle);
  const closeAngle = Number(config.closeAngle);
  const holdMs = Number(config.holdMs);
  const intervalSec = Number(config.intervalSec);

  if (Number.isNaN(openAngle) || openAngle < 0 || openAngle > 180) {
    errors.push('Open angle must be between 0° and 180°');
  }
  if (Number.isNaN(closeAngle) || closeAngle < 0 || closeAngle > 180) {
    errors.push('Close angle must be between 0° and 180°');
  }
  if (openAngle === closeAngle) {
    errors.push('Open angle and Close angle must be distinct');
  }
  if (Number.isNaN(holdMs) || holdMs < 50 || holdMs > 5000) {
    errors.push('Hold duration must be between 50 ms and 5000 ms');
  }
  if (Number.isNaN(intervalSec) || intervalSec < 5 || intervalSec > 600) {
    errors.push('Repeat interval must be between 5 s and 600 s');
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized: errors.length === 0 ? {
      openAngle: Math.round(openAngle),
      closeAngle: Math.round(closeAngle),
      holdMs: Math.round(holdMs),
      intervalSec: Math.round(intervalSec),
    } : null,
  };
}

/**
 * Generates the 7-step sequence matching seqMove() in rtos_non_sensor.ino.
 * Sequence alternates open/close 3 times, ending at open.
 */
function generateSequencePlan(config = DEFAULT_SEQUENCE) {
  const { openAngle, closeAngle, holdMs } = config;
  return [
    { step: 1, angle: openAngle, holdMs, label: `1/7 Open (${openAngle}°)` },
    { step: 2, angle: closeAngle, holdMs, label: `2/7 Close (${closeAngle}°)` },
    { step: 3, angle: openAngle, holdMs, label: `3/7 Open (${openAngle}°)` },
    { step: 4, angle: closeAngle, holdMs, label: `4/7 Close (${closeAngle}°)` },
    { step: 5, angle: openAngle, holdMs, label: `5/7 Open (${openAngle}°)` },
    { step: 6, angle: closeAngle, holdMs, label: `6/7 Close (${closeAngle}°)` },
    { step: 7, angle: openAngle, holdMs, label: `7/7 Final Open (${openAngle}°)` },
  ];
}

/**
 * Self-test suite runnable via `node app.js --self-test`.
 */
function runSelfTest() {
  let assertions = 0;
  function assert(condition, message) {
    assertions++;
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  try {
    // 1. Degree to Microseconds mapping
    assert(degToMicroseconds(0) === 500, '0 deg maps to 500 us');
    assert(degToMicroseconds(180) === 2500, '180 deg maps to 2500 us');
    assert(degToMicroseconds(90) === 1500, '90 deg maps to 1500 us');
    assert(degToMicroseconds(30) === 833, '30 deg maps to ~833 us');
    assert(degToMicroseconds(-10) === 500, 'Negative degree clamps to 500 us');
    assert(degToMicroseconds(200) === 2500, 'Over-range degree clamps to 2500 us');

    // 2. Sequence Validation
    const validCheck = validateSequenceConfig({ openAngle: 30, closeAngle: 85, holdMs: 200, intervalSec: 60 });
    assert(validCheck.valid === true, 'Default sequence config is valid');
    assert(validCheck.normalized.openAngle === 30, 'Normalized openAngle is 30');

    const invalidAngles = validateSequenceConfig({ openAngle: -5, closeAngle: 190, holdMs: 200, intervalSec: 60 });
    assert(invalidAngles.valid === false, 'Out-of-bound angles rejected');
    assert(invalidAngles.errors.length >= 2, 'Multiple angle errors collected');

    const equalAngles = validateSequenceConfig({ openAngle: 45, closeAngle: 45, holdMs: 200, intervalSec: 60 });
    assert(equalAngles.valid === false, 'Equal open and close angles rejected');

    const invalidTiming = validateSequenceConfig({ openAngle: 30, closeAngle: 85, holdMs: 10, intervalSec: 2 });
    assert(invalidTiming.valid === false, 'Short hold and interval rejected');

    // 3. Sequence Plan Generation
    const plan = generateSequencePlan({ openAngle: 30, closeAngle: 85, holdMs: 200, intervalSec: 60 });
    assert(Array.isArray(plan) && plan.length === 7, 'Plan has exactly 7 steps');
    assert(plan[0].angle === 30, 'Step 1 is open angle 30');
    assert(plan[1].angle === 85, 'Step 2 is close angle 85');
    assert(plan[2].angle === 30, 'Step 3 is open angle 30');
    assert(plan[3].angle === 85, 'Step 4 is close angle 85');
    assert(plan[4].angle === 30, 'Step 5 is open angle 30');
    assert(plan[5].angle === 85, 'Step 6 is close angle 85');
    assert(plan[6].angle === 30, 'Step 7 finishes at open angle 30');
    assert(plan.every(s => s.holdMs === 200), 'All steps inherit hold duration');

    // 4. Pin mapping check
    assert(PIN_CONFIG.servos.length === 5, '5 servo pins defined');
    assert(PIN_CONFIG.servos[0] === 5 && PIN_CONFIG.servos[1] === 1, 'Active servo pins are 5 and 1');
    assert(PIN_CONFIG.relays[0] === 4 && PIN_CONFIG.relays[1] === 15, 'Relay pins are 4 and 15');

    return { ok: true, passed: assertions };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Node CLI runner
if (typeof process !== 'undefined' && process.argv && process.argv.includes('--self-test')) {
  const result = runSelfTest();
  if (!result.ok) {
    console.error('FAIL: ' + result.error);
    process.exit(1);
  }
  console.log(`NOYA preview self-test passed: ${result.passed} assertions verified.`);
  process.exit(0);
}

// ─── CLIENT APPLICATION (BROWSER ENVIRONMENT) ──────────────────────────────

if (typeof document !== 'undefined') {
  (function initDashboard() {
    const isFilePreview = window.location.protocol === 'file:';

    // Application State
    const state = {
      connected: isFilePreview ? true : false,
      mode: 'manual', // 'manual' | 'auto'
      isPaused: false,
      config: { ...DEFAULT_SEQUENCE },
      countdown: DEFAULT_SEQUENCE.intervalSec,
      servos: [
        { id: 1, pin: 5, name: 'Servo 1', role: 'Cyclic RTOS Task 1', active: true, angle: 30, targetAngle: 30, status: 'IDLE', runningTimeout: null },
        { id: 2, pin: 1, name: 'Servo 2', role: 'Cyclic RTOS Task 2', active: true, angle: 30, targetAngle: 30, status: 'IDLE', runningTimeout: null },
        { id: 3, pin: 12, name: 'Servo 3', role: 'Auxiliary Channel', active: false, angle: 30, targetAngle: 30, status: 'PARKED', runningTimeout: null },
        { id: 4, pin: 2, name: 'Servo 4', role: 'Auxiliary Channel', active: false, angle: 30, targetAngle: 30, status: 'PARKED', runningTimeout: null },
        { id: 5, pin: 3, name: 'Servo 5', role: 'Auxiliary Channel', active: false, angle: 30, targetAngle: 30, status: 'PARKED', runningTimeout: null },
      ],
      relays: {
        1: { pin: 4, name: 'Relay 1', state: false },
        2: { pin: 15, name: 'Relay 2', state: false },
      },
      activityLog: [],
      maxLogs: 50,
      autoTicker: null,
      pollInterval: null,
      uptimeSeconds: 0,
      configFormEditing: false,
    };

    // DOM Elements Cache
    const el = {
      simNoticeBar: document.getElementById('sim-notice-bar'),
      simNoticeTag: document.getElementById('sim-notice-tag'),
      simNoticeSub: document.getElementById('sim-notice-sub'),
      chipTarget: document.getElementById('chip-target'),
      chipApIp: document.getElementById('chip-ap-ip'),
      chipArch: document.getElementById('chip-arch'),
      nodeTitle: document.getElementById('node-title'),
      nodeVal: document.getElementById('node-val'),
      nodeSub: document.getElementById('node-sub'),
      maintMdns: document.getElementById('maint-mdns'),
      maintApSsid: document.getElementById('maint-ap-ssid'),
      maintApNet: document.getElementById('maint-ap-net'),
      maintStaIp: document.getElementById('maint-sta-ip'),
      maintHeap: document.getElementById('maint-heap'),
      maintOtaAuth: document.getElementById('maint-ota-auth'),
      modeManualBtn: document.getElementById('mode-manual-btn'),
      modeAutoBtn: document.getElementById('mode-auto-btn'),
      pauseSimBtn: document.getElementById('pause-sim-btn'),
      pauseSimText: document.getElementById('pause-sim-text'),
      simStatusBadge: document.getElementById('sim-status-badge'),
      simCountdownVal: document.getElementById('sim-countdown-val'),
      simCountdownCard: document.getElementById('sim-countdown-card'),
      uptimeVal: document.getElementById('uptime-val'),
      activityList: document.getElementById('activity-list'),
      clearActivityBtn: document.getElementById('clear-activity-btn'),
      configForm: document.getElementById('config-form'),
      formFeedback: document.getElementById('form-feedback'),
      resetConfigBtn: document.getElementById('reset-config-btn'),
      overviewMode: document.getElementById('overview-mode'),
      overviewRelays: document.getElementById('overview-relays'),
      // Servo controls
      servo1Slider: document.getElementById('servo-1-slider'),
      servo1Val: document.getElementById('servo-1-val'),
      servo1Us: document.getElementById('servo-1-us'),
      servo1Status: document.getElementById('servo-1-status'),
      servo1Progress: document.getElementById('servo-1-progress'),
      servo1RunBtn: document.getElementById('servo-1-run'),
      servo1GaugeNeedle: document.getElementById('servo-1-gauge-needle'),
      servo1GaugeArc: document.getElementById('servo-1-gauge-arc'),

      servo2Slider: document.getElementById('servo-2-slider'),
      servo2Val: document.getElementById('servo-2-val'),
      servo2Us: document.getElementById('servo-2-us'),
      servo2Status: document.getElementById('servo-2-status'),
      servo2Progress: document.getElementById('servo-2-progress'),
      servo2RunBtn: document.getElementById('servo-2-run'),
      servo2GaugeNeedle: document.getElementById('servo-2-gauge-needle'),
      servo2GaugeArc: document.getElementById('servo-2-gauge-arc'),

      // Relay toggles
      relay1Toggle: document.getElementById('relay-1-toggle'),
      relay1Led: document.getElementById('relay-1-led'),
      relay1StateText: document.getElementById('relay-1-state-text'),
      relay2Toggle: document.getElementById('relay-2-toggle'),
      relay2Led: document.getElementById('relay-2-led'),
      relay2StateText: document.getElementById('relay-2-state-text'),

      // Table summary
      summaryBody: document.getElementById('servo-summary-body'),
    };

    // Logging helper
    function logEvent(message, level = 'info') {
      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
      const entry = { time: timeStr, message, level };
      state.activityLog.unshift(entry);
      if (state.activityLog.length > state.maxLogs) {
        state.activityLog.pop();
      }
      renderActivityLog();
    }

    function renderActivityLog() {
      if (!el.activityList) return;
      el.activityList.innerHTML = '';
      if (state.activityLog.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'activity-empty';
        empty.textContent = 'No events recorded yet.';
        el.activityList.appendChild(empty);
        return;
      }
      state.activityLog.forEach(item => {
        const li = document.createElement('li');
        li.className = `activity-item activity-${item.level}`;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'activity-time';
        timeSpan.textContent = item.time;
        const msgSpan = document.createElement('span');
        msgSpan.className = 'activity-msg';
        msgSpan.textContent = item.message;
        li.appendChild(timeSpan);
        li.appendChild(msgSpan);
        el.activityList.appendChild(li);
      });
    }

    // Gauge Update
    function updateGauge(servoId, angle) {
      const needle = servoId === 1 ? el.servo1GaugeNeedle : el.servo2GaugeNeedle;
      const arc = servoId === 1 ? el.servo1GaugeArc : el.servo2GaugeArc;
      if (!needle) return;

      const rotation = -90 + (angle / 180) * 180;
      needle.style.transform = `rotate(${rotation}deg)`;

      if (arc) {
        const totalLen = 283;
        const fillLen = (angle / 180) * totalLen;
        arc.style.strokeDasharray = `${fillLen} ${totalLen}`;
      }
    }

    // Servo UI Update
    function renderServo(servoId) {
      const s = state.servos.find(item => item.id === servoId);
      if (!s) return;

      const us = degToMicroseconds(s.angle);
      if (servoId === 1) {
        if (el.servo1Val) el.servo1Val.textContent = `${s.angle}°`;
        if (el.servo1Us) el.servo1Us.textContent = `${us} µs`;
        if (el.servo1Slider && document.activeElement !== el.servo1Slider) {
          el.servo1Slider.value = s.angle;
        }
        if (el.servo1Status) {
          el.servo1Status.textContent = s.status;
          el.servo1Status.className = `status-badge badge-${s.status.toLowerCase().replace(/\s+/g, '-')}`;
        }
        updateGauge(1, s.angle);
      } else if (servoId === 2) {
        if (el.servo2Val) el.servo2Val.textContent = `${s.angle}°`;
        if (el.servo2Us) el.servo2Us.textContent = `${us} µs`;
        if (el.servo2Slider && document.activeElement !== el.servo2Slider) {
          el.servo2Slider.value = s.angle;
        }
        if (el.servo2Status) {
          el.servo2Status.textContent = s.status;
          el.servo2Status.className = `status-badge badge-${s.status.toLowerCase().replace(/\s+/g, '-')}`;
        }
        updateGauge(2, s.angle);
      }
    }

    // Relays Render
    function renderRelays() {
      const r1 = state.relays[1];
      const r2 = state.relays[2];
      if (r1) {
        if (el.relay1Led) el.relay1Led.classList.toggle('led-on', r1.state);
        if (el.relay1StateText) el.relay1StateText.textContent = r1.state ? 'ACTIVE / ON' : 'INACTIVE / OFF';
        if (el.relay1Toggle) el.relay1Toggle.checked = r1.state;
      }
      if (r2) {
        if (el.relay2Led) el.relay2Led.classList.toggle('led-on', r2.state);
        if (el.relay2StateText) el.relay2StateText.textContent = r2.state ? 'ACTIVE / ON' : 'INACTIVE / OFF';
        if (el.relay2Toggle) el.relay2Toggle.checked = r2.state;
      }
      if (el.overviewRelays) {
        const activeCount = Object.values(state.relays).filter(r => r.state).length;
        el.overviewRelays.textContent = `${activeCount} / 2 ON`;
      }
    }

    // Summary Table Render
    function renderSummaryTable() {
      if (!el.summaryBody) return;
      el.summaryBody.innerHTML = '';
      state.servos.forEach(s => {
        const tr = document.createElement('tr');
        const us = degToMicroseconds(s.angle);
        tr.innerHTML = `
          <td><strong>${s.name}</strong></td>
          <td><code>GPIO ${s.pin}</code></td>
          <td><span class="badge ${s.active ? 'badge-active' : 'badge-idle'}">${s.active ? 'Active Loop' : 'Initialized / Inactive'}</span></td>
          <td><strong class="text-teal">${s.angle}°</strong> <span class="text-muted">(${us} µs)</span></td>
          <td>${s.active ? s.status : 'Parked (30°)'}</td>
          <td>0° – 180°</td>
        `;
        el.summaryBody.appendChild(tr);
      });
    }

    // Lock All Controls (Connection Loss)
    function lockAllControls() {
      if (el.modeManualBtn) el.modeManualBtn.disabled = true;
      if (el.modeAutoBtn) el.modeAutoBtn.disabled = true;
      if (el.pauseSimBtn) el.pauseSimBtn.disabled = true;
      if (el.servo1Slider) el.servo1Slider.disabled = true;
      if (el.servo1RunBtn) el.servo1RunBtn.disabled = true;
      if (el.servo2Slider) el.servo2Slider.disabled = true;
      if (el.servo2RunBtn) el.servo2RunBtn.disabled = true;
      document.querySelectorAll('.preset-btn').forEach(btn => btn.disabled = true);
      if (el.relay1Toggle) el.relay1Toggle.disabled = true;
      if (el.relay2Toggle) el.relay2Toggle.disabled = true;
      if (el.resetConfigBtn) el.resetConfigBtn.disabled = true;
      const submitBtn = el.configForm ? el.configForm.querySelector('button[type="submit"]') : null;
      if (submitBtn) submitBtn.disabled = true;
    }

    // UI Control Enable/Disable based on Mode & Pause state
    function updateAccessControls() {
      if (!isFilePreview && !state.connected) {
        lockAllControls();
        return;
      }

      const isAuto = state.mode === 'auto';
      const isPaused = state.isPaused;
      const s1Busy = state.servos[0].status === 'RUNNING';
      const s2Busy = state.servos[1].status === 'RUNNING';

      // Mode buttons
      if (el.modeManualBtn) {
        el.modeManualBtn.classList.toggle('active', !isAuto);
        el.modeManualBtn.setAttribute('aria-pressed', String(!isAuto));
        el.modeManualBtn.disabled = false;
      }
      if (el.modeAutoBtn) {
        el.modeAutoBtn.classList.toggle('active', isAuto);
        el.modeAutoBtn.setAttribute('aria-pressed', String(isAuto));
        el.modeAutoBtn.disabled = false;
      }

      // Sliders & quick buttons disabled if Auto or Paused or Servo busy
      const s1Locked = isAuto || isPaused || s1Busy;
      if (el.servo1Slider) el.servo1Slider.disabled = s1Locked;
      if (el.servo1RunBtn) el.servo1RunBtn.disabled = isAuto || isPaused || s1Busy;
      document.querySelectorAll('[data-servo="1"].preset-btn').forEach(btn => {
        btn.disabled = s1Locked;
      });

      const s2Locked = isAuto || isPaused || s2Busy;
      if (el.servo2Slider) el.servo2Slider.disabled = s2Locked;
      if (el.servo2RunBtn) el.servo2RunBtn.disabled = isAuto || isPaused || s2Busy;
      document.querySelectorAll('[data-servo="2"].preset-btn').forEach(btn => {
        btn.disabled = s2Locked;
      });

      // Relays disabled if paused
      if (el.relay1Toggle) el.relay1Toggle.disabled = isPaused;
      if (el.relay2Toggle) el.relay2Toggle.disabled = isPaused;

      // Config form
      if (el.resetConfigBtn) el.resetConfigBtn.disabled = isPaused;
      const submitBtn = el.configForm ? el.configForm.querySelector('button[type="submit"]') : null;
      if (submitBtn) submitBtn.disabled = isPaused;

      // Lock notice badges
      document.querySelectorAll('.manual-only-note').forEach(note => {
        note.style.display = isAuto ? 'inline-block' : 'none';
      });

      // Pause button
      if (el.pauseSimBtn) {
        el.pauseSimBtn.disabled = false;
        el.pauseSimBtn.classList.toggle('btn-paused', isPaused);
        if (el.pauseSimText) {
          if (isFilePreview) {
            el.pauseSimText.textContent = isPaused ? 'Resume Simulation' : 'Pause Simulation';
          } else {
            el.pauseSimText.textContent = isPaused ? 'Resume Software' : 'Pause Software';
          }
        }
      }

      // Status badge
      if (el.simStatusBadge) {
        if (isPaused) {
          el.simStatusBadge.textContent = isFilePreview ? 'SIMULATION PAUSED' : 'FIRMWARE PAUSED';
          el.simStatusBadge.className = 'status-badge badge-paused';
        } else {
          el.simStatusBadge.textContent = isAuto ? 'AUTO CYCLE ACTIVE' : 'MANUAL READY';
          el.simStatusBadge.className = isAuto ? 'status-badge badge-auto' : 'status-badge badge-manual';
        }
      }

      if (el.overviewMode) {
        el.overviewMode.textContent = isPaused ? 'PAUSED' : (isAuto ? 'AUTOMATIC' : 'MANUAL');
        el.overviewMode.className = `stat-val ${isPaused ? 'text-amber' : 'text-teal'}`;
      }

      if (el.simCountdownVal) {
        if (isPaused) {
          el.simCountdownVal.textContent = 'PAUSED';
        } else if (!isAuto) {
          el.simCountdownVal.textContent = 'STANDBY';
        } else {
          el.simCountdownVal.textContent = isFilePreview ? `${state.countdown}s` : 'ACTIVE';
        }
      }
    }

    // ─── HTTP API CLIENT (LIVE HARDWARE MODE) ──────────────────────────────

    async function sendApiCommand(endpoint, bodyObj, label) {
      if (!isFilePreview && !state.connected) {
        logEvent(`Blocked (${label}): ESP32 is offline.`, 'warn');
        return false;
      }
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(bodyObj).toString(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        logEvent(`Hardware OK: ${label}`, 'success');
        pollDeviceStatus();
        return true;
      } catch (err) {
        logEvent(`Hardware Error (${label}): ${err.message}`, 'error');
        return false;
      }
    }

    let pollInFlight = false;
    async function pollDeviceStatus() {
      if (isFilePreview || pollInFlight) return;
      pollInFlight = true;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch('/api/status', {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const wasOffline = !state.connected;
        state.connected = true;

        // Top Notice Banner
        if (el.simNoticeBar) {
          el.simNoticeBar.className = 'sim-notice-bar notice-online';
          if (el.simNoticeTag) {
            el.simNoticeTag.textContent = `✓ Connected: ${data.chip_model || 'ESP32-C6'} (${data.mdns || 'mcu-eye-monster'})`;
          }
          if (el.simNoticeSub) {
            el.simNoticeSub.innerHTML = `Live Firmware | STA: <code>${data.sta_ip}</code> | AP: <code>${data.ap_ip}</code> | Free Heap: ${(data.free_heap / 1024).toFixed(1)} KB`;
          }
        }

        // Synchronize State
        state.mode = data.mode || 'manual';
        state.isPaused = Boolean(data.paused);
        state.uptimeSeconds = Number(data.uptime) || 0;

        // Servos
        if (Array.isArray(data.servos)) {
          data.servos.forEach(devServo => {
            const localServo = state.servos.find(s => s.id === devServo.id);
            if (localServo) {
              localServo.angle = devServo.angle;
              localServo.targetAngle = devServo.angle;
              localServo.status = devServo.status;
              localServo.active = devServo.active;
            }
          });
        }

        // Relays
        if (Array.isArray(data.relays)) {
          data.relays.forEach(devRelay => {
            if (state.relays[devRelay.id]) {
              state.relays[devRelay.id].state = (devRelay.state === 1);
            }
          });
        }

        // Sequence Config
        if (data.sequence && !state.configFormEditing) {
          state.config.openAngle = data.sequence.open_deg;
          state.config.closeAngle = data.sequence.close_deg;
          state.config.holdMs = data.sequence.hold_ms;
          state.config.intervalSec = data.sequence.interval_s;

          const inOpen = document.getElementById('config-open');
          const inClose = document.getElementById('config-close');
          const inHold = document.getElementById('config-hold');
          const inInterval = document.getElementById('config-interval');
          if (inOpen && document.activeElement !== inOpen) inOpen.value = state.config.openAngle;
          if (inClose && document.activeElement !== inClose) inClose.value = state.config.closeAngle;
          if (inHold && document.activeElement !== inHold) inHold.value = state.config.holdMs;
          if (inInterval && document.activeElement !== inInterval) inInterval.value = state.config.intervalSec;
        }

        // Chips & Sidebar
        if (el.chipTarget) el.chipTarget.textContent = data.mdns || 'mcu-eye-monster';
        if (el.chipApIp) el.chipApIp.textContent = data.ap_ip || '192.168.10.1';
        if (el.chipArch) el.chipArch.textContent = `${data.chip_model || 'ESP32-C6'} RTOS`;

        if (el.nodeTitle) el.nodeTitle.textContent = 'Hardware Node';
        if (el.nodeVal) el.nodeVal.textContent = `${data.chip_model || 'ESP32-C6'} RTOS`;
        if (el.nodeSub) el.nodeSub.textContent = `Core 0 Tasks: loopServo1 & loopServo2`;

        if (el.uptimeVal) {
          const m = Math.floor(state.uptimeSeconds / 60);
          const sec = state.uptimeSeconds % 60;
          el.uptimeVal.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }

        // Maintenance Card
        if (el.maintMdns) el.maintMdns.textContent = `http://${data.mdns || 'mcu-eye-monster'}.local`;
        if (el.maintApSsid) el.maintApSsid.textContent = `${data.mdns || 'mcu-eye-monster'} (Ch 6)`;
        if (el.maintApNet) el.maintApNet.textContent = `${data.ap_ip || '192.168.10.1'} / 255.255.255.0`;
        if (el.maintStaIp) el.maintStaIp.textContent = `${data.sta_ip} (${data.wifi_connected ? 'Connected' : 'Disconnected'})`;
        if (el.maintHeap) el.maintHeap.textContent = `${Number(data.free_heap).toLocaleString()} bytes`;
        if (el.maintOtaAuth) el.maintOtaAuth.textContent = data.ota_auth || 'Preexisting limitation: unauthenticated endpoint';

        renderServo(1);
        renderServo(2);
        renderRelays();
        renderSummaryTable();
        updateAccessControls();

        if (wasOffline) {
          logEvent(`Live telemetry established with ${data.chip_model || 'ESP32-C6'} at ${data.sta_ip}`, 'success');
        }
      } catch (err) {
        if (state.connected) {
          state.connected = false;
          logEvent(`Connection lost to ESP32: ${err.message}`, 'error');
        }
        if (el.simNoticeBar) {
          el.simNoticeBar.className = 'sim-notice-bar notice-offline';
          if (el.simNoticeTag) el.simNoticeTag.textContent = '⚠ CONNECTION LOST — ESP32 Unreachable';
          if (el.simNoticeSub) el.simNoticeSub.textContent = 'Hardware controls locked. Retrying...';
        }
        if (el.simStatusBadge) {
          el.simStatusBadge.textContent = 'OFFLINE';
          el.simStatusBadge.className = 'status-badge badge-offline';
        }
        if (el.overviewMode) {
          el.overviewMode.textContent = 'OFFLINE';
          el.overviewMode.className = 'stat-val text-muted';
        }
        lockAllControls();
      } finally {
        pollInFlight = false;
      }
    }

    function handleSliderInput(servoId, val) {
      const angle = Number(val);
      if (isFilePreview) {
        setServoAngleSim(servoId, angle);
        return;
      }
      // Live HTTP mode: purely local display during drag, no network stream
      updateGauge(servoId, angle);
      const valEl = (servoId === 1) ? el.servo1Val : el.servo2Val;
      const usEl = (servoId === 1) ? el.servo1Us : el.servo2Us;
      if (valEl) valEl.textContent = `${angle}°`;
      if (usEl) usEl.textContent = `${degToMicroseconds(angle)} µs`;
    }

    function handleSliderChange(servoId, val) {
      if (isFilePreview) return;
      const angle = Number(val);
      sendApiCommand('/api/servo', { id: servoId, angle }, `Servo ${servoId} -> ${angle}°`);
    }

    // ─── STANDALONE SIMULATION LOGIC (file:// ONLY) ──────────────────────────

    function setServoAngleSim(servoId, angle) {
      if (state.isPaused || state.mode === 'auto') return;
      const s = state.servos.find(item => item.id === servoId);
      if (!s || s.status === 'RUNNING') return;

      const clamped = Math.min(Math.max(Number(angle) || 0, 0), 180);
      s.angle = clamped;
      s.targetAngle = clamped;
      s.status = 'MANUAL SET';
      logEvent(`${s.name} commanded to ${clamped}° (${degToMicroseconds(clamped)} µs)`, 'info');
      renderServo(servoId);

      setTimeout(() => {
        if (s.status === 'MANUAL SET') {
          s.status = 'IDLE';
          renderServo(servoId);
        }
      }, 700);
    }

    function runServoSequenceSim(servoId, onComplete) {
      const s = state.servos.find(item => item.id === servoId);
      if (!s || state.isPaused) return;

      if (s.runningTimeout) {
        clearTimeout(s.runningTimeout);
        s.runningTimeout = null;
      }

      const plan = generateSequencePlan(state.config);
      const progressEl = servoId === 1 ? el.servo1Progress : el.servo2Progress;
      s.status = 'RUNNING';
      renderServo(servoId);
      updateAccessControls();

      logEvent(`Starting 7-step seqMove on ${s.name} (Pin ${s.pin})...`, 'sequence');

      let currentStepIndex = 0;

      function executeNextStep() {
        if (state.isPaused) {
          logEvent(`Sequence on ${s.name} aborted: Simulation paused.`, 'warn');
          s.status = 'IDLE';
          s.runningTimeout = null;
          if (progressEl) progressEl.textContent = 'Aborted (Paused)';
          renderServo(servoId);
          updateAccessControls();
          if (onComplete) onComplete(false);
          return;
        }

        if (currentStepIndex >= plan.length) {
          s.angle = state.config.openAngle;
          s.targetAngle = state.config.openAngle;
          s.status = 'IDLE';
          s.runningTimeout = null;
          if (progressEl) progressEl.textContent = `Completed at ${s.angle}°`;
          logEvent(`seqMove completed on ${s.name}: Parked at ${s.angle}°.`, 'success');
          renderServo(servoId);
          updateAccessControls();
          if (onComplete) onComplete(true);
          return;
        }

        const step = plan[currentStepIndex];
        s.angle = step.angle;
        s.targetAngle = step.angle;
        if (progressEl) progressEl.textContent = step.label;
        renderServo(servoId);

        currentStepIndex++;
        s.runningTimeout = setTimeout(executeNextStep, state.config.holdMs + 100);
      }

      executeNextStep();
    }

    function cancelAllSequencesSim() {
      state.servos.forEach(s => {
        if (s.runningTimeout) {
          clearTimeout(s.runningTimeout);
          s.runningTimeout = null;
        }
        if (s.status === 'RUNNING') {
          s.status = 'IDLE';
          renderServo(s.id);
        }
      });
      if (el.servo1Progress) el.servo1Progress.textContent = 'Standby';
      if (el.servo2Progress) el.servo2Progress.textContent = 'Standby';
    }

    function triggerAutoCycleSim() {
      if (state.isPaused || state.mode !== 'auto') return;
      logEvent('Automatic interval reached: executing parallel seqMove tasks on Servo 1 & 2', 'sequence');
      runServoSequenceSim(1);
      setTimeout(() => {
        if (!state.isPaused && state.mode === 'auto') {
          runServoSequenceSim(2);
        }
      }, 150);
    }

    function startAutoTimerSim() {
      if (state.autoTicker) clearInterval(state.autoTicker);
      state.autoTicker = setInterval(() => {
        state.uptimeSeconds++;
        if (el.uptimeVal) {
          const m = Math.floor(state.uptimeSeconds / 60);
          const sec = state.uptimeSeconds % 60;
          el.uptimeVal.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }

        if (state.isPaused) return;

        if (state.mode === 'auto') {
          state.countdown--;
          if (state.countdown <= 0) {
            state.countdown = state.config.intervalSec;
            triggerAutoCycleSim();
          }
          if (el.simCountdownVal) {
            el.simCountdownVal.textContent = `${state.countdown}s`;
          }
        }
      }, 1000);
    }

    // ─── COMMON EVENT HANDLERS ──────────────────────────────────────────────

    function setMode(newMode) {
      if (state.mode === newMode) return;
      if (isFilePreview) {
        state.mode = newMode;
        logEvent(`Operating mode switched to ${newMode.toUpperCase()}`, 'info');
        if (newMode === 'auto') {
          state.countdown = state.config.intervalSec;
        }
        updateAccessControls();
      } else {
        sendApiCommand('/api/mode', { mode: newMode }, `Set mode to ${newMode.toUpperCase()}`);
      }
    }

    function togglePause() {
      if (isFilePreview) {
        state.isPaused = !state.isPaused;
        if (state.isPaused) {
          logEvent('Simulation paused: all motor outputs and auto cycles halted.', 'warn');
          cancelAllSequencesSim();
        } else {
          logEvent('Simulation resumed.', 'info');
        }
        updateAccessControls();
      } else {
        const nextState = !state.isPaused;
        sendApiCommand('/api/pause', { paused: nextState ? 1 : 0 }, nextState ? 'Pause Software' : 'Resume Software');
      }
    }

    function toggleRelay(relayId) {
      if (state.isPaused) return;
      const r = state.relays[relayId];
      if (!r) return;

      if (isFilePreview) {
        r.state = !r.state;
        logEvent(`${r.name} (Pin ${r.pin}) toggled ${r.state ? 'HIGH (CLOSED)' : 'LOW (OPEN)'}`, 'info');
        renderRelays();
      } else {
        const nextState = !r.state;
        sendApiCommand('/api/relay', { id: relayId, state: nextState ? 1 : 0 }, `${r.name} -> ${nextState ? 'ON' : 'OFF'}`).then(ok => {
          if (!ok) {
            renderRelays(); // Revert toggle display on network failure
          }
        });
      }
    }

    function handleConfigSubmit(e) {
      e.preventDefault();
      const openAngle = Number(document.getElementById('config-open').value);
      const closeAngle = Number(document.getElementById('config-close').value);
      const holdMs = Number(document.getElementById('config-hold').value);
      const intervalSec = Number(document.getElementById('config-interval').value);

      const validation = validateSequenceConfig({ openAngle, closeAngle, holdMs, intervalSec });
      if (!validation.valid) {
        if (el.formFeedback) {
          el.formFeedback.textContent = validation.errors.join(' | ');
          el.formFeedback.className = 'form-feedback feedback-error';
        }
        logEvent(`Config update failed: ${validation.errors.join(', ')}`, 'error');
        return;
      }

      state.config = validation.normalized;
      state.countdown = state.config.intervalSec;

      if (isFilePreview) {
        if (el.formFeedback) {
          el.formFeedback.textContent = `Applied: Open ${state.config.openAngle}°, Close ${state.config.closeAngle}°, Hold ${state.config.holdMs}ms, Repeat ${state.config.intervalSec}s`;
          el.formFeedback.className = 'form-feedback feedback-success';
        }
        logEvent(`Sequence configuration updated: Open=${state.config.openAngle}°, Close=${state.config.closeAngle}°, Hold=${state.config.holdMs}ms, Interval=${state.config.intervalSec}s`, 'success');
        updateAccessControls();
      } else {
        sendApiCommand('/api/sequence', {
          open_deg: state.config.openAngle,
          close_deg: state.config.closeAngle,
          hold_ms: state.config.holdMs,
          interval_s: state.config.intervalSec,
        }, 'Update Sequence Configuration').then(ok => {
          if (!el.formFeedback) return;
          if (ok) {
            el.formFeedback.textContent = `Saved to ESP32: Open ${state.config.openAngle}°, Close ${state.config.closeAngle}°, Hold ${state.config.holdMs}ms, Repeat ${state.config.intervalSec}s`;
            el.formFeedback.className = 'form-feedback feedback-success';
          } else {
            el.formFeedback.textContent = 'Failed to save sequence configuration to ESP32.';
            el.formFeedback.className = 'form-feedback feedback-error';
          }
        });
      }
    }

    function handleConfigReset() {
      document.getElementById('config-open').value = DEFAULT_SEQUENCE.openAngle;
      document.getElementById('config-close').value = DEFAULT_SEQUENCE.closeAngle;
      document.getElementById('config-hold').value = DEFAULT_SEQUENCE.holdMs;
      document.getElementById('config-interval').value = DEFAULT_SEQUENCE.intervalSec;

      if (isFilePreview) {
        state.config = { ...DEFAULT_SEQUENCE };
        state.countdown = state.config.intervalSec;
        if (el.formFeedback) {
          el.formFeedback.textContent = 'Settings reset to factory defaults (30° / 85° / 200ms / 60s).';
          el.formFeedback.className = 'form-feedback feedback-info';
        }
        logEvent('Sequence settings reset to factory defaults.', 'info');
        updateAccessControls();
      } else {
        sendApiCommand('/api/sequence/reset', {}, 'Reset Sequence to Defaults').then(ok => {
          if (!el.formFeedback) return;
          if (ok) {
            el.formFeedback.textContent = 'Reset to ESP32 defaults (30° / 85° / 200ms / 60s).';
            el.formFeedback.className = 'form-feedback feedback-info';
          } else {
            el.formFeedback.textContent = 'Failed to reset sequence configuration on ESP32.';
            el.formFeedback.className = 'form-feedback feedback-error';
          }
        });
      }
    }

    // Setup Event Listeners
    function attachListeners() {
      if (el.modeManualBtn) el.modeManualBtn.addEventListener('click', () => setMode('manual'));
      if (el.modeAutoBtn) el.modeAutoBtn.addEventListener('click', () => setMode('auto'));
      if (el.pauseSimBtn) el.pauseSimBtn.addEventListener('click', togglePause);

      // Servo 1 Sliders and Presets
      if (el.servo1Slider) {
        el.servo1Slider.addEventListener('input', (e) => handleSliderInput(1, e.target.value));
        el.servo1Slider.addEventListener('change', (e) => handleSliderChange(1, e.target.value));
      }
      if (el.servo1RunBtn) {
        el.servo1RunBtn.addEventListener('click', () => {
          if (isFilePreview) runServoSequenceSim(1);
          else sendApiCommand('/api/run', { id: 1 }, 'Run Sequence on Servo 1');
        });
      }

      // Servo 2 Sliders and Presets
      if (el.servo2Slider) {
        el.servo2Slider.addEventListener('input', (e) => handleSliderInput(2, e.target.value));
        el.servo2Slider.addEventListener('change', (e) => handleSliderChange(2, e.target.value));
      }
      if (el.servo2RunBtn) {
        el.servo2RunBtn.addEventListener('click', () => {
          if (isFilePreview) runServoSequenceSim(2);
          else sendApiCommand('/api/run', { id: 2 }, 'Run Sequence on Servo 2');
        });
      }

      // Quick presets
      document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const servoId = Number(btn.getAttribute('data-servo'));
          const deg = Number(btn.getAttribute('data-angle'));
          if (isFilePreview) {
            setServoAngleSim(servoId, deg);
          } else {
            sendApiCommand('/api/servo', { id: servoId, angle: deg }, `Servo ${servoId} Preset ${deg}°`);
          }
        });
      });

      // Relay Toggles
      if (el.relay1Toggle) el.relay1Toggle.addEventListener('change', () => toggleRelay(1));
      if (el.relay2Toggle) el.relay2Toggle.addEventListener('change', () => toggleRelay(2));

      // Config Form
      if (el.configForm) {
        el.configForm.addEventListener('submit', handleConfigSubmit);
        el.configForm.querySelectorAll('input').forEach(inp => {
          inp.addEventListener('focus', () => { state.configFormEditing = true; });
          inp.addEventListener('blur', () => { state.configFormEditing = false; });
        });
      }
      if (el.resetConfigBtn) el.resetConfigBtn.addEventListener('click', handleConfigReset);

      // Clear Activity Log
      if (el.clearActivityBtn) {
        el.clearActivityBtn.addEventListener('click', () => {
          state.activityLog = [];
          renderActivityLog();
        });
      }
    }

    // Initial Boot
    function init() {
      attachListeners();
      renderServo(1);
      renderServo(2);
      renderRelays();
      renderSummaryTable();
      updateAccessControls();

      if (isFilePreview) {
        startAutoTimerSim();
        logEvent('NOYA RTOS Control Studio Preview initialized (file:// standalone mode).', 'info');
        logEvent('Hardware simulation active: Servos [5, 1, 12, 2, 3], Relays [4, 15].', 'info');
      } else {
        logEvent('NOYA RTOS Control Studio: Connecting to live ESP32 firmware API...', 'info');
        pollDeviceStatus();
        state.pollInterval = setInterval(pollDeviceStatus, 1000);
      }
    }

    init();
  })();
}
