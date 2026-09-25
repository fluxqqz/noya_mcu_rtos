// xTaskCreatePinnedToCore(
//   producerTask,   // Task function to run
//   "producer",     // Name (for debugging only)
//   4096,           // Stack size in bytes
//   NULL,           // Parameter to pass into the task (none)
//   1,              // Priority (higher = more urgent; matches Arduino loop())
//   NULL,           // Task handle output (not needed here)
//   0               // Pin to core 0
// );

#include <Arduino.h>
#include <ESP32Servo.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <ElegantOTA.h>
#include "dashboard_assets.h"

// ─── CONFIG ──────────────────────────────────────────────────────────────────
#include "secrets.h"  // Copy secrets.example.h to secrets.h before building.

const char* MDNS_HOST = "mcu-eye-monster";
// const char* MDNS_HOST = "mcu-plant-1";
// const char* MDNS_HOST = "mcu-plant-2";
// const char* MDNS_HOST = "mcu-plant-3";
// const char* MDNS_HOST = "mcu-plant-4";

const bool IS_SENSOR = false;

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

const int TRIG_PIN = 6;
const int ECHO_PIN = 7;

const int MAX_SERVO = 180;
const int MIN_SERVO = 0;
const int MAX_SERVO_US = 2500;
const int MIN_SERVO_US = 500;

const int START_DEG = 30;

const int COOLDOWN = 60000;

// ─── RTOS TASK QUEUES & SYNCHRONIZATION ───────────────────────────────────────
enum ServoCmdType {
  CMD_SET_ANGLE,
  CMD_RUN_SEQ
};

struct ServoCommand {
  ServoCmdType type;
  int angle;
};

static QueueHandle_t servoQueue1 = NULL;
static QueueHandle_t servoQueue2 = NULL;
static SemaphoreHandle_t stateMutex = NULL;

// Synchronized state shared between HTTP server and worker tasks
static bool isAutoMode = false;
static bool isPaused = false;
static int seq_open_deg = 30;
static int seq_close_deg = 85;
static int seq_hold_ms = 200;
static int seq_interval_s = 60;

static int commanded_angles[NUM_SERVOS] = { START_DEG, START_DEG, START_DEG, START_DEG, START_DEG };
static char servo_status_str[NUM_SERVOS][16] = { "IDLE", "IDLE", "PARKED", "PARKED", "PARKED" };
static uint32_t servoEpoch[NUM_SERVOS] = { 1, 1, 1, 1, 1 };
static bool relay_states[2] = { false, false };

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
  bool valid = (!isPaused && servoEpoch[servoIndex] == token);
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

int getSeqIntervalS() {
  if (!stateMutex) return 60;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  int val = seq_interval_s;
  xSemaphoreGive(stateMutex);
  return val;
}

void setServoAngleState(int index, int angle, const char* status) {
  if (!stateMutex || index < 0 || index >= NUM_SERVOS) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  commanded_angles[index] = angle;
  strncpy(servo_status_str[index], status, sizeof(servo_status_str[index]) - 1);
  servo_status_str[index][sizeof(servo_status_str[index]) - 1] = '\0';
  xSemaphoreGive(stateMutex);
}

void setServoState(int index, const char* status) {
  if (!stateMutex || index < 0 || index >= NUM_SERVOS) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  strncpy(servo_status_str[index], status, sizeof(servo_status_str[index]) - 1);
  servo_status_str[index][sizeof(servo_status_str[index]) - 1] = '\0';
  xSemaphoreGive(stateMutex);
}

// ─── WIFI & MDNS ─────────────────────────────────────────────────────────────
void initWiFi() {
  WiFi.mode(WIFI_AP_STA);
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
void moveServo(int setpoint_deg, Servo& servo, int servoIndex, uint32_t token) {
  setpoint_deg = constrain(setpoint_deg, MIN_SERVO, MAX_SERVO);
  int setpoint_us =
    map(setpoint_deg, MIN_SERVO, MAX_SERVO, MIN_SERVO_US, MAX_SERVO_US);

  float move = servo.readMicroseconds();
  if (move < MIN_SERVO_US || move > MAX_SERVO_US) {
    move = MIN_SERVO_US;
  }
  float prevmove = move;
  const float alpha = 0.01;

  while (abs(setpoint_us - (int)move) > 1) {
    if (!isEpochValid(servoIndex, token)) break;  // ponytail: token mismatch halts obsolete move promptly
    move = (setpoint_us * alpha) + (prevmove * (1.0 - alpha));
    prevmove = move;

    servo.writeMicroseconds((int)move);
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  if (isEpochValid(servoIndex, token)) {
    servo.writeMicroseconds(setpoint_us);
  }
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

void seqMove(Servo& servo, int servoIndex, uint32_t token) {
  int open, close, hold;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  open = seq_open_deg;
  close = seq_close_deg;
  hold = seq_hold_ms;
  xSemaphoreGive(stateMutex);

  for (int step = 0; step < 3; step++) {
    if (!isEpochValid(servoIndex, token)) return;
    setServoAngleState(servoIndex, open, "RUNNING");
    moveServo(open, servo, servoIndex, token);
    if (!waitEpochDelay(servoIndex, token, hold)) return;

    if (!isEpochValid(servoIndex, token)) return;
    setServoAngleState(servoIndex, close, "RUNNING");
    moveServo(close, servo, servoIndex, token);
    if (!waitEpochDelay(servoIndex, token, hold)) return;
  }

  if (!isEpochValid(servoIndex, token)) return;
  setServoAngleState(servoIndex, open, "RUNNING");
  moveServo(open, servo, servoIndex, token);
  if (!waitEpochDelay(servoIndex, token, hold)) return;
}

long readUs() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(5);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH);
  long distance = duration * 0.034 / 2;

  Serial.print("Distance:");
  Serial.println(distance);

  vTaskDelay(pdMS_TO_TICKS(100));

  return distance;
}

// ─── WORKER TASKS ─────────────────────────────────────────────────────────────
void loopServo1(void* pvParameters) {
  uint32_t lastMove = millis();
  for (;;) {
    ServoCommand cmd;
    if (servoQueue1 != NULL && xQueueReceive(servoQueue1, &cmd, 0) == pdTRUE) {
      if (!getIsPaused()) {
        uint32_t token = bumpServoEpoch(0);
        if (cmd.type == CMD_SET_ANGLE) {
          setServoAngleState(0, cmd.angle, "MANUAL SET");
          moveServo(cmd.angle, servos[0], 0, token);
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[0] == token && !isPaused) {
            strncpy(servo_status_str[0], "IDLE", sizeof(servo_status_str[0]) - 1);
          }
          xSemaphoreGive(stateMutex);
        } else if (cmd.type == CMD_RUN_SEQ) {
          seqMove(servos[0], 0, token);
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[0] == token && !isPaused) {
            commanded_angles[0] = seq_open_deg;
            strncpy(servo_status_str[0], "IDLE", sizeof(servo_status_str[0]) - 1);
          }
          xSemaphoreGive(stateMutex);
          Serial.println("loopServo1 seq done!");
        }
      }
    } else {
      if (getIsAuto() && !getIsPaused()) {
        uint32_t intervalMs = (uint32_t)getSeqIntervalS() * 1000UL;
        if (millis() - lastMove >= intervalMs) {
          uint32_t token = bumpServoEpoch(0);
          seqMove(servos[0], 0, token);
          lastMove = millis();
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[0] == token && !isPaused) {
            commanded_angles[0] = seq_open_deg;
            strncpy(servo_status_str[0], "IDLE", sizeof(servo_status_str[0]) - 1);
          }
          xSemaphoreGive(stateMutex);
          Serial.println("loopServo1 auto done!");
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void loopServo2(void* pvParameters) {
  uint32_t lastMove = millis();
  for (;;) {
    ServoCommand cmd;
    if (servoQueue2 != NULL && xQueueReceive(servoQueue2, &cmd, 0) == pdTRUE) {
      if (!getIsPaused()) {
        uint32_t token = bumpServoEpoch(1);
        if (cmd.type == CMD_SET_ANGLE) {
          setServoAngleState(1, cmd.angle, "MANUAL SET");
          moveServo(cmd.angle, servos[1], 1, token);
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[1] == token && !isPaused) {
            strncpy(servo_status_str[1], "IDLE", sizeof(servo_status_str[1]) - 1);
          }
          xSemaphoreGive(stateMutex);
        } else if (cmd.type == CMD_RUN_SEQ) {
          seqMove(servos[1], 1, token);
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[1] == token && !isPaused) {
            commanded_angles[1] = seq_open_deg;
            strncpy(servo_status_str[1], "IDLE", sizeof(servo_status_str[1]) - 1);
          }
          xSemaphoreGive(stateMutex);
          Serial.println("loopServo2 seq done!");
        }
      }
    } else {
      if (getIsAuto() && !getIsPaused()) {
        uint32_t intervalMs = (uint32_t)getSeqIntervalS() * 1000UL;
        if (millis() - lastMove >= intervalMs) {
          uint32_t token = bumpServoEpoch(1);
          seqMove(servos[1], 1, token);
          lastMove = millis();
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[1] == token && !isPaused) {
            commanded_angles[1] = seq_open_deg;
            strncpy(servo_status_str[1], "IDLE", sizeof(servo_status_str[1]) - 1);
          }
          xSemaphoreGive(stateMutex);
          Serial.println("loopServo2 auto done!");
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void sensorServo(void* pvParameters) {
  for (;;) {
    static long long move = millis();
    static int index = 0;

    ServoCommand cmd;
    if (servoQueue2 != NULL && xQueueReceive(servoQueue2, &cmd, 0) == pdTRUE) {
      if (!getIsPaused()) {
        uint32_t token = bumpServoEpoch(1);
        if (cmd.type == CMD_SET_ANGLE) {
          setServoAngleState(1, cmd.angle, "MANUAL SET");
          moveServo(cmd.angle, servos[1], 1, token);
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[1] == token && !isPaused) {
            strncpy(servo_status_str[1], "IDLE", sizeof(servo_status_str[1]) - 1);
          }
          xSemaphoreGive(stateMutex);
        } else if (cmd.type == CMD_RUN_SEQ) {
          seqMove(servos[1], 1, token);
          xSemaphoreTake(stateMutex, portMAX_DELAY);
          if (servoEpoch[1] == token && !isPaused) {
            commanded_angles[1] = seq_open_deg;
            strncpy(servo_status_str[1], "IDLE", sizeof(servo_status_str[1]) - 1);
          }
          xSemaphoreGive(stateMutex);
        }
      }
    }

    if (!getIsPaused()) {
      int dist = readUs();
      if (dist < 100) {
        index++;
      } else {
        index--;
      }

      if (index < 0) {
        index = 0;
      }

      if ((index > 5) && (millis() - move > 3000)) {
        Serial.println("Move!");
        uint32_t token = bumpServoEpoch(1);
        seqMove(servos[1], 1, token);
        move = millis();
        index = 0;
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        if (servoEpoch[1] == token && !isPaused) {
          commanded_angles[1] = seq_open_deg;
          strncpy(servo_status_str[1], "IDLE", sizeof(servo_status_str[1]) - 1);
        }
        xSemaphoreGive(stateMutex);
        Serial.println("Done");
      }
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// ─── HTTP API & WEB SERVER ───────────────────────────────────────────────────

// Cross-origin mutation protection: require custom header and emit no CORS headers
bool checkMutationAuth() {
  if (!server.hasHeader("X-Requested-With")) {
    server.send(403, "application/json", "{\"error\":\"Forbidden: Missing X-Requested-With header\"}");
    return false;
  }
  return true;
}

void handleApiStatus() {
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  bool curAuto = isAutoMode;
  bool curPause = isPaused;
  int angles[NUM_SERVOS];
  char statuses[NUM_SERVOS][16];
  for (int i = 0; i < NUM_SERVOS; i++) {
    angles[i] = commanded_angles[i];
    strncpy(statuses[i], servo_status_str[i], sizeof(statuses[i]) - 1);
    statuses[i][sizeof(statuses[i]) - 1] = '\0';
  }
  bool r1 = relay_states[0];
  bool r2 = relay_states[1];
  int sOpen = seq_open_deg;
  int sClose = seq_close_deg;
  int sHold = seq_hold_ms;
  int sInterval = seq_interval_s;
  xSemaphoreGive(stateMutex);

  uint32_t uptimeSec = millis() / 1000;
  uint32_t freeHeap = ESP.getFreeHeap();
  bool wifiConn = (WiFi.status() == WL_CONNECTED);
  String staIp = wifiConn ? WiFi.localIP().toString() : "disconnected";
  String apIp = WiFi.softAPIP().toString();

  char json[1024];
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
           "{\"id\":1,\"pin\":%d,\"name\":\"Servo 1\",\"angle\":%d,\"status\":\"%s\",\"active\":true},"
           "{\"id\":2,\"pin\":%d,\"name\":\"Servo 2\",\"angle\":%d,\"status\":\"%s\",\"active\":true},"
           "{\"id\":3,\"pin\":%d,\"name\":\"Servo 3\",\"angle\":%d,\"status\":\"%s\",\"active\":false},"
           "{\"id\":4,\"pin\":%d,\"name\":\"Servo 4\",\"angle\":%d,\"status\":\"%s\",\"active\":false},"
           "{\"id\":5,\"pin\":%d,\"name\":\"Servo 5\",\"angle\":%d,\"status\":\"%s\",\"active\":false}"
           "],"
           "\"relays\":["
           "{\"id\":1,\"pin\":%d,\"state\":%d},"
           "{\"id\":2,\"pin\":%d,\"state\":%d}"
           "],"
           "\"sequence\":{\"open_deg\":%d,\"close_deg\":%d,\"hold_ms\":%d,\"interval_s\":%d}"
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
           SERVO_PINS[0], angles[0], statuses[0],
           SERVO_PINS[1], angles[1], statuses[1],
           SERVO_PINS[2], angles[2], statuses[2],
           SERVO_PINS[3], angles[3], statuses[3],
           SERVO_PINS[4], angles[4], statuses[4],
           RELAY_1, r1 ? 1 : 0,
           RELAY_2, r2 ? 1 : 0,
           sOpen, sClose, sHold, sInterval);

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
    server.send(200, "application/json", "{\"ok\":true,\"mode\":\"manual\"}");
  } else if (m == "auto") {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    isAutoMode = true;
    xSemaphoreGive(stateMutex);
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
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  isPaused = (p != 0);
  if (isPaused) {
    // Invalidate operation epochs so any active wait/move aborts and cannot revive on quick resume
    for (int i = 0; i < NUM_SERVOS; i++) {
      servoEpoch[i]++;
    }
    // Cancel and purge queued work
    if (servoQueue1) xQueueReset(servoQueue1);
    if (servoQueue2) xQueueReset(servoQueue2);
    strncpy(servo_status_str[0], "IDLE", sizeof(servo_status_str[0]) - 1);
    strncpy(servo_status_str[1], "IDLE", sizeof(servo_status_str[1]) - 1);
  }
  xSemaphoreGive(stateMutex);
  server.send(200, "application/json", isPaused ? "{\"ok\":true,\"paused\":true}" : "{\"ok\":true,\"paused\":false}");
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
  if (getIsPaused()) {
    server.send(409, "application/json", "{\"error\":\"Firmware is paused\"}");
    return;
  }
  if (getIsAuto()) {
    server.send(409, "application/json", "{\"error\":\"Manual commands locked in Automatic mode\"}");
    return;
  }

  ServoCommand cmd = { CMD_SET_ANGLE, angle };
  QueueHandle_t q = (id == 1) ? servoQueue1 : servoQueue2;
  if (q && xQueueSend(q, &cmd, 0) == pdTRUE) {
    server.send(200, "application/json", "{\"ok\":true}");
  } else {
    server.send(503, "application/json", "{\"error\":\"Servo command queue full\"}");
  }
}

void handleApiRun() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("id")) {
    server.send(400, "application/json", "{\"error\":\"Missing id\"}");
    return;
  }
  int id = server.arg("id").toInt();
  if (id < 1 || id > 2) {
    server.send(400, "application/json", "{\"error\":\"Sequence supported on Servo 1 and 2 only\"}");
    return;
  }
  if (getIsPaused()) {
    server.send(409, "application/json", "{\"error\":\"Firmware is paused\"}");
    return;
  }

  ServoCommand cmd = { CMD_RUN_SEQ, 0 };
  QueueHandle_t q = (id == 1) ? servoQueue1 : servoQueue2;
  if (q && xQueueSend(q, &cmd, 0) == pdTRUE) {
    server.send(200, "application/json", "{\"ok\":true}");
  } else {
    server.send(503, "application/json", "{\"error\":\"Servo command queue full\"}");
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

  int pin = (id == 1) ? RELAY_1 : RELAY_2;
  digitalWrite(pin, st ? HIGH : LOW);

  xSemaphoreTake(stateMutex, portMAX_DELAY);
  relay_states[id - 1] = (st != 0);
  xSemaphoreGive(stateMutex);

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleApiSequence() {
  if (!checkMutationAuth()) return;
  if (!server.hasArg("open_deg") || !server.hasArg("close_deg") || !server.hasArg("hold_ms") || !server.hasArg("interval_s")) {
    server.send(400, "application/json", "{\"error\":\"Missing sequence parameters\"}");
    return;
  }
  int open = server.arg("open_deg").toInt();
  int close = server.arg("close_deg").toInt();
  int hold = server.arg("hold_ms").toInt();
  int interval = server.arg("interval_s").toInt();

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
  if (interval < 5 || interval > 600) {
    server.send(400, "application/json", "{\"error\":\"Interval must be 5 to 600 s\"}");
    return;
  }

  xSemaphoreTake(stateMutex, portMAX_DELAY);
  seq_open_deg = open;
  seq_close_deg = close;
  seq_hold_ms = hold;
  seq_interval_s = interval;
  xSemaphoreGive(stateMutex);

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleApiSequenceReset() {
  if (!checkMutationAuth()) return;
  xSemaphoreTake(stateMutex, portMAX_DELAY);
  seq_open_deg = 30;
  seq_close_deg = 85;
  seq_hold_ms = 200;
  seq_interval_s = 60;
  xSemaphoreGive(stateMutex);

  server.send(200, "application/json", "{\"ok\":true}");
}

void initWebServer() {
  const char* headerkeys[] = { "X-Requested-With" };
  server.collectHeaders(headerkeys, 1);

  // Static Assets embedded via dashboard_assets.h
  server.on("/", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.send_P(200, "text/html", (const char*)INDEX_HTML_GZ, INDEX_HTML_GZ_LEN);
  });
  server.on("/index.html", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.send_P(200, "text/html", (const char*)INDEX_HTML_GZ, INDEX_HTML_GZ_LEN);
  });
  server.on("/styles.css", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.sendHeader("Cache-Control", "max-age=3600");
    server.send_P(200, "text/css", (const char*)STYLES_CSS_GZ, STYLES_CSS_GZ_LEN);
  });
  server.on("/app.js", HTTP_GET, []() {
    server.sendHeader("Content-Encoding", "gzip");
    server.sendHeader("Cache-Control", "max-age=3600");
    server.send_P(200, "application/javascript", (const char*)APP_JS_GZ, APP_JS_GZ_LEN);
  });

  // REST API Endpoints
  server.on("/api/status", HTTP_GET, handleApiStatus);
  server.on("/api/mode", HTTP_POST, handleApiMode);
  server.on("/api/pause", HTTP_POST, handleApiPause);
  server.on("/api/servo", HTTP_POST, handleApiServo);
  server.on("/api/run", HTTP_POST, handleApiRun);
  server.on("/api/relay", HTTP_POST, handleApiRelay);
  server.on("/api/sequence", HTTP_POST, handleApiSequence);
  server.on("/api/sequence/reset", HTTP_POST, handleApiSequenceReset);

  server.onNotFound([]() {
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

  // Synchronization primitives
  stateMutex = xSemaphoreCreateMutex();
  servoQueue1 = xQueueCreate(5, sizeof(ServoCommand));
  servoQueue2 = xQueueCreate(5, sizeof(ServoCommand));

  initWiFi();
  initOTA();
  delay(500);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  for (int i = 0; i < NUM_SERVOS; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(SERVO_PINS[i], MIN_SERVO_US, MAX_SERVO_US);
    servos[i].write(START_DEG);
  }

  pinMode(RELAY_1, OUTPUT);
  pinMode(RELAY_2, OUTPUT);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  digitalWrite(RELAY_1, LOW);
  digitalWrite(RELAY_2, LOW);

  if (xTaskCreatePinnedToCore(wifiTask, "WiFi manager", 4096, NULL, 1, NULL, 0) != pdPASS) {
    Serial.println("[WiFi] ERROR: Could not create WiFi task; STA unavailable. AP remains enabled.");
  }

  if (xTaskCreatePinnedToCore(loopServo1, "Looping servo 1", 4096, NULL, 1, NULL, 0) != pdPASS) {
    Serial.println("[Servo 1] ERROR: Could not create task; automatic movement unavailable.");
  }

  if (IS_SENSOR) {
    if (xTaskCreatePinnedToCore(sensorServo, "Sensor based servo", 4096, NULL, 1, NULL, 0) != pdPASS) {
      Serial.println("[Sensor] ERROR: Could not create task; sensor-based movement unavailable.");
    }
  } else {
    if (xTaskCreatePinnedToCore(loopServo2, "Looping servo 2", 4096, NULL, 1, NULL, 0) != pdPASS) {
      Serial.println("[Servo 2] ERROR: Could not create task; automatic movement unavailable.");
    }
  }
}

void loop() {
  server.handleClient();
  ElegantOTA.loop();
  vTaskDelay(pdMS_TO_TICKS(10));
}