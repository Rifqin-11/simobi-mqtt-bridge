# SIMOBI MQTT Bridge

Worker kecil untuk meneruskan data GPS dari MQTT broker ke endpoint SIMOBI:

```text
ESP32 -> HiveMQ MQTT -> mqtt-bridge-service -> /api/gps-beacon
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
fly secrets set API_URL="https://undip-bus-tracking.vercel.app/api/gps-beacon"
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
MQTT_TOPIC=bus/gps/data
API_URL=https://your-simobi-web-production.up.railway.app/api/gps-beacon
BUGGY_ID=2
DEFAULT_ACCURACY=10
```

`API_URL` harus memakai URL publik aplikasi Next.js yang sudah deploy. Jangan isi `localhost`, karena di Railway `localhost` berarti container bridge itu sendiri, bukan laptop atau service Next.js lain.

## Payload MQTT

ESP32 publish JSON ke `MQTT_TOPIC`:

```json
{
  "lat": -7.060384,
  "lng": 110.436554,
  "speed": 0.61
}
```

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

## Jalankan Lokal

```bash
cd mqtt-bridge-service
MQTT_SERVER="mqtts://..." \
MQTT_USER="..." \
MQTT_PASS="..." \
MQTT_TOPIC="bus/gps/data" \
API_URL="http://localhost:3000/api/gps-beacon" \
npm start
```
