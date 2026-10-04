#include <Arduino.h>
#include <errno.h>
#include <ESP32Servo.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <ElegantOTA.h>
#include <Preferences.h>
#include "dashboard_assets.h"

// ─── CONFIG ──────────────────────────────────────────────────────────────────
#include "secrets.h"

// ─── OPERATION MODE ──────────────────────────────────────────────────────────
// Set true for standalone eye installation (autonomous 60s blink / 60s rest).
// Set false for ESP-NOW slave plant installation (or standalone sensor plant).
#ifndef STANDALONE_EYES_MODE
#define STANDALONE_EYES_MODE false
#endif

// ─── SLAVE IDENTITY (1 to 4) ─────────────────────────────────────────────────
// Change SLAVE_INDEX when flashing each slave (1 = Plant 1, 2 = Plant 2, etc.)
#ifndef SLAVE_INDEX
#define SLAVE_INDEX 4
#endif

#if STANDALONE_EYES_MODE
const char* MDNS_HOST = "mcu-eye-monster";
#elif SLAVE_INDEX == 1
const char* MDNS_HOST = "mcu-plant-1";
#elif SLAVE_INDEX == 2
const char* MDNS_HOST = "mcu-plant-2";
#elif SLAVE_INDEX == 3
const char* MDNS_HOST = "mcu-plant-3";
#elif SLAVE_INDEX == 4
const char* MDNS_HOST = "mcu-plant-4";
#else
const char* MDNS_HOST = "mcu-plant-custom";
#endif

const uint8_t SLAVE_MAC[6] = { 0x02, 0x02, 0x00, 0x00, 0x00, (uint8_t)(SLAVE_INDEX + 1) };

typedef struct __attribute__((packed)) {
  uint32_t cmd_id;       // Unique command ID for deduplication
  uint8_t  servo_idx;    // 0 = Mouth 1 (GPIO 5), 1 = Mouth 2 (GPIO 1)
  uint8_t  open_angle;   // Open angle & resting position (0..180 deg)
  uint8_t  close_angle;  // Closed position (0..180 deg)
  uint32_t duration_ms;  // Active animation duration in milliseconds
} AnimatronicCommand;

// ─── SENSOR INTERACTION PARAMETERS (PLANT MODE) ──────────────────────────────
#ifndef IS_SENSOR
const bool     IS_SENSOR                 = false;   // Enable the sensor background task
#endif
const int      SENSOR_PIN                = 6;      // Sensor ADC input pin (GPIO 6)
const int      SENSOR_THRESHOLD          = 200;    // Trigger threshold (ADC 0..4095)

// Adjustable Timers (milliseconds)
const uint32_t SENSOR_MAX_ACTIVE_MS      = 60000;  // Max continuous active motion while person present (60s)
const uint32_t SENSOR_REST_COOLDOWN_MS   = 60000;  // Strict rest cooldown (60s)
const uint32_t SENSOR_LEAVE_TIMEOUT_MS   = 1500;   // Absence threshold to detect person left (1.5s)

const char* AP_SSID = MDNS_HOST;
const bool AP_HIDDEN = false;
const int AP_CHANNEL = 6;
const int AP_MAX_CONN = 4;

// Custom AP network settings
IPAddress AP_LOCAL_IP(192, 168, 10, 1);
IPAddress AP_GATEWAY(192, 168, 10, 1);
IPAddress AP_SUBNET(255, 255, 255, 0);

// ─── OBJECTS ─────────────────────────────────────────────────────────────────
WebServer server(80);

const int NUM_SERVOS = 5;
const int SERVO_PINS[NUM_SERVOS] = { 5, 1, 12, 2, 3 };
Servo servos[NUM_SERVOS];

const int RELAY_1 = 4;
const int RELAY_2 = 15;

const int MAX_SERVO = 180;
const int MIN_SERVO = 0;
const int MAX_SERVO_US = 2500;
const int MIN_SERVO_US = 500;

const int START_DEG = 50;

// Holding torque timeout for manual commands
const uint32_t MANUAL_SERVO_HOLD_MS = 60000;

// ─── RTOS TASK QUEUES & SYNCHRONIZATION ───────────────────────────────────────
enum ServoCmdType {
  CMD_SET_ANGLE
};

enum class MotionProfile {
  Exponential,
  SCurve
};

struct ServoCommand {
  ServoCmdType type;
  int angle;
  uint32_t epoch;
};

// Forward declaration with defaults for moveServo
void moveServo(int setpoint_deg, Servo& servo, int servoIndex, uint32_t token,
               MotionProfile profile = MotionProfile::Exponential,
               uint32_t durationMs = 1000);

static QueueHandle_t servoQueue1 = NULL;
static QueueHandle_t servoQueue2 = NULL;
static SemaphoreHandle_t stateMutex = NULL;

// Synchronized state shared between HTTP server and worker tasks
static bool isAutoMode = false;
static bool isPaused = false;

// ─── SEQUENCE CONFIGURATION & FLASH PERSISTENCE ──────────────────────────────
// ponytail: atomic single Preferences blob for non-volatile sequence config
static const uint32_t SEQ_CONFIG_MAGIC = 0x4E534551; // 'NSEQ'
static const uint16_t SEQ_CONFIG_VERSION = 2;
static const int DEFAULT_SEQ_OPEN_DEG = 30;
static const int DEFAULT_SEQ_CLOSE_DEG = 85;
static const int DEFAULT_SEQ_HOLD_MS = 200;
static const int DEFAULT_SEQ_CYCLES = 5;
#if STANDALONE_EYES_MODE
static const int DEFAULT_SEQ_REST_MS = 60000; // 60s rest for standalone eye monster
static const uint32_t DEFAULT_SEQ_ACTIVE_MS = 60000; // 60s active blinking
#else
static const int DEFAULT_SEQ_REST_MS = 10000;
static const uint32_t DEFAULT_SEQ_ACTIVE_MS = 60000;
#endif

#pragma pack(push, 1)
struct SequenceConfigBlob {
  uint32_t magic;
  uint16_t version;
  int16_t open_deg;
  int16_t close_deg;
  int16_t cycles_per_session;
  int32_t hold_ms;
  int32_t rest_ms;
  int32_t active_ms; // Active session duration (ms), used in eye mode
};
#pragma pack(pop)

static bool isValidSequenceConfig(int open, int close, int hold, int cycles, int rest, int active = 60000) {
  if (open < MIN_SERVO || open > MAX_SERVO || close < MIN_SERVO || close > MAX_SERVO) return false;
  if (open == close) return false;
  if (hold < 50 || hold > 5000) return false;
  if (cycles < 1 || cycles > 100) return false;
  if (rest < 0 || rest > 3600000) return false;
  if (active < 1000 || active > 3600000) return false;
  return true;
}

static int seq_open_deg = DEFAULT_SEQ_OPEN_DEG;
static int seq_close_deg = DEFAULT_SEQ_CLOSE_DEG;
static int seq_hold_ms = DEFAULT_SEQ_HOLD_MS;
static int seq_cycles_per_session = DEFAULT_SEQ_CYCLES;
static int seq_rest_ms = DEFAULT_SEQ_REST_MS;
static int seq_active_duration_ms = DEFAULT_SEQ_ACTIVE_MS;
// ponytail: default motion profile for moveServo; change to MotionProfile::SCurve for smooth ease-in/ease-out
static MotionProfile seq_motion_profile = MotionProfile::Exponential;
static uint32_t seq_move_duration_ms = 3000;

void loadSavedSequenceConfig() {
  Preferences prefs;
  bool valid = false;
  if (prefs.begin("noyaseq", true)) {
    SequenceConfigBlob blob;
    memset(&blob, 0, sizeof(blob));
    size_t readBytes = prefs.getBytes("seqcfg", &blob, sizeof(blob));
    prefs.end();
    if (readBytes >= 20 && blob.magic == SEQ_CONFIG_MAGIC) {
      int active = (blob.version >= 2 && readBytes >= sizeof(SequenceConfigBlob)) ? blob.active_ms : (int)DEFAULT_SEQ_ACTIVE_MS;
      if (isValidSequenceConfig(blob.open_deg, blob.close_deg, blob.hold_ms, blob.cycles_per_session, blob.rest_ms, active)) {
        seq_open_deg = blob.open_deg;
        seq_close_deg = blob.close_deg;
        seq_hold_ms = blob.hold_ms;
        seq_cycles_per_session = blob.cycles_per_session;
        seq_rest_ms = blob.rest_ms;
        seq_active_duration_ms = active;
        valid = true;
        Serial.printf("[Config] Loaded saved sequence: open=%d close=%d hold=%d cycles=%d rest=%d active=%d\n",
                      seq_open_deg, seq_close_deg, seq_hold_ms, seq_cycles_per_session, seq_rest_ms, seq_active_duration_ms);
      }
    }
  }

  if (!valid) {
    seq_open_deg = DEFAULT_SEQ_OPEN_DEG;
    seq_close_deg = DEFAULT_SEQ_CLOSE_DEG;
    seq_hold_ms = DEFAULT_SEQ_HOLD_MS;
    seq_cycles_per_session = DEFAULT_SEQ_CYCLES;
    seq_rest_ms = DEFAULT_SEQ_REST_MS;
    seq_active_duration_ms = DEFAULT_SEQ_ACTIVE_MS;
    Serial.println("[Config] Using default sequence configuration");
  }
}

static int commanded_angles[NUM_SERVOS] = { START_DEG, START_DEG, START_DEG, START_DEG, START_DEG };
static char servo_status_str[NUM_SERVOS][16] = { "IDLE", "IDLE", "PARKED", "PARKED", "PARKED" };
static char servo_phase_str[NUM_SERVOS][16] = { "idle", "idle", "idle", "idle", "idle" };
static bool servo_running[NUM_SERVOS] = { false, false, false, false, false };
static bool explicit_stopped[NUM_SERVOS] = { false, false, false, false, false };
static int servo_cycle[NUM_SERVOS] = { 0, 0, 0, 0, 0 };
static uint32_t servo_rest_until[NUM_SERVOS] = { 0, 0, 0, 0, 0 };
static uint32_t servoEpoch[NUM_SERVOS] = { 1, 1, 1, 1, 1 };
static bool servo_attached[NUM_SERVOS] = { true, true, true, true, true };
static int last_actual_pulse_us[NUM_SERVOS] = { 0, 0, 0, 0, 0 };
static bool relay_states[2] = { false, false };

// Animatronic remote animation state (Mouth 1 = index 0, Mouth 2 = index 1)
static bool     anim_active[2]      = { false, false };
static uint32_t anim_cmd_id[2]      = { 0, 0 };
static int      anim_open_deg[2]    = { 30, 30 };
static int      anim_close_deg[2]   = { 85, 85 };
static uint32_t anim_deadline_ms[2] = { 0, 0 };

#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
#else
void onDataRecv(const uint8_t *mac_addr, const uint8_t *incomingData, int len) {
#endif
  if (len != sizeof(AnimatronicCommand)) {
    Serial.printf("[ESP-NOW] Invalid size: %d bytes (expected %d)\n", len, (int)sizeof(AnimatronicCommand));
    return;
  }

  AnimatronicCommand cmd;
  memcpy(&cmd, incomingData, sizeof(cmd));

  if (cmd.servo_idx >= 2) {
    Serial.printf("[ESP-NOW] Invalid servo index: %d\n", cmd.servo_idx);
    return;
  }

  int idx = cmd.servo_idx;
  int open_deg  = constrain((int)cmd.open_angle, MIN_SERVO, MAX_SERVO);
  int close_deg = constrain((int)cmd.close_angle, MIN_SERVO, MAX_SERVO);

  if (stateMutex) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);

    // Duplicate check: if master re-sent identical command ID, ignore
    if (cmd.cmd_id != 0 && cmd.cmd_id == anim_cmd_id[idx]) {
      xSemaphoreGive(stateMutex);
      return;
    }

    anim_cmd_id[idx]      = cmd.cmd_id;
    anim_open_deg[idx]    = open_deg;
    anim_close_deg[idx]   = close_deg;
    anim_deadline_ms[idx] = millis() + cmd.duration_ms;
    anim_active[idx]      = true;

    // Preempt active motion / pause; worker task will interpolate from last_actual_pulse_us
    servoEpoch[idx]++;
    servo_running[idx]    = true;
    explicit_stopped[idx] = false;
    servo_cycle[idx]      = 1;
    servo_rest_until[idx] = 0;

    strncpy(servo_status_str[idx], "ANIMATING", sizeof(servo_status_str[idx]) - 1);
    servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
    strncpy(servo_phase_str[idx], "active", sizeof(servo_phase_str[idx]) - 1);
    servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';

    QueueHandle_t q = (idx == 0) ? servoQueue1 : servoQueue2;
    if (q) xQueueReset(q);

    xSemaphoreGive(stateMutex);

    Serial.printf("[ESP-NOW] Accepted Cmd #%u: Mouth %d, Open:%d Close:%d Dur:%ums\n",
                  cmd.cmd_id, idx + 1, open_deg, close_deg, cmd.duration_ms);
  }
}

// Thread-safe per-servo power control (Relay 1 for Servo 1, Relay 2 for Servo 2)
void setServoPower(int idx, bool on) {
  if (idx < 0 || idx >= 2) return;
  int pin = (idx == 0) ? RELAY_1 : RELAY_2;

  bool wasOn = false;
  if (stateMutex) xSemaphoreTake(stateMutex, portMAX_DELAY);
  wasOn = relay_states[idx];
  relay_states[idx] = on;
  if (stateMutex) xSemaphoreGive(stateMutex);

  if (on != wasOn) {
    if (on) {
      // Ensure the hardware PWM timer is actively outputting the last pulse before connecting 5V
      int pulse = last_actual_pulse_us[idx];
      if (pulse >= MIN_SERVO_US && pulse <= MAX_SERVO_US) {
        servos[idx].writeMicroseconds(pulse);
      }
      digitalWrite(pin, HIGH);
      vTaskDelay(pdMS_TO_TICKS(100)); // 100ms power rail stabilization delay
    } else {
      digitalWrite(pin, LOW);
    }
  }
}

// Thread-safe state helpers
uint32_t bumpServoEpoch(int servoIndex) {
  if (!stateMutex || servoIndex < 0 || servoIndex >= NUM_SERVOS) return 0;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  uint32_t token = ++servoEpoch[servoIndex];
  xSemaphoreGive(stateMutex);
  return token;
}

bool isEpochValid(int servoIndex, uint32_t token) {
  if (!stateMutex || servoIndex < 0 || servoIndex >= NUM_SERVOS) return false;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  bool valid = (!isPaused && servoEpoch[servoIndex] == token && servo_attached[servoIndex]);
  xSemaphoreGive(stateMutex);
  return valid;
}

bool getIsAuto() {
  if (!stateMutex) return false;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  bool val = isAutoMode;
  xSemaphoreGive(stateMutex);
  return val;
}

bool getIsPaused() {
  if (!stateMutex) return false;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  bool val = isPaused;
  xSemaphoreGive(stateMutex);
  return val;
}

void startServoSeq(int index) {
  if (index < 0 || index >= 2) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (!isPaused && servo_attached[index]) {
    explicit_stopped[index] = false;
    if (!servo_running[index]) {
      servo_running[index] = true;
      servoEpoch[index]++;
      servo_cycle[index] = 1;
      servo_rest_until[index] = 0;
      strncpy(servo_phase_str[index], "open", sizeof(servo_phase_str[index]) - 1);
      servo_phase_str[index][sizeof(servo_phase_str[index]) - 1] = '\0';
      strncpy(servo_status_str[index], "OPEN", sizeof(servo_status_str[index]) - 1);
      servo_status_str[index][sizeof(servo_status_str[index]) - 1] = '\0';
      commanded_angles[index] = seq_open_deg;
      QueueHandle_t q = (index == 0) ? servoQueue1 : servoQueue2;
      if (q) xQueueReset(q);
    }
  }
  xSemaphoreGive(stateMutex);
}

void stopServoSeq(int index, bool explicitStop) {
  if (index < 0 || index >= 2) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (explicitStop) {
    explicit_stopped[index] = true;
  }
  if (servo_running[index] || explicitStop) {
    servoEpoch[index]++;
  }
  servo_running[index] = false;
  anim_active[index] = false;
  servo_cycle[index] = 0;
  servo_rest_until[index] = 0;
  strncpy(servo_phase_str[index], "idle", sizeof(servo_phase_str[index]) - 1);
  servo_phase_str[index][sizeof(servo_phase_str[index]) - 1] = '\0';
  // ponytail: preserve DETACHED status on stop
  if (!servo_attached[index]) {
    strncpy(servo_status_str[index], "DETACHED", sizeof(servo_status_str[index]) - 1);
  } else {
    strncpy(servo_status_str[index], "IDLE", sizeof(servo_status_str[index]) - 1);
  }
  servo_status_str[index][sizeof(servo_status_str[index]) - 1] = '\0';
  QueueHandle_t q = (index == 0) ? servoQueue1 : servoQueue2;
  if (q) xQueueReset(q);
  xSemaphoreGive(stateMutex);
  setServoPower(index, false);
}

void restartServoSeq(int index) {
  if (index < 0 || index >= 2) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (!isPaused && servo_running[index] && servo_attached[index]) {
    servoEpoch[index]++;
    servo_cycle[index] = 1;
    servo_rest_until[index] = 0;
    strncpy(servo_phase_str[index], "open", sizeof(servo_phase_str[index]) - 1);
    servo_phase_str[index][sizeof(servo_phase_str[index]) - 1] = '\0';
    strncpy(servo_status_str[index], "OPEN", sizeof(servo_status_str[index]) - 1);
    servo_status_str[index][sizeof(servo_status_str[index]) - 1] = '\0';
    commanded_angles[index] = seq_open_deg;
  }
  xSemaphoreGive(stateMutex);
}

// Sensor animation helpers (animates Mouth 2 using configured sequence angles)
bool startSensorAnim(int idx, uint32_t duration_ms) {
  if (idx < 0 || idx >= 2) return false;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (isPaused || explicit_stopped[idx] || !servo_attached[idx]) {
    xSemaphoreGive(stateMutex);
    return false;
  }
  anim_open_deg[idx]    = seq_open_deg;
  anim_close_deg[idx]   = seq_close_deg;
  anim_deadline_ms[idx] = millis() + duration_ms;
  anim_active[idx]      = true;
  servo_running[idx]    = true;
  servo_cycle[idx]      = 1;
  servo_rest_until[idx] = 0;
  servoEpoch[idx]++;

  strncpy(servo_status_str[idx], "ANIMATING", sizeof(servo_status_str[idx]) - 1);
  servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
  strncpy(servo_phase_str[idx], "active", sizeof(servo_phase_str[idx]) - 1);
  servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';

  QueueHandle_t q = (idx == 0) ? servoQueue1 : servoQueue2;
  if (q) xQueueReset(q);

  xSemaphoreGive(stateMutex);
  return true;
}

void stopSensorAnim(int idx) {
  if (idx < 0 || idx >= 2) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (anim_active[idx]) {
    anim_deadline_ms[idx] = millis(); // Force deadline expiration now
    servoEpoch[idx]++;                 // Abort current stroke so it returns to openDeg immediately
  }
  xSemaphoreGive(stateMutex);
}

bool isSensorAnimActive(int idx) {
  if (!stateMutex || idx < 0 || idx >= 2) return false;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  bool active = anim_active[idx] && servo_running[idx] && !isPaused;
  xSemaphoreGive(stateMutex);
  return active;
}

// ─── WIFI & MDNS ─────────────────────────────────────────────────────────────
void initWiFi() {
  WiFi.mode(WIFI_AP_STA);

  // Configure fixed custom STA MAC matching master peers list
  esp_wifi_set_mac(WIFI_IF_STA, (uint8_t*)SLAVE_MAC);

  WiFi.softAPConfig(AP_LOCAL_IP, AP_GATEWAY, AP_SUBNET);

  bool apOk = WiFi.softAP(AP_SSID, AP_PASS, AP_CHANNEL, AP_HIDDEN, AP_MAX_CONN);
  Serial.printf("[AP] %s, SSID: %s, IP: %s\n",
                apOk ? "Started" : "Failed to start",
                AP_SSID,
                WiFi.softAPIP().toString().c_str());

  // wifiTask owns station retries; keep the AP running independently.
  WiFi.setAutoReconnect(false);

  if (MDNS.begin(MDNS_HOST)) {
    MDNS.addService("http", "tcp", 80);
    Serial.printf("[mDNS] http://%s.local\n", MDNS_HOST);
  }
}

void wifiTask(void* pvParameters) {
  const uint32_t RETRY_INTERVAL_MS = 15000;
  bool wasConnected = false;

  Serial.println("[WiFi] Connecting to STA in background...");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t lastAttempt = millis();

  for (;;) {
    const bool connected = WiFi.status() == WL_CONNECTED;
    const uint32_t now = millis();

    if (connected && !wasConnected) {
      Serial.printf("[WiFi] Connected, IP: %s\n",
                    WiFi.localIP().toString().c_str());
    } else if (!connected && wasConnected) {
      Serial.println("[WiFi] Connection lost; retrying in 15 seconds. AP remains enabled.");
      lastAttempt = now;
    }

    if (!connected && uint32_t(now - lastAttempt) >= RETRY_INTERVAL_MS) {
      Serial.println("[WiFi] Retrying STA connection...");
      WiFi.disconnect(false, false);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      lastAttempt = millis();
    }

    wasConnected = connected;
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

// ─── SERVO ACTUATION (OWNED BY WORKER TASKS ONLY) ─────────────────────────────
void moveServo(int setpoint_deg, Servo& servo, int servoIndex, uint32_t token,
               MotionProfile profile,
               uint32_t durationMs) {
  setpoint_deg = constrain(setpoint_deg, MIN_SERVO, MAX_SERVO);
  int setpoint_us =
    map(setpoint_deg, MIN_SERVO, MAX_SERVO, MIN_SERVO_US, MAX_SERVO_US);

  float move = 0.0f;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (isPaused || servoEpoch[servoIndex] != token || !servo_attached[servoIndex]) {
    xSemaphoreGive(stateMutex);
    return;
  }
  // ponytail: replace initial hardware read with tracked pulse, avoid reading detached hw
  move = (float)last_actual_pulse_us[servoIndex];
  if (move < MIN_SERVO_US || move > MAX_SERVO_US) {
    move = MIN_SERVO_US;
  }
  xSemaphoreGive(stateMutex);

  if (profile == MotionProfile::SCurve) {
    float start_us = move;
    uint32_t startTime = millis();
    // ponytail: quintic smoothstep (Ken Perlin) S-curve; durationMs=0 or already-at-target skips
    while (durationMs > 0 && abs(setpoint_us - (int)start_us) > 1) {
      uint32_t elapsed = millis() - startTime;
      if (elapsed >= durationMs) break;
      float t = (float)elapsed / (float)durationMs;
      float blend = t * t * t * (10.0f + t * (-15.0f + 6.0f * t));
      int pulse = (int)(start_us + (setpoint_us - start_us) * blend);

      xSemaphoreTake(stateMutex, portMAX_DELAY);
      if (isPaused || servoEpoch[servoIndex] != token || !servo_attached[servoIndex]) {
        xSemaphoreGive(stateMutex);
        return;
      }
      servo.writeMicroseconds(pulse);
      last_actual_pulse_us[servoIndex] = pulse;
      xSemaphoreGive(stateMutex);

      vTaskDelay(pdMS_TO_TICKS(10));
    }
  } else {
    float prevmove = move;
    const float alpha = 0.01;

    while (abs(setpoint_us - (int)move) > 1) {
      move = (setpoint_us * alpha) + (prevmove * (1.0 - alpha));
      prevmove = move;

      xSemaphoreTake(stateMutex, portMAX_DELAY);
      if (isPaused || servoEpoch[servoIndex] != token || !servo_attached[servoIndex]) {
        xSemaphoreGive(stateMutex);
        return;
      }
      servo.writeMicroseconds((int)move);
      last_actual_pulse_us[servoIndex] = (int)move;
      xSemaphoreGive(stateMutex);

      vTaskDelay(pdMS_TO_TICKS(5));
    }
  }

  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (!isPaused && servoEpoch[servoIndex] == token && servo_attached[servoIndex]) {
    servo.writeMicroseconds(setpoint_us);
    last_actual_pulse_us[servoIndex] = setpoint_us;
  }
  xSemaphoreGive(stateMutex);
}

bool waitEpochDelay(int servoIndex, uint32_t token, int delayMs) {
  int elapsed = 0;
  while (elapsed < delayMs) {
    if (!isEpochValid(servoIndex, token)) return false;
    int chunk = (delayMs - elapsed > 20) ? 20 : (delayMs - elapsed);
    vTaskDelay(pdMS_TO_TICKS(chunk));
    elapsed += chunk;
  }
  return isEpochValid(servoIndex, token);
}

long readSensor() {
  return analogRead(SENSOR_PIN);
}

// ─── WORKER TASKS ─────────────────────────────────────────────────────────────
// Shared task logic for Servo 1 and Servo 2
void servoWorkerTask(void* pvParameters) {
  int idx = (int)(intptr_t)pvParameters;
  if (idx < 0 || idx >= 2) vTaskDelete(NULL);

  QueueHandle_t q = (idx == 0) ? servoQueue1 : servoQueue2;
  Servo& s = servos[idx];

  int currentCycle = 1;
  uint32_t currentToken = 0;
  uint32_t sessionDeadlineMs = 0;

  for (;;) {
    // 1. Process manual angle command atomically under stateMutex
    ServoCommand cmd;
    bool hasCmd = false;
    uint32_t token = 0;

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    if (!isPaused && !servo_running[idx] && servo_attached[idx] && q != NULL) {
      if (xQueueReceive(q, &cmd, 0) == pdTRUE) {
        if (cmd.epoch == servoEpoch[idx]) {
          token = servoEpoch[idx];  // Only cancellation invalidates other admitted commands.
          commanded_angles[idx] = cmd.angle;
          servo_cycle[idx] = 0;
          servo_rest_until[idx] = 0;
          strncpy(servo_status_str[idx], "MANUAL SET", sizeof(servo_status_str[idx]) - 1);
          servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
          strncpy(servo_phase_str[idx], "idle", sizeof(servo_phase_str[idx]) - 1);
          servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
          hasCmd = true;
        }
      }
    } else if (!servo_attached[idx] && q != NULL) {
      while (xQueueReceive(q, &cmd, 0) == pdTRUE);
    }
    xSemaphoreGive(stateMutex);

    if (hasCmd) {
      setServoPower(idx, true);
      moveServo(cmd.angle, s, idx, token, seq_motion_profile, seq_move_duration_ms);
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      if (servoEpoch[idx] == token && !isPaused && !servo_running[idx]) {
        if (servo_attached[idx]) {
          strncpy(servo_status_str[idx], "IDLE", sizeof(servo_status_str[idx]) - 1);
          servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
        } else {
          strncpy(servo_status_str[idx], "DETACHED", sizeof(servo_status_str[idx]) - 1);
          servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
        }
      }
      xSemaphoreGive(stateMutex);

      // Hold position with active power for MANUAL_SERVO_HOLD_MS, then power down if no further commands arrive
      if (q == NULL || uxQueueMessagesWaiting(q) == 0) {
        if (waitEpochDelay(idx, token, MANUAL_SERVO_HOLD_MS)) {
          setServoPower(idx, false);
        }
      }
    }

    // 2. Execution: Remote ESP-NOW animatronic command OR local session
    bool run = false;
    bool isAnim = false;
    int openDeg = 30, closeDeg = 85, holdMs = 200;
    int cyclesPerSession = 5, restMs = 10000;
    int activeDurationMs = 60000;
    MotionProfile profile = MotionProfile::Exponential;
    uint32_t durationMs = 1000;
    uint32_t deadlineMs = 0;

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    if (!isPaused && servo_running[idx] && servo_attached[idx]) {
      run = true;
      token = servoEpoch[idx];
      profile = seq_motion_profile;
      durationMs = seq_move_duration_ms;
      holdMs = seq_hold_ms;

      if (anim_active[idx]) {
        isAnim = true;
        openDeg = anim_open_deg[idx];
        closeDeg = anim_close_deg[idx];
        deadlineMs = anim_deadline_ms[idx];
      } else {
        openDeg = seq_open_deg;
        closeDeg = seq_close_deg;
        cyclesPerSession = seq_cycles_per_session;
        restMs = seq_rest_ms;
        activeDurationMs = seq_active_duration_ms;
        if (currentToken != token) {
          currentToken = token;
          currentCycle = 1;
          servo_cycle[idx] = 1;
          servo_rest_until[idx] = 0;
#if STANDALONE_EYES_MODE
          sessionDeadlineMs = millis() + (uint32_t)activeDurationMs;
#endif
        }
      }
    } else {
      currentToken = 0;
      currentCycle = 1;
    }
    xSemaphoreGive(stateMutex);

    if (run && isAnim) {
      uint32_t now = millis();
      // Check if animation duration has expired
      if ((int32_t)(now - deadlineMs) >= 0) {
        // Expired -> Return to OPEN resting position
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        if (servoEpoch[idx] == token && !isPaused && servo_attached[idx]) {
          commanded_angles[idx] = openDeg;
          strncpy(servo_phase_str[idx], "open", sizeof(servo_phase_str[idx]) - 1);
          servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
          strncpy(servo_status_str[idx], "REST OPEN", sizeof(servo_status_str[idx]) - 1);
          servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
        }
        xSemaphoreGive(stateMutex);

        moveServo(openDeg, s, idx, token, profile, durationMs);

        // Finalize rest state under mutex
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        if (servoEpoch[idx] == token) {
          anim_active[idx] = false;
          servo_running[idx] = false;
          strncpy(servo_phase_str[idx], "idle", sizeof(servo_phase_str[idx]) - 1);
          servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
          strncpy(servo_status_str[idx], "IDLE", sizeof(servo_status_str[idx]) - 1);
          servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
        }
        xSemaphoreGive(stateMutex);

        // Power down after 500ms settling delay into resting open position
        if (waitEpochDelay(idx, token, 500)) {
          setServoPower(idx, false);
        }

        vTaskDelay(pdMS_TO_TICKS(10));
        continue;
      }

      setServoPower(idx, true);

      // Step A: Target Close & hold
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      if (servoEpoch[idx] == token && !isPaused && servo_running[idx] && servo_attached[idx]) {
        commanded_angles[idx] = closeDeg;
        strncpy(servo_phase_str[idx], "close", sizeof(servo_phase_str[idx]) - 1);
        servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
        strncpy(servo_status_str[idx], "CLOSE", sizeof(servo_status_str[idx]) - 1);
        servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
      }
      xSemaphoreGive(stateMutex);

      moveServo(closeDeg, s, idx, token, profile, durationMs);
      if (!waitEpochDelay(idx, token, holdMs)) {
        vTaskDelay(pdMS_TO_TICKS(10));
        continue;
      }

      // Step B: Target Open & hold
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      if (servoEpoch[idx] == token && !isPaused && servo_running[idx] && servo_attached[idx]) {
        commanded_angles[idx] = openDeg;
        strncpy(servo_phase_str[idx], "open", sizeof(servo_phase_str[idx]) - 1);
        servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
        strncpy(servo_status_str[idx], "OPEN", sizeof(servo_status_str[idx]) - 1);
        servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
      }
      xSemaphoreGive(stateMutex);

      moveServo(openDeg, s, idx, token, profile, durationMs);
      if (!waitEpochDelay(idx, token, holdMs)) {
        vTaskDelay(pdMS_TO_TICKS(10));
        continue;
      }
    } else if (run && !isAnim) {
      setServoPower(idx, true);

      // Step A: Target Open & hold
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      if (servoEpoch[idx] == token && !isPaused && servo_running[idx] && servo_attached[idx]) {
        servo_cycle[idx] = currentCycle;
        servo_rest_until[idx] = 0;
        commanded_angles[idx] = openDeg;
        strncpy(servo_phase_str[idx], "open", sizeof(servo_phase_str[idx]) - 1);
        servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
        strncpy(servo_status_str[idx], "OPEN", sizeof(servo_status_str[idx]) - 1);
        servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
      }
      xSemaphoreGive(stateMutex);

      moveServo(openDeg, s, idx, token, profile, durationMs);
      if (!waitEpochDelay(idx, token, holdMs)) {
        vTaskDelay(pdMS_TO_TICKS(10));
        continue;
      }

      // Step B: Target Close & hold
      xSemaphoreTake(stateMutex, portMAX_DELAY);
      if (servoEpoch[idx] == token && !isPaused && servo_running[idx] && servo_attached[idx]) {
        servo_cycle[idx] = currentCycle;
        servo_rest_until[idx] = 0;
        commanded_angles[idx] = closeDeg;
        strncpy(servo_phase_str[idx], "close", sizeof(servo_phase_str[idx]) - 1);
        servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
        strncpy(servo_status_str[idx], "CLOSE", sizeof(servo_status_str[idx]) - 1);
        servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
      }
      xSemaphoreGive(stateMutex);

      moveServo(closeDeg, s, idx, token, profile, durationMs);
      if (!waitEpochDelay(idx, token, holdMs)) {
        vTaskDelay(pdMS_TO_TICKS(10));
        continue;
      }

      // Check session cycle completion
#if STANDALONE_EYES_MODE
      bool sessionFinished = ((int32_t)(millis() - sessionDeadlineMs) >= 0);
#else
      bool sessionFinished = (currentCycle >= cyclesPerSession);
#endif

      if (sessionFinished) {
        // Rest phase (consistently rests in openDeg across all modes)
        if (restMs > 0) {
          int restTargetDeg = openDeg;
          const char* restStatus = "REST OPEN";
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[idx] == token && !isPaused && servo_running[idx] && servo_attached[idx]) {
            servo_cycle[idx] = currentCycle;
            servo_rest_until[idx] = millis() + (uint32_t)restMs;
            commanded_angles[idx] = restTargetDeg;
            strncpy(servo_phase_str[idx], "rest", sizeof(servo_phase_str[idx]) - 1);
            servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
            strncpy(servo_status_str[idx], restStatus, sizeof(servo_status_str[idx]) - 1);
            servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
          }
          xSemaphoreGive(stateMutex);

          moveServo(restTargetDeg, s, idx, token, profile, durationMs);

          // Settle 500ms into rest position then cut relay power for the rest period
          int settleMs = (restMs > 500) ? 500 : restMs;
          if (waitEpochDelay(idx, token, settleMs)) {
            setServoPower(idx, false);
            if (restMs > settleMs) {
              if (!waitEpochDelay(idx, token, restMs - settleMs)) {
                vTaskDelay(pdMS_TO_TICKS(10));
                continue;
              }
            }
          } else {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
          }
        }

        // Rest completed; restart next session from cycle 1
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        if (servoEpoch[idx] == token && !isPaused && servo_running[idx] && servo_attached[idx]) {
          servo_rest_until[idx] = 0;
          currentCycle = 1;
          servo_cycle[idx] = 1;
#if STANDALONE_EYES_MODE
          sessionDeadlineMs = millis() + (uint32_t)activeDurationMs;
#endif
        }
        xSemaphoreGive(stateMutex);
      } else {
        currentCycle++;
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        if (servoEpoch[idx] == token && !isPaused && servo_running[idx] && servo_attached[idx]) {
          servo_cycle[idx] = currentCycle;
        }
        xSemaphoreGive(stateMutex);
      }
    } else {
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
}

// Sensor-based interactive presence task for Mouth 2 (Servo 2, GPIO 1)
void sensorServo(void* pvParameters) {
  enum SensorState { SENSOR_IDLE, SENSOR_ACTIVE, SENSOR_COOLDOWN };
  SensorState state = SENSOR_IDLE;

  int hitCount = 0;
  uint32_t sessionStartMs = 0;
  uint32_t lastDetectedMs = 0;
  uint32_t cooldownStartMs = 0;

  Serial.println("[Sensor] Sensor presence task started for Mouth 2.");

  for (;;) {
    if (getIsPaused()) {
      if (state == SENSOR_ACTIVE) {
        stopSensorAnim(1);
        state = SENSOR_COOLDOWN;
        cooldownStartMs = millis();
      }
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    long val = readSensor();

    switch (state) {
      case SENSOR_IDLE: {
        // Sample at 20 Hz, clamp hitCount [0..8] (~300ms sustained presence required)
        if (val > SENSOR_THRESHOLD) {
          if (hitCount < 8) hitCount++;
        } else {
          if (hitCount > 0) hitCount--;
        }

        if (hitCount >= 6) {
          if (startSensorAnim(1, SENSOR_MAX_ACTIVE_MS)) {
            sessionStartMs = millis();
            lastDetectedMs = millis();
            state = SENSOR_ACTIVE;
            hitCount = 0;
            Serial.printf("[Sensor] Person detected (raw=%ld). Starting Mouth 2 session (max %us).\n",
                          val, (unsigned)(SENSOR_MAX_ACTIVE_MS / 1000));
          }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
        break;
      }

      case SENSOR_ACTIVE: {
        // Check if motion was stopped externally (e.g. from web UI)
        if (!isSensorAnimActive(1)) {
          state = SENSOR_COOLDOWN;
          cooldownStartMs = millis();
          hitCount = 0;
          break;
        }

        // Update presence timestamp while person is still in front of sensor
        if (val > SENSOR_THRESHOLD) {
          lastDetectedMs = millis();
        }

        uint32_t now = millis();
        bool maxReached = ((uint32_t)(now - sessionStartMs) >= SENSOR_MAX_ACTIVE_MS);
        bool personLeft = ((uint32_t)(now - lastDetectedMs) >= SENSOR_LEAVE_TIMEOUT_MS);

        if (maxReached || personLeft) {
          stopSensorAnim(1);
          state = SENSOR_COOLDOWN;
          cooldownStartMs = now;
          hitCount = 0;
          Serial.printf("[Sensor] Active session ended (%s). Entering %us rest cooldown (resting OPEN).\n",
                        maxReached ? "max 60s reached" : "person left",
                        (unsigned)(SENSOR_REST_COOLDOWN_MS / 1000));
        }

        vTaskDelay(pdMS_TO_TICKS(50));
        break;
      }

      case SENSOR_COOLDOWN: {
        // Ignore all sensor readings during strict 60s rest cooldown
        if ((uint32_t)(millis() - cooldownStartMs) >= SENSOR_REST_COOLDOWN_MS) {
          state = SENSOR_IDLE;
          hitCount = 0;
          Serial.println("[Sensor] Rest cooldown complete. Ready for next person.");
        }
        vTaskDelay(pdMS_TO_TICKS(100));
        break;
      }
    }
  }
}

// ─── HTTP API & WEB SERVER ───────────────────────────────────────────────────

// ponytail: CORS headers and OPTIONS preflight allow browser visualizer to query MCU directly
void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
}

// Cross-origin mutation protection: require custom header and emit CORS headers
bool checkMutationAuth() {
  sendCorsHeaders();
  if (server.method() == HTTP_OPTIONS) {
    server.send(204);
    return false;
  }
  if (!server.hasHeader("X-Requested-With")) {
    server.send(403, "application/json", "{\"error\":\"Forbidden: Missing X-Requested-With header\"}");
    return false;
  }
  return true;
}

void handleApiStatus() {
  sendCorsHeaders();
  if (server.method() == HTTP_OPTIONS) {
    server.send(204);
    return;
  }

  xSemaphoreTake(stateMutex, portMAX_DELAY);
  bool curAuto = isAutoMode;
  bool curPause = isPaused;
  int angles[NUM_SERVOS];
  int pulses[NUM_SERVOS];
  char statuses[NUM_SERVOS][16];
  char phases[NUM_SERVOS][16];
  bool running[NUM_SERVOS];
  int cycles[NUM_SERVOS];
  uint32_t restRemaining[NUM_SERVOS];
  bool attached[NUM_SERVOS];
  uint32_t now = millis();

  for (int i = 0; i < NUM_SERVOS; i++) {
    angles[i] = commanded_angles[i];
    pulses[i] = last_actual_pulse_us[i];
    strncpy(statuses[i], servo_status_str[i], sizeof(statuses[i]) - 1);
    statuses[i][sizeof(statuses[i]) - 1] = '\0';
    strncpy(phases[i], servo_phase_str[i], sizeof(phases[i]) - 1);
    phases[i][sizeof(phases[i]) - 1] = '\0';
    attached[i] = servo_attached[i];
    running[i] = servo_running[i] && servo_attached[i];
    cycles[i] = servo_attached[i] ? servo_cycle[i] : 0;
    if (running[i] && strcmp(phases[i], "rest") == 0 && servo_rest_until[i] > now) {
      restRemaining[i] = servo_rest_until[i] - now;
    } else {
      restRemaining[i] = 0;
    }
  }
  bool r1 = relay_states[0];
  bool r2 = relay_states[1];
  int sOpen = seq_open_deg;
  int sClose = seq_close_deg;
  int sHold = seq_hold_ms;
  int sCycles = seq_cycles_per_session;
  int sRest = seq_rest_ms;
  int sActive = seq_active_duration_ms;
  xSemaphoreGive(stateMutex);

  uint32_t uptimeSec = millis() / 1000;
  uint32_t freeHeap = ESP.getFreeHeap();
  bool wifiConn = (WiFi.status() == WL_CONNECTED);
  String staIp = wifiConn ? WiFi.localIP().toString() : "disconnected";
  String apIp = WiFi.softAPIP().toString();

  char json[2560];
  snprintf(json, sizeof(json),
           "{"
           "\"mode\":\"%s\","
           "\"paused\":%s,"
           "\"uptime\":%u,"
           "\"free_heap\":%u,"
           "\"chip_model\":\"%s\","
           "\"wifi_connected\":%s,"
           "\"sta_ip\":\"%s\","
           "\"ap_ip\":\"%s\","
           "\"mdns\":\"%s\","
           "\"ota_auth\":\"none (preexisting limitation)\","
           "\"servos\":["
           "{\"id\":1,\"pin\":%d,\"name\":\"Servo 1\",\"angle\":%d,\"pulse_us\":%d,\"status\":\"%s\",\"active\":true,\"running\":%s,\"phase\":\"%s\",\"cycle\":%d,\"rest_remaining_ms\":%u,\"attached\":%s},"
           "{\"id\":2,\"pin\":%d,\"name\":\"Servo 2\",\"angle\":%d,\"pulse_us\":%d,\"status\":\"%s\",\"active\":true,\"running\":%s,\"phase\":\"%s\",\"cycle\":%d,\"rest_remaining_ms\":%u,\"attached\":%s},"
           "{\"id\":3,\"pin\":%d,\"name\":\"Servo 3\",\"angle\":%d,\"pulse_us\":%d,\"status\":\"%s\",\"active\":false,\"running\":false,\"phase\":\"idle\",\"cycle\":0,\"rest_remaining_ms\":0,\"attached\":%s},"
           "{\"id\":4,\"pin\":%d,\"name\":\"Servo 4\",\"angle\":%d,\"pulse_us\":%d,\"status\":\"%s\",\"active\":false,\"running\":false,\"phase\":\"idle\",\"cycle\":0,\"rest_remaining_ms\":0,\"attached\":%s},"
           "{\"id\":5,\"pin\":%d,\"name\":\"Servo 5\",\"angle\":%d,\"pulse_us\":%d,\"status\":\"%s\",\"active\":false,\"running\":false,\"phase\":\"idle\",\"cycle\":0,\"rest_remaining_ms\":0,\"attached\":%s}"
           "],"
           "\"relays\":["
           "{\"id\":1,\"pin\":%d,\"state\":%d},"
           "{\"id\":2,\"pin\":%d,\"state\":%d}"
           "],"
           "\"eye_mode\":%s,"
           "\"sequence\":{\"open_deg\":%d,\"close_deg\":%d,\"hold_ms\":%d,\"cycles_per_session\":%d,\"rest_ms\":%d,\"active_ms\":%d}"
           "}",
           curAuto ? "auto" : "manual",
           curPause ? "true" : "false",
           uptimeSec,
           freeHeap,
           ESP.getChipModel(),
           wifiConn ? "true" : "false",
           staIp.c_str(),
           apIp.c_str(),
           MDNS_HOST,
           SERVO_PINS[0], angles[0], pulses[0], statuses[0], running[0] ? "true" : "false", phases[0], cycles[0], restRemaining[0], attached[0] ? "true" : "false",
           SERVO_PINS[1], angles[1], pulses[1], statuses[1], running[1] ? "true" : "false", phases[1], cycles[1], restRemaining[1], attached[1] ? "true" : "false",
           SERVO_PINS[2], angles[2], pulses[2], statuses[2], attached[2] ? "true" : "false",
           SERVO_PINS[3], angles[3], pulses[3], statuses[3], attached[3] ? "true" : "false",
           SERVO_PINS[4], angles[4], pulses[4], statuses[4], attached[4] ? "true" : "false",
           RELAY_1, r1 ? 1 : 0,
           RELAY_2, r2 ? 1 : 0,
           STANDALONE_EYES_MODE ? "true" : "false",
           sOpen, sClose, sHold, sCycles, sRest, sActive);

  server.send(200, "application/json", json);
}

void handleApiMode() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("mode")) {
    server.send(400, "application/json", "{\"error\":\"Missing mode parameter\"}");
    return;
  }
  String m = server.arg("mode");
  if (m == "manual") {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    isAutoMode = false;
    xSemaphoreGive(stateMutex);
    stopServoSeq(0, true);
    stopServoSeq(1, true);
    server.send(200, "application/json", "{\"ok\":true,\"mode\":\"manual\"}");
  } else if (m == "auto") {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    isAutoMode = true;
    xSemaphoreGive(stateMutex);
    if (!getIsPaused()) {
      startServoSeq(0);
      startServoSeq(1);
    }
    server.send(200, "application/json", "{\"ok\":true,\"mode\":\"auto\"}");
  } else {
    server.send(400, "application/json", "{\"error\":\"Mode must be 'manual' or 'auto'\"}");
  }
}

void handleApiPause() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("paused")) {
    server.send(400, "application/json", "{\"error\":\"Missing paused parameter\"}");
    return;
  }
  int p = server.arg("paused").toInt();
  bool reqPaused = (p != 0) || server.arg("paused").equalsIgnoreCase("true");

  if (reqPaused) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    isPaused = true;
    for (int i = 0; i < NUM_SERVOS; i++) {
      servoEpoch[i]++;
    }
    servo_running[0] = false;
    servo_running[1] = false;
    anim_active[0] = false;
    anim_active[1] = false;
    servo_cycle[0] = 0;
    servo_cycle[1] = 0;
    servo_rest_until[0] = 0;
    servo_rest_until[1] = 0;
    strncpy(servo_phase_str[0], "idle", sizeof(servo_phase_str[0]) - 1);
    servo_phase_str[0][sizeof(servo_phase_str[0]) - 1] = '\0';
    strncpy(servo_phase_str[1], "idle", sizeof(servo_phase_str[1]) - 1);
    servo_phase_str[1][sizeof(servo_phase_str[1]) - 1] = '\0';
    // ponytail: preserve DETACHED status when pausing
    for (int i = 0; i < 2; i++) {
      if (!servo_attached[i]) {
        strncpy(servo_status_str[i], "DETACHED", sizeof(servo_status_str[i]) - 1);
      } else {
        strncpy(servo_status_str[i], "IDLE", sizeof(servo_status_str[i]) - 1);
      }
      servo_status_str[i][sizeof(servo_status_str[i]) - 1] = '\0';
    }
    if (servoQueue1) xQueueReset(servoQueue1);
    if (servoQueue2) xQueueReset(servoQueue2);
    xSemaphoreGive(stateMutex);
    setServoPower(0, false);
    setServoPower(1, false);
  } else {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    isPaused = false;
    bool autoMode = isAutoMode;
    xSemaphoreGive(stateMutex);
    if (autoMode) {
      startServoSeq(0);
      startServoSeq(1);
    }
  }

  server.send(200, "application/json", reqPaused ? "{\"ok\":true,\"paused\":true}" : "{\"ok\":true,\"paused\":false}");
}

void handleApiServo() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("id") || !server.hasArg("angle")) {
    server.send(400, "application/json", "{\"error\":\"Missing id or angle\"}");
    return;
  }
  int id = server.arg("id").toInt();
  int angle = server.arg("angle").toInt();
  if (id < 1 || id > 2) {
    server.send(400, "application/json", "{\"error\":\"Manual command supported on Servo 1 and 2 only (3-5 are parked auxiliary)\"}");
    return;
  }
  if (angle < MIN_SERVO || angle > MAX_SERVO) {
    server.send(400, "application/json", "{\"error\":\"Angle out of range (0-180)\"}");
    return;
  }
  bool queued = false;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  if (isPaused) {
    xSemaphoreGive(stateMutex);
    server.send(409, "application/json", "{\"error\":\"Firmware is paused\"}");
    return;
  }
  if (isAutoMode) {
    xSemaphoreGive(stateMutex);
    server.send(409, "application/json", "{\"error\":\"Manual commands locked in Automatic mode\"}");
    return;
  }
  if (!servo_attached[id - 1]) {
    xSemaphoreGive(stateMutex);
    server.send(409, "application/json", "{\"error\":\"Servo is detached\"}");
    return;
  }
  if (servo_running[id - 1]) {
    xSemaphoreGive(stateMutex);
    server.send(409, "application/json", "{\"error\":\"Manual commands locked while sequence is running\"}");
    return;
  }

  int idx = id - 1;
  uint32_t candidateEpoch = servoEpoch[idx] + 1;
  ServoCommand cmd = { CMD_SET_ANGLE, angle, candidateEpoch };
  QueueHandle_t q = (idx == 0) ? servoQueue1 : servoQueue2;
  if (q && xQueueSend(q, &cmd, 0) == pdTRUE) {
    servoEpoch[idx] = candidateEpoch;
    servo_cycle[idx] = 0;
    servo_rest_until[idx] = 0;
    queued = true;
  }
  xSemaphoreGive(stateMutex);

  if (queued) {
    server.send(200, "application/json", "{\"ok\":true}");
  } else {
    server.send(503, "application/json", "{\"error\":\"Servo command queue full\"}");
  }
}

// POST /api/run id=1|2&running=1|0 explicitly idempotent independent start/stop
void handleApiRun() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("id") || !server.hasArg("running")) {
    server.send(400, "application/json", "{\"error\":\"Missing id or running parameter\"}");
    return;
  }
  int id = server.arg("id").toInt();
  if (id < 1 || id > 2) {
    server.send(400, "application/json", "{\"error\":\"Sequence supported on Servo 1 and 2 only\"}");
    return;
  }

  String rStr = server.arg("running");
  int runVal = -1;
  if (rStr == "1" || rStr.equalsIgnoreCase("true")) runVal = 1;
  else if (rStr == "0" || rStr.equalsIgnoreCase("false")) runVal = 0;

  if (runVal == -1) {
    server.send(400, "application/json", "{\"error\":\"Parameter running must be 1 or 0\"}");
    return;
  }

  char resp[64];
  if (runVal == 1) {
    if (getIsPaused()) {
      server.send(409, "application/json", "{\"error\":\"Firmware is paused\"}");
      return;
    }
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    bool isAtt = servo_attached[id - 1];
    xSemaphoreGive(stateMutex);
    if (!isAtt) {
      server.send(409, "application/json", "{\"error\":\"Servo is detached\"}");
      return;
    }
    startServoSeq(id - 1);
    snprintf(resp, sizeof(resp), "{\"ok\":true,\"id\":%d,\"running\":true}", id);
    server.send(200, "application/json", resp);
  } else {
    stopServoSeq(id - 1, true /* explicit stop */);
    snprintf(resp, sizeof(resp), "{\"ok\":true,\"id\":%d,\"running\":false}", id);
    server.send(200, "application/json", resp);
  }
}

// POST /api/attachment id=1|2&attached=0|1 explicit attach/detach
void handleApiAttachment() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("id") || !server.hasArg("attached")) {
    server.send(400, "application/json", "{\"error\":\"Missing id or attached parameter\"}");
    return;
  }
  String idStr = server.arg("id");
  if (idStr != "1" && idStr != "2") {
    server.send(400, "application/json", "{\"error\":\"Parameter id must be 1 or 2\"}");
    return;
  }
  int id = (idStr == "1") ? 1 : 2;

  String aStr = server.arg("attached");
  int attVal = -1;
  if (aStr == "1" || aStr.equalsIgnoreCase("true")) attVal = 1;
  else if (aStr == "0" || aStr.equalsIgnoreCase("false")) attVal = 0;

  if (attVal == -1) {
    server.send(400, "application/json", "{\"error\":\"Parameter attached must be 1 or 0\"}");
    return;
  }

  int idx = id - 1;
  char resp[64];

  xSemaphoreTake(stateMutex, portMAX_DELAY);

  if (attVal == 0) {
    // Detach: cancels queued commands/running/session/rest, invalidates epoch, disables PWM
    // Always permitted even during pause/auto/running. Idempotent.
    if (servo_attached[idx]) {
      servoEpoch[idx]++;
      servo_running[idx] = false;
      anim_active[idx] = false;
      servo_cycle[idx] = 0;
      servo_rest_until[idx] = 0;
      servo_attached[idx] = false;
      strncpy(servo_status_str[idx], "DETACHED", sizeof(servo_status_str[idx]) - 1);
      servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
      strncpy(servo_phase_str[idx], "idle", sizeof(servo_phase_str[idx]) - 1);
      servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';
      QueueHandle_t q = (idx == 0) ? servoQueue1 : servoQueue2;
      if (q) xQueueReset(q);
      servos[idx].detach();
    }
    xSemaphoreGive(stateMutex);
    setServoPower(idx, false);
    snprintf(resp, sizeof(resp), "{\"ok\":true,\"id\":%d,\"attached\":false}", id);
    server.send(200, "application/json", resp);
    return;
  } else {
    // Attach: reject attach while paused (detach always permitted).
    if (isPaused) {
      xSemaphoreGive(stateMutex);
      server.send(409, "application/json", "{\"error\":\"Cannot attach servo while paused\"}");
      return;
    }
    // Idempotent: no duplicate reinitialization
    if (servo_attached[idx]) {
      xSemaphoreGive(stateMutex);
      snprintf(resp, sizeof(resp), "{\"ok\":true,\"id\":%d,\"attached\":true}", id);
      server.send(200, "application/json", resp);
      return;
    }

    // Attach explicit restores last ACTUAL emitted pulse not target commanded angle,
    // reuse 50Hz pin and 500..2500, check servo.attached() for success;
    // leaves idle stopped and sensor explicitStopped=true
    servos[idx].setPeriodHertz(50);
    servos[idx].attach(SERVO_PINS[idx], MIN_SERVO_US, MAX_SERVO_US);
    if (!servos[idx].attached()) {
      xSemaphoreGive(stateMutex);
      server.send(500, "application/json", "{\"error\":\"Failed to attach servo PWM\"}");
      return;
    }

    int restorePulse = last_actual_pulse_us[idx];
    if (restorePulse < MIN_SERVO_US || restorePulse > MAX_SERVO_US) {
      restorePulse = map(START_DEG, MIN_SERVO, MAX_SERVO, MIN_SERVO_US, MAX_SERVO_US);
      last_actual_pulse_us[idx] = restorePulse;
    }
    servos[idx].writeMicroseconds(restorePulse);

    servo_attached[idx] = true;
    servo_running[idx] = false;
    servo_cycle[idx] = 0;
    servo_rest_until[idx] = 0;
    explicit_stopped[idx] = true;
    commanded_angles[idx] = map(restorePulse, MIN_SERVO_US, MAX_SERVO_US, MIN_SERVO, MAX_SERVO);
    strncpy(servo_status_str[idx], "IDLE", sizeof(servo_status_str[idx]) - 1);
    servo_status_str[idx][sizeof(servo_status_str[idx]) - 1] = '\0';
    strncpy(servo_phase_str[idx], "idle", sizeof(servo_phase_str[idx]) - 1);
    servo_phase_str[idx][sizeof(servo_phase_str[idx]) - 1] = '\0';

    xSemaphoreGive(stateMutex);
    snprintf(resp, sizeof(resp), "{\"ok\":true,\"id\":%d,\"attached\":true}", id);
    server.send(200, "application/json", resp);
    return;
  }
}

void handleApiRelay() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("id") || !server.hasArg("state")) {
    server.send(400, "application/json", "{\"error\":\"Missing id or state\"}");
    return;
  }
  int id = server.arg("id").toInt();
  int st = server.arg("state").toInt();
  if (id < 1 || id > 2) {
    server.send(400, "application/json", "{\"error\":\"Relay id must be 1 or 2\"}");
    return;
  }
  if (st != 0 && st != 1) {
    server.send(400, "application/json", "{\"error\":\"State must be 0 or 1\"}");
    return;
  }
  if (getIsPaused()) {
    server.send(409, "application/json", "{\"error\":\"Firmware is paused\"}");
    return;
  }

  // Guard: do not allow turning OFF while servo motion is actively running
  if (st == 0) {
    int idx = id - 1;
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    bool busy = servo_running[idx] || anim_active[idx];
    xSemaphoreGive(stateMutex);
    if (busy) {
      server.send(409, "application/json", "{\"error\":\"Cannot power off relay while servo motion is active\"}");
      return;
    }
  }

  setServoPower(id - 1, st == 1);

  server.send(200, "application/json", "{\"ok\":true}");
}

static bool parseStrictInt(const String& s, long minVal, long maxVal, int& outVal) {
  if (s.length() == 0) return false;
  const char* str = s.c_str();
  if (*str != '+' && *str != '-' && !isdigit((unsigned char)*str)) return false;
  char* endptr = NULL;
  errno = 0;
  long val = strtol(str, &endptr, 10);
  if (errno != 0 || endptr == str || *endptr != '\0') return false;
  if (val < minVal || val > maxVal) return false;
  outVal = (int)val;
  return true;
}

void handleApiSequence() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("open_deg") || !server.hasArg("close_deg") || !server.hasArg("hold_ms")) {
    server.send(400, "application/json", "{\"error\":\"Missing sequence parameters\"}");
    return;
  }
  int open = server.arg("open_deg").toInt();
  int close = server.arg("close_deg").toInt();
  int hold = server.arg("hold_ms").toInt();

  if (open < MIN_SERVO || open > MAX_SERVO || close < MIN_SERVO || close > MAX_SERVO) {
    server.send(400, "application/json", "{\"error\":\"Angles must be between 0 and 180\"}");
    return;
  }
  if (open == close) {
    server.send(400, "application/json", "{\"error\":\"Open and Close angles must be distinct\"}");
    return;
  }
  if (hold < 50 || hold > 5000) {
    server.send(400, "application/json", "{\"error\":\"Hold duration must be 50 to 5000 ms\"}");
    return;
  }

  int cycles = seq_cycles_per_session;
  if (server.hasArg("cycles_per_session")) {
    if (!parseStrictInt(server.arg("cycles_per_session"), 1, 100, cycles)) {
      server.send(400, "application/json", "{\"error\":\"Cycles per session must be an integer between 1 and 100\"}");
      return;
    }
  }

  int rest = seq_rest_ms;
  if (server.hasArg("rest_ms")) {
    if (!parseStrictInt(server.arg("rest_ms"), 0, 3600000, rest)) {
      server.send(400, "application/json", "{\"error\":\"Rest duration must be an integer between 0 and 3600000 ms\"}");
      return;
    }
  }

  int active = seq_active_duration_ms;
  if (server.hasArg("active_ms")) {
    if (!parseStrictInt(server.arg("active_ms"), 1000, 3600000, active)) {
      server.send(400, "application/json", "{\"error\":\"Active duration must be an integer between 1000 and 3600000 ms\"}");
      return;
    }
  }

  if (!isValidSequenceConfig(open, close, hold, cycles, rest, active)) {
    server.send(400, "application/json", "{\"error\":\"Invalid sequence parameters\"}");
    return;
  }

  xSemaphoreTake(stateMutex, portMAX_DELAY);
  seq_open_deg = open;
  seq_close_deg = close;
  seq_hold_ms = hold;
  seq_cycles_per_session = cycles;
  seq_rest_ms = rest;
  seq_active_duration_ms = active;
  xSemaphoreGive(stateMutex);

  // Restart active loops with new parameters immediately
  restartServoSeq(0);
  restartServoSeq(1);

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleApiSequenceReset() {
  if (!checkMutationAuth()) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  seq_open_deg = DEFAULT_SEQ_OPEN_DEG;
  seq_close_deg = DEFAULT_SEQ_CLOSE_DEG;
  seq_hold_ms = DEFAULT_SEQ_HOLD_MS;
  seq_cycles_per_session = DEFAULT_SEQ_CYCLES;
  seq_rest_ms = DEFAULT_SEQ_REST_MS;
  seq_active_duration_ms = DEFAULT_SEQ_ACTIVE_MS;
  xSemaphoreGive(stateMutex);

  restartServoSeq(0);
  restartServoSeq(1);

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleApiSequenceSave() {
  if (!checkMutationAuth()) return;

  int open, close, hold, cycles, rest, active;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  open = seq_open_deg;
  close = seq_close_deg;
  hold = seq_hold_ms;
  cycles = seq_cycles_per_session;
  rest = seq_rest_ms;
  active = seq_active_duration_ms;
  xSemaphoreGive(stateMutex);

  if (!isValidSequenceConfig(open, close, hold, cycles, rest, active)) {
    server.send(400, "application/json", "{\"error\":\"Active sequence parameters are invalid\"}");
    return;
  }

  Preferences prefs;
  if (!prefs.begin("noyaseq", false)) {
    server.send(500, "application/json", "{\"error\":\"Failed to open storage\"}");
    return;
  }

  SequenceConfigBlob stored;
  memset(&stored, 0, sizeof(stored));
  size_t readBytes = prefs.getBytes("seqcfg", &stored, sizeof(stored));
  if (readBytes == sizeof(stored) &&
      stored.magic == SEQ_CONFIG_MAGIC &&
      stored.version == SEQ_CONFIG_VERSION &&
      stored.open_deg == (int16_t)open &&
      stored.close_deg == (int16_t)close &&
      stored.cycles_per_session == (int16_t)cycles &&
      stored.hold_ms == (int32_t)hold &&
      stored.rest_ms == (int32_t)rest &&
      stored.active_ms == (int32_t)active) {
    prefs.end();
    server.send(200, "application/json", "{\"ok\":true,\"saved\":false,\"message\":\"Unchanged\"}");
    return;
  }

  SequenceConfigBlob toWrite;
  toWrite.magic = SEQ_CONFIG_MAGIC;
  toWrite.version = SEQ_CONFIG_VERSION;
  toWrite.open_deg = (int16_t)open;
  toWrite.close_deg = (int16_t)close;
  toWrite.cycles_per_session = (int16_t)cycles;
  toWrite.hold_ms = (int32_t)hold;
  toWrite.rest_ms = (int32_t)rest;
  toWrite.active_ms = (int32_t)active;

  size_t written = prefs.putBytes("seqcfg", &toWrite, sizeof(toWrite));
  prefs.end();

  if (written != sizeof(toWrite)) {
    server.send(500, "application/json", "{\"error\":\"Failed to write storage\"}");
    return;
  }

  server.send(200, "application/json", "{\"ok\":true,\"saved\":true}");
}

void initWebServer() {
  const char* headerkeys[] = { "X-Requested-With" };
  server.collectHeaders(headerkeys, 1);

  // Static Assets embedded via dashboard_assets.h (no-cache for static freshness)
  server.on("/", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.sendHeader("Cache-Control", "no-cache");
    server.send_P(200, "text/html", (const char*)INDEX_HTML_GZ, INDEX_HTML_GZ_LEN);
  });
  server.on("/index.html", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.sendHeader("Cache-Control", "no-cache");
    server.send_P(200, "text/html", (const char*)INDEX_HTML_GZ, INDEX_HTML_GZ_LEN);
  });
  server.on("/styles.css", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.sendHeader("Cache-Control", "no-cache");
    server.send_P(200, "text/css", (const char*)STYLES_CSS_GZ, STYLES_CSS_GZ_LEN);
  });
  server.on("/app.js", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.sendHeader("Cache-Control", "no-cache");
    server.send_P(200, "application/javascript", (const char*)APP_JS_GZ, APP_JS_GZ_LEN);
  });

  // REST API Endpoints
  server.on("/api/status", HTTP_GET, handleApiStatus);
  server.on("/api/mode", HTTP_POST, handleApiMode);
  server.on("/api/pause", HTTP_POST, handleApiPause);
  server.on("/api/servo", HTTP_POST, handleApiServo);
  server.on("/api/run", HTTP_POST, handleApiRun);
  server.on("/api/attachment", HTTP_POST, handleApiAttachment);
  server.on("/api/relay", HTTP_POST, handleApiRelay);
  server.on("/api/sequence", HTTP_POST, handleApiSequence);
  server.on("/api/sequence/reset", HTTP_POST, handleApiSequenceReset);
  server.on("/api/sequence/save", HTTP_POST, handleApiSequenceSave);

  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) {
      sendCorsHeaders();
      server.send(204);
      return;
    }
    server.send(404, "text/plain", "404: Not Found");
  });
}

// ─── OTA ─────────────────────────────────────────────────────────────────────
void initOTA() {
  ElegantOTA.begin(&server);

  ElegantOTA.onStart([]() {
    Serial.println("[OTA] Update starting...");
  });
  ElegantOTA.onEnd([](bool success) {
    if (success) Serial.println("[OTA] Done, rebooting.");
    else Serial.println("[OTA] Failed.");
  });
  ElegantOTA.onProgress([](size_t cur, size_t total) {
    Serial.printf("[OTA] Progress: %d / %d\n", cur, total);
  });

  initWebServer();
  server.begin();

  Serial.println("[OTA] Ready at:");
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("  STA: http://%s/update\n", WiFi.localIP().toString().c_str());
  }
  Serial.printf("  AP:  http://%s/update\n", WiFi.softAPIP().toString().c_str());
}

// ─── SETUP & MAIN LOOP ───────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(3000);

  // Synchronization primitives
  stateMutex = xSemaphoreCreateMutex();
  servoQueue1 = xQueueCreate(5, sizeof(ServoCommand));
  servoQueue2 = xQueueCreate(5, sizeof(ServoCommand));

  loadSavedSequenceConfig();

  initWiFi();
  initOTA();
  delay(500);

  pinMode(RELAY_1, OUTPUT);
  pinMode(RELAY_2, OUTPUT);
  pinMode(SENSOR_PIN, INPUT);

  // Power on servos to park them at START_DEG during boot
  digitalWrite(RELAY_1, HIGH);
  digitalWrite(RELAY_2, HIGH);
  relay_states[0] = true;
  relay_states[1] = true;
  delay(80); // 80ms power rail stabilization delay

  Serial.println("A"); Serial.flush();
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  Serial.println("B"); Serial.flush();

  for (int i = 0; i < NUM_SERVOS; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(SERVO_PINS[i], MIN_SERVO_US, MAX_SERVO_US);
    servos[i].write(START_DEG);
    last_actual_pulse_us[i] = map(START_DEG, MIN_SERVO, MAX_SERVO, MIN_SERVO_US, MAX_SERVO_US);
    servo_attached[i] = servos[i].attached();
  }

  delay(1000); // mechanical settling delay into START_DEG

  // Power off relays so servos remain cool and quiet at rest
  digitalWrite(RELAY_1, LOW);
  digitalWrite(RELAY_2, LOW);
  relay_states[0] = false;
  relay_states[1] = false;

#if !STANDALONE_EYES_MODE
  // ESP-NOW Initialization
  if (esp_now_init() != ESP_OK) {
    Serial.println("[ESP-NOW] Init failed!");
  } else {
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0)
    esp_now_register_recv_cb(onDataRecv);
#else
    esp_now_register_recv_cb((esp_now_recv_cb_t)onDataRecv);
#endif
    Serial.printf("[ESP-NOW] Slave #%d ready on MAC " MACSTR " (Channel %d)\n",
                  SLAVE_INDEX, MAC2STR(SLAVE_MAC), AP_CHANNEL);
  }
#endif

  // Station WiFi manager is disabled so radio stays locked on Channel 6 for ESP-NOW
  // if (xTaskCreatePinnedToCore(wifiTask, "WiFi manager", 16384, NULL, 1, NULL, 0) != pdPASS) {
  //   Serial.println("[WiFi] ERROR: Could not create WiFi task; STA unavailable. AP remains enabled.");
  // }

  if (xTaskCreatePinnedToCore(servoWorkerTask, "Servo 1 Task", 4096, (void*)(intptr_t)0, 1, NULL, 0) != pdPASS) {
    Serial.println("[Servo 1] ERROR: Could not create task.");
  }

  if (xTaskCreatePinnedToCore(servoWorkerTask, "Servo 2 Task", 4096, (void*)(intptr_t)1, 1, NULL, 0) != pdPASS) {
    Serial.println("[Servo 2] ERROR: Could not create task.");
  }

#if STANDALONE_EYES_MODE
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  isAutoMode = true;
  xSemaphoreGive(stateMutex);
  startServoSeq(0);
  startServoSeq(1);
  Serial.println("[Mode] Standalone Eye Monster: Auto-started autonomous blinking (60s active / 60s rest)");
#endif

  if (IS_SENSOR && !STANDALONE_EYES_MODE) {
    if (xTaskCreatePinnedToCore(sensorServo, "Sensor Servo Task", 4096, NULL, 1, NULL, 0) != pdPASS) {
      Serial.println("[Sensor] ERROR: Could not create task.");
    }
  }
}

void loop() {
  static long long pingStart = millis();
  if (millis() - pingStart > 60000) {
    Serial.println("PING!");
    pingStart = millis();
  }

  server.handleClient();
  ElegantOTA.loop();
  vTaskDelay(pdMS_TO_TICKS(10));
}