require("dotenv").config();

const http = require("http");
const mqtt = require("mqtt");

const REQUIRED_ENV = ["MQTT_SERVER", "MQTT_USER", "MQTT_PASS", "API_URL", "BUGGY_INGEST_TOKEN"];

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exitCode = 1;
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`Bridge cannot start. Missing env vars: ${missingEnv.join(", ")}`);
  console.error("Set them in Railway Variables, then redeploy the service.");
  process.exit(1);
}

const MQTT_SERVER = readRequiredEnv("MQTT_SERVER");
const MQTT_USER = readRequiredEnv("MQTT_USER");
const MQTT_PASS = readRequiredEnv("MQTT_PASS");
const TOPIC = process.env.MQTT_TOPIC || "bus/gps/data";
const API_URL = readRequiredEnv("API_URL");
const BUGGY_INGEST_TOKEN = readRequiredEnv("BUGGY_INGEST_TOKEN");
const DEFAULT_ACCURACY = Number(process.env.DEFAULT_ACCURACY || 10);
const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";

const status = {
  mqttConnected: false,
  subscribed: false,
  lastMessageAt: null,
  lastForwardAt: null,
  lastForwardStatus: null,
  lastError: null,
};

if (!Number.isFinite(PORT)) {
  console.error("PORT must be a number.");
  process.exit(1);
}

function inferBuggyIdFromTopic(topic) {
  const match = topic.match(/^buggy\/([^/]+)\/data$/);
  if (!match) return null;

  const buggyId = Number(match[1]);
  return Number.isFinite(buggyId) ? buggyId : null;
}

function readBuggyId(topic, data) {
  const buggyId = Number(data.buggyId ?? inferBuggyIdFromTopic(topic) ?? process.env.BUGGY_ID ?? 2);
  return Number.isFinite(buggyId) ? buggyId : null;
}

const healthServer = http.createServer((req, res) => {
  const body = JSON.stringify({
    ok: true,
    service: "simobi-mqtt-bridge",
    topic: TOPIC,
    apiUrl: API_URL,
    ...status,
  });

  res.writeHead(req.url === "/health" ? 200 : 200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
});

healthServer.listen(PORT, HOST, () => {
  console.log(`Health server listening on ${HOST}:${PORT}`);
});

healthServer.on("error", (err) => {
  console.error("Health server failed:", err);
  process.exit(1);
});

const client = mqtt.connect(MQTT_SERVER, {
  username: MQTT_USER,
  password: MQTT_PASS,
  clientId: `railway-mqtt-bridge-${Math.random().toString(16).slice(2, 8)}`,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
});

client.on("connect", () => {
  status.mqttConnected = true;
  status.lastError = null;
  console.log("Bridge connected to MQTT broker.");
  client.subscribe(TOPIC, (err) => {
    if (err) {
      status.subscribed = false;
      status.lastError = err.message;
      console.error("Failed to subscribe to topic:", err);
      return;
    }

    status.subscribed = true;
    console.log(`Subscribed to topic: ${TOPIC}`);
    console.log(`Forwarding MQTT GPS payloads to: ${API_URL}`);
  });
});

client.on("message", async (topic, message) => {
  try {
    const raw = message.toString();
    const data = JSON.parse(raw);
    status.lastMessageAt = new Date().toISOString();
    console.log("Received MQTT GPS payload:", { topic, data });

    if (typeof data.lat !== "number" || typeof data.lng !== "number") {
      console.warn("Skipping payload because lat/lng is missing or not a number:", data);
      return;
    }

    const buggyId = readBuggyId(topic, data);
    if (buggyId === null) {
      console.warn("Skipping payload because buggyId is missing or invalid:", { topic, data });
      return;
    }

    const payload = {
      buggyId,
      lat: data.lat,
      lng: data.lng,
      speedKmh: typeof data.speed === "number" ? data.speed : 0,
      accuracy:
        typeof data.accuracy === "number" ? data.accuracy : DEFAULT_ACCURACY,
      heading: typeof data.heading === "number" ? data.heading : undefined,
      altitude: typeof data.altitude === "number" ? data.altitude : undefined,
      batteryLevel:
        typeof data.batteryLevel === "number" ? data.batteryLevel : undefined,
      passengers: typeof data.passengers === "number" ? data.passengers : 0,
      forceResync: data.forceResync === true,
    };

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BUGGY_INGEST_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    if (!res.ok) {
      status.lastForwardStatus = res.status;
      status.lastError = responseText || `HTTP ${res.status}`;
      console.error("Failed to forward payload to SIMOBI API:", {
        status: res.status,
        response: responseText,
      });
      return;
    }

    status.lastForwardAt = new Date().toISOString();
    status.lastForwardStatus = res.status;
    status.lastError = null;
    console.log("Payload forwarded to SIMOBI API.", responseText);
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    console.error("Failed to process MQTT message:", err);
    console.error("API_URL:", API_URL);
  }
});

client.on("reconnect", () => {
  console.log("MQTT reconnecting...");
});

client.on("offline", () => {
  status.mqttConnected = false;
  console.warn("MQTT client is offline.");
});

client.on("close", () => {
  status.mqttConnected = false;
  status.subscribed = false;
  console.warn("MQTT connection closed.");
});

client.on("error", (err) => {
  status.lastError = err.message;
  console.error("MQTT error:", err);
});

function shutdown(signal) {
  console.log(`Received ${signal}, closing MQTT bridge...`);

  client.end(false, () => {
    healthServer.close(() => {
      console.log("MQTT bridge stopped.");
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.warn("Forced shutdown after timeout.");
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
