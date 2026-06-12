# SIMOBI MQTT Bridge

Worker kecil untuk meneruskan data GPS dari MQTT broker ke endpoint SIMOBI:

```text
ESP32 -> MQTT Broker -> mqtt-bridge-service -> /api/gps-beacon
```

## Deploy Ke Fly.io

Service ini adalah MQTT worker yang juga membuka health endpoint HTTP untuk Fly:

```text
GET /health
```

Konfigurasi Fly ada di `fly.toml` dan sengaja memakai:

```text
auto_stop_machines = false
min_machines_running = 1
```

Ini penting karena MQTT bridge harus selalu hidup. Jika auto-stop aktif, Fly bisa menghentikan Machine saat tidak ada traffic HTTP walaupun koneksi MQTT masih dibutuhkan.

Set secrets di Fly:

```bash
fly secrets set MQTT_SERVER="mqtts://db7ded41366b4e9e863e255883a077fd.s1.eu.hivemq.cloud:8883"
fly secrets set MQTT_USER="ESP32GPSBV1"
fly secrets set MQTT_PASS="..."
fly secrets set API_URL="https://vps.simobi.my.id/api/gps-beacon"
fly secrets set BUGGY_INGEST_TOKEN="your-secret-token"
```

Deploy:

```bash
cd mqtt-bridge-service
fly deploy
```

## Deploy Ke Railway

1. Buat service baru di Railway dari repo ini.
2. Set **Root Directory** ke:

```text
mqtt-bridge-service
```

3. Railway akan menjalankan:

```bash
npm install
npm start
```

4. Tambahkan variables berikut di Railway:

```text
MQTT_SERVER=mqtts://your-hivemq-host:8883
MQTT_USER=your-mqtt-username
MQTT_PASS=your-mqtt-password
MQTT_TOPIC=buggy/+/data
API_URL=https://vps.simobi.my.id/api/gps-beacon
BUGGY_INGEST_TOKEN=your-secret-token
DEVICES_ID=ESP-DEFAULT
DEFAULT_ACCURACY=10
MOVING_SPEED_THRESHOLD_KMH=1
FORWARD_DISTANCE_THRESHOLD_METERS=10
STATIONARY_HEARTBEAT_MS=60000
```

`API_URL` harus memakai URL publik aplikasi Next.js yang sudah deploy. Jangan isi `localhost`, karena di Railway `localhost` berarti container bridge itu sendiri, bukan laptop atau service Next.js lain.

Jika `MQTT_TOPIC` diisi `buggy/+/data`, bridge otomatis ikut subscribe
ke topic status pasangannya, yaitu `buggy/+/status`.

Throttle GPS production:

- Jika buggy bergerak setidaknya `FORWARD_DISTANCE_THRESHOLD_METERS`, payload GPS langsung diteruskan ke SIMOBI. Mode ini cocok untuk deployment VPS + SSE karena web dapat menerima update secara event-driven.
- Jika payload membawa speed minimal `MOVING_SPEED_THRESHOLD_KMH`, payload juga langsung diteruskan walaupun jarak dari titik terakhir belum melewati threshold. Ini membuat marker tetap responsif saat buggy bergerak pelan.
- Jika buggy diam atau hanya bergeser kecil di bawah threshold, payload GPS hanya diteruskan sebagai heartbeat setiap `STATIONARY_HEARTBEAT_MS`.
- Heartbeat diam dikirim dengan `stationaryHeartbeat=true` agar backend memperbarui live telemetry tanpa menambah titik raw history atau path sesi.
- Jika `forceResync=true`, payload tetap diteruskan tanpa menunggu throttle.
- Payload dengan GPS invalid seperti `gpsValid=false`, koordinat di luar range, atau `0,0` akan diskip sebelum masuk logika jarak.

Dengan aturan ini, buggy yang tiba-tiba bergerak tidak perlu menunggu heartbeat diam, tetapi buggy yang berhenti lama tidak terus-menerus membebani endpoint SIMOBI.

## Payload MQTT

ESP32 publish JSON posisi ke topic `buggy/<devicesId>/data`, misalnya `buggy/ESP-1234ABCD/data`:

```json
{
  "deviceId": "ESP-1234ABCD",
  "lat": -7.060384,
  "lng": 110.436554,
  "speed": 0.61,
  "sat": 8,
  "accuracy": 1.2,
  "passengers": 12,
  "gpsValid": true
}
```

Bridge menerima field ID berikut:

```text
devicesId -> deviceId -> buggyId -> DEVICES_ID -> DEVICE_ID -> BUGGY_ID
```

Payload yang diteruskan ke API memakai field `devicesId`. Jika ID tidak ada di payload, bridge bisa mengambil ID dari topic `buggy/<devicesId>/data`.

Field opsional yang juga akan diteruskan:

```json
{
  "accuracy": 10,
  "heading": 180,
  "altitude": 20,
  "batteryLevel": 90,
  "forceResync": true
}
```

Payload posisi juga masih boleh membawa data status GSM dari ESP32:

```json
{
  "lat": -7.060384,
  "lng": 110.436554,
  "speed": 0.61,
  "gsm": {
    "apn": "internet",
    "signalCsq": 28,
    "signalDbm": -57,
    "signalPercent": 90,
    "simStatus": 1,
    "simStatusText": "SIM_READY",
    "networkConnected": true,
    "gprsConnected": true,
    "localIp": "10.16.103.147",
    "networkType": "GSM_GPRS_2G",
    "mqttState": 0,
    "mqttStateText": "MQTT_CONNECTED"
  }
}
```

Bridge akan meneruskan objek `gsm` ke API hanya jika field-nya valid.

Untuk mengurangi ukuran payload posisi, ESP32 dapat memisahkan status berat ke
topic `buggy/<devicesId>/status` setiap beberapa detik, misalnya 15 detik:

```json
{
  "gsm": {
    "apn": "internet",
    "signalCsq": 28,
    "signalDbm": -57,
    "signalPercent": 90,
    "simStatus": 1,
    "simStatusText": "SIM_READY",
    "networkConnected": true,
    "gprsConnected": true,
    "localIp": "10.16.103.147",
    "networkType": "GSM_GPRS_2G",
    "mqttState": 0,
    "mqttStateText": "MQTT_CONNECTED"
  }
}
```

Bridge meneruskan status tersebut sebagai `statusOnly` ke `/api/gps-beacon`.
Backend hanya memperbarui GSM/latest telemetry, tanpa memasukkan row ke
`buggy_history` dan tanpa membuat titik session.

## Jalankan Lokal

```bash
cd mqtt-bridge-service
MQTT_SERVER="mqtts://..." \
MQTT_USER="..." \
MQTT_PASS="..." \
MQTT_TOPIC="buggy/+/data" \
API_URL="http://localhost:3000/api/gps-beacon" \
BUGGY_INGEST_TOKEN="your-secret-token" \
npm start
```
