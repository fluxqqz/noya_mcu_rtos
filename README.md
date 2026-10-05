# Animatronics & Eye Monster Controller (ESP32-C6 RTOS)

Firmware and embedded web dashboard for ESP32-C6 servo/relay animatronics. Supports two operation modes:
1. **Standalone Eye Monster Mode:** Autonomous eyelid blinking (60s active / 60s rest) with relay power management. No master required.
2. **ESP-NOW Slave Plant Mode:** Synchronized animatronic mouths (Plant 1 to 4) controlled by a Master ESP32 over low-latency ESP-NOW wireless protocol.

---

## 1. Hardware Architecture & Wiring

Each board independently controls up to 2 servos through dedicated relays for silent, cool idling and battery/power savings.

```text
                  +---------------------------------------------+
                  |         External 5V / 6V Power Supply       |
                  +-------------+-------------------------------+
                                | (+)                       | (-)
                                |                           |
                 +--------------+                           |
                 |                                          |
                 v                                          |
           [2-Ch Relay Module]                              |
          COM 1      |     COM 2                            |
            |        |       |                              |
           NO 1      |      NO 2                            |
            |        |       |                              |
            v (+)    |       v (+)                          |
        [Servo 1]    |   [Servo 2]                          |
        Power Pin    |   Power Pin                          |
            |        |       |                              |
            +--------|-------+------------------------------+ (Common Ground)
                     |                                      |
                     +--------------------------------------+ (ESP32 GND)
                     |       |
                     v       v
           ESP32-C6 Board:
             GPIO 4   -------> Relay 1 IN (Active HIGH)
             GPIO 15  -------> Relay 2 IN (Active HIGH)
             GPIO 5   -------> Servo 1 PWM Signal (Mouth 1 / Eyelid 1)
             GPIO 1   -------> Servo 2 PWM Signal (Mouth 2 / Eyelid 2)
             GPIO 6   -------> (Optional) Analog Sensor IN
```

* **Relay Polarity:** Active HIGH (`HIGH` = relay closed / power connected, `LOW` = power cut).
* **Common Ground:** External power supply GND **must** be tied to the ESP32 GND.
* **Relay Output Contacts:** Wire servo `(+)` power wire through **NO (Normally Open)** and **COM**.

---

## 2. Slave & Eye Monster Parameters (`noya_mcu_rtos.ino`)

All user-configurable parameters are located near the top of `noya_mcu_rtos.ino`:

### A. Operation Mode & Device Identity

| Parameter | Location | Default | Description |
|---|---|---|---|
| `STANDALONE_EYES_MODE` | Line 19 | `true` | **`true`**: Autonomous eye blinking (60s active / 60s rest).<br>**`false`**: ESP-NOW slave plant controlled by master. |
| `SLAVE_INDEX` | Line 25 | `1` | Slave ID (`1` = Plant 1, `2` = Plant 2, `3` = Plant 3, `4` = Plant 4). Used when `STANDALONE_EYES_MODE` is `false`. |

---

### B. Motion Angles & Rest Positions

| Parameter | Location | Default | Description |
|---|---|---|---|
| `DEFAULT_SERVO_PRESETS` | Line 98 | `{ { 50, 100 }, { 50, 100 } }` | Hard-coded default manual preset angles displayed on the dashboard buttons and inputs for Servo 1 and Servo 2. |
| `DEFAULT_SEQ_OPEN_DEG` | Line 135 | `30` | Resting / open angle in degrees (`0` to `180`). Eyelids open or mouth open. |
| `DEFAULT_SEQ_CLOSE_DEG` | Line 136 | `85` | Closed angle in degrees (`0` to `180`). Eyelids closed/blink or mouth closed. |
| `START_DEG` | Line 91 | `50` | Initial parking angle commanded briefly during boot setup before relays cut power. |

---

### C. Timing & Speed Parameters

| Parameter | Location | Default | Description |
|---|---|---|---|
| `DEFAULT_SEQ_ACTIVE_MS` | Line 131 | `60000` | Duration of active movement session in milliseconds (60,000 ms = **60 seconds**). In Eye Mode, dashboard adapts to show **Active Duration (s)**. |
| `DEFAULT_SEQ_REST_MS` | Line 130 | `60000` (Eye) / `10000` (Plant) | Sleep / rest duration in milliseconds. Both relays turn **OFF** during this window. |
| `DEFAULT_SEQ_HOLD_MS` | Line 127 | `200` | Pause duration in milliseconds at each open and closed endpoint. |
| `seq_move_duration_ms` | Line 164 | `3000` | Stroke duration in milliseconds for each movement stroke. |
| `seq_motion_profile` | Line 163 | `MotionProfile::Exponential` | Motion smoothing algorithm:<br>• `MotionProfile::Exponential`: Gentle ease curve.<br>• `MotionProfile::SCurve`: Ken Perlin quintic smoothstep ease-in and ease-out. |

---

### D. Power Management Delays

| Delay | Location | Default | Description |
|---|---|---|---|
| **Turn-on stabilization** | Line 270 | `80 ms` | Non-blocking delay after relay clicks ON to allow the 5V rail voltage and capacitors to stabilize before sending PWM. |
| **Manual hold torque** | Line 93 | `15000 ms` | Holding torque timeout (15s) after manual slider moves before auto-powering down the relay. Resets on new slider input. |
| **Turn-off settling** | Line 610, 672, 794 | `500 ms` | Delay after the servo reaches its resting position before cutting relay power, ensuring mechanical gears have completely stopped. |

---

### E. Sensor Presence Interaction & Built-in C6 RGB Status LED (Plant Mode)

When `STANDALONE_EYES_MODE` is `false` and `IS_SENSOR` is `true`, Mouth 2 interacts with people walking up to the plant:

| Parameter | Location | Default | Description |
|---|---|---|---|
| `IS_SENSOR` | Line 54 | `true` | Enables the background sensor task (`GPIO 6`). |
| `SENSOR_THRESHOLD` | Line 58 | `200` | Analog ADC threshold (`0..4095`) to detect person presence. |
| `SENSOR_MAX_ACTIVE_MS` | Line 61 | `60000` | Maximum continuous movement duration (60s) while person is present. |
| `SENSOR_REST_COOLDOWN_MS` | Line 62 | `60000` | Strict cooldown rest (60s) where sensor triggers are ignored; mouth rests OPEN with Relay 2 OFF. |
| `SENSOR_LEAVE_TIMEOUT_MS` | Line 63 | `1500` | Absence timeout (1.5s) before recognizing the person has walked away. Stepping back for < 1.5s does not stop the mouth. |

#### Built-in ESP32-C6 RGB LED Status (GPIO 8):
The onboard addressable RGB LED directly signals the sensor servo presence state:
* **Blue `(0, 0, 50)`:** **IDLE / Waiting** — Sensor armed and waiting for a person.
* **Green `(0, 50, 0)`:** **ACTIVE (Not Rest)** — Person detected, Mouth 2 actively flapping.
* **Red `(50, 0, 0)`:** **COOLDOWN (Rest)** — Resting OPEN with Relay 2 OFF; sensor input ignored during cooldown.
* **Off `(0, 0, 0)`:** Device paused, booting, or sensor task disabled.

---

### F. Independent Per-Servo Sequences
Servo 1 and Servo 2 each possess their own independent sequence configuration:
* **Dashboard Tabs:** Inside Sequence Settings, click **`[ Servo 1 ]`** or **`[ Servo 2 ]`** to switch and configure angles, hold delay, cycles/active duration, and rest duration for each servo independently.
* **Per-Servo Apply:** Clicking **Apply** updates only the selected servo's sequence in RAM.
* **Flash Persistence:** Clicking **Save to Device** writes both Servo 1 and Servo 2 configurations into NVS flash storage (v3 blob) so both persist across reboots.

---

## 3. Master ESP Parameters (`master_esp\master_esp.ino`)

The Master ESP coordinates choreographed multi-plant dialogue and chorus routines.

### A. Network Configuration

| Parameter | Location | Default | Description |
|---|---|---|---|
| `WIFI_SSID` / `WIFI_PASS` | Lines 27–28 | `"Arthatronic"` | Venue / studio Wi-Fi router credentials. |
| `AP_SSID` / `AP_PASS` | Lines 33–34 | `"mcu-master"` / `"12345678"` | Master Access Point credentials (operates on Channel 6). |
| `MDNS_HOST` | Line 31 | `"mcu-master"` | URL to access the master dashboard: `http://mcu-master.local`. |

---

### B. Choreography Timeline (`ROUTINE[]`, lines 228–252)

To customize dialogue, singing, or choreography, modify the `ROUTINE[]` array:

```cpp
struct RoutineStep {
  uint8_t     slave_idx;     // 0 = Plant 1, 1 = Plant 2, 2 = Plant 3, 3 = Plant 4
  uint8_t     servo_idx;     // 0 = Mouth 1 (GPIO 5), 1 = Mouth 2 (GPIO 1)
  uint8_t     open_deg;      // Open / resting angle (e.g. 30)
  uint8_t     close_deg;     // Closed mouth angle (e.g. 85)
  uint32_t    duration_ms;   // How long this mouth should speak/chatter (in ms)
  uint32_t    delay_next_ms; // Delay before starting the NEXT step (0 = simultaneous!)
  const char* desc;          // Step name displayed on Master dashboard
};
```

#### Example Choreography Patterns:

1. **Solo Speech:**
   ```cpp
   { 0, 0, 30, 85, 3000, 3500, "Plant 1 speaks solo for 3 seconds" },
   ```
   *Plant 1 Mouth 1 speaks for 3000 ms, waits 3500 ms before next plant answers.*

2. **Duo / Overlapping Dialogue:**
   ```cpp
   { 0, 0, 30, 85, 4000, 1000, "Plant 1 Mouth 1 starts" },
   { 0, 1, 30, 85, 3000, 3500, "Plant 1 Mouth 2 joins 1 second later" },
   ```
   *Mouth 1 starts; Mouth 2 joins 1 second later while Mouth 1 is still talking.*

3. **Full Chorus (All 4 Plants Sing Together):**
   ```cpp
   { 0, 0, 30, 85, 3000, 0,    "Chorus: Plant 1" },
   { 1, 0, 30, 85, 3000, 0,    "Chorus: Plant 2" },
   { 2, 0, 30, 85, 3000, 0,    "Chorus: Plant 3" },
   { 3, 0, 30, 85, 3000, 3500, "Chorus: Plant 4" },
   ```
   *Setting `delay_next_ms = 0` fires all plants at the exact same instant.*

4. **Intermission Rest:**
   ```cpp
   { 0, 0, 30, 85, 0, 5000, "Rest break: All plants silent for 5s" },
   ```
   *`duration_ms = 0` sends no movement, just pauses the routine for 5000 ms.*

---

## 4. How to Tune Common Behaviors

### Recipe 1: Make Eye Blinking Faster or Slower
In `noya_mcu_rtos.ino`:
* For **faster, snappier blinks**:
  ```cpp
  static uint32_t seq_move_duration_ms = 800; // was 3000
  static const int DEFAULT_SEQ_HOLD_MS = 100; // was 200
  ```
* For **slow, dreamy blinks**:
  ```cpp
  static uint32_t seq_move_duration_ms = 4000;
  static const int DEFAULT_SEQ_HOLD_MS = 500;
  ```

---

### Recipe 2: Adjust Standalone Active & Rest Durations
In `noya_mcu_rtos.ino` (lines 124–125):
* For **30 seconds active / 2 minutes rest**:
  ```cpp
  static const uint32_t EYE_ACTIVE_DURATION_MS = 30000; // 30s active
  static const int DEFAULT_SEQ_REST_MS = 120000;        // 2 minutes rest
  ```

---

### Recipe 3: Change Eyes to Rest CLOSED Instead of OPEN
In `noya_mcu_rtos.ino` (line 784):
Change:
```cpp
int restTargetDeg = openDeg; // Eyelids rest OPEN
```
To:
```cpp
int restTargetDeg = closeDeg; // Eyelids rest CLOSED (sleeping monster)
```

---

### Recipe 4: Adjust Angles Using the Web Dashboard (No Reflash Needed)
1. Connect to Wi-Fi SSID `mcu-eye-monster` (password from `secrets.h`).
2. Open `http://192.168.10.1` in your browser.
3. Scroll down to **Sequence Settings**:
   - Change **Open Angle** (e.g. 20°) or **Close Angle** (e.g. 95°).
   - Change **Hold Duration** or **Rest Duration**.
4. Click **Apply** to test the movement in RAM immediately.
5. Click **Save to Device** to write the settings permanently into ESP32 NVS flash so they survive power loss.

---

## 5. Web Dashboards

* **Slave / Standalone Dashboard:** `http://mcu-eye-monster.local` or `http://192.168.10.1`
  - Manual servo sliders with live angle feedback.
  - Real-time relay indicators (green = energized, gray = power cut).
  - Mode toggle (Manual vs. Auto).
  - Emergency Pause button (instantly cuts power to both relays).
  - Over-The-Air (OTA) firmware update at `/update`.
* **Master Dashboard:** `http://mcu-master.local` or `http://192.168.10.1`
  - Timeline monitor with active step countdown.
  - Peer link health indicators (ACK verification for Plants 1 to 4).
  - Step jump buttons to test any choreography line immediately.
  - Master pause/resume.
