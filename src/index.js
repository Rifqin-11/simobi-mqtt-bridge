require("dotenv").config();

const mqtt = require("mqtt");

const REQUIRED_ENV = ["MQTT_SERVER", "MQTT_USER", "MQTT_PASS", "API_URL"];

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
const BUGGY_ID = Number(process.env.BUGGY_ID || 2);
const DEFAULT_ACCURACY = Number(process.env.DEFAULT_ACCURACY || 10);

if (!Number.isFinite(BUGGY_ID)) {
  console.error("BUGGY_ID must be a number.");
  process.exit(1);
}

const client = mqtt.connect(MQTT_SERVER, {
  username: MQTT_USER,
  password: MQTT_PASS,
  clientId: `railway-mqtt-bridge-${Math.random().toString(16).slice(2, 8)}`,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
});

client.on("connect", () => {
  console.log("Bridge connected to MQTT broker.");
  client.subscribe(TOPIC, (err) => {
    if (err) {
      console.error("Failed to subscribe to topic:", err);
      return;
    }

    console.log(`Subscribed to topic: ${TOPIC}`);
    console.log(`Forwarding MQTT GPS payloads to: ${API_URL}`);
  });
});

client.on("message", async (topic, message) => {
  try {
    const raw = message.toString();
    const data = JSON.parse(raw);
    console.log("Received MQTT GPS payload:", { topic, data });

    if (typeof data.lat !== "number" || typeof data.lng !== "number") {
      console.warn("Skipping payload because lat/lng is missing or not a number:", data);
      return;
    }

    const payload = {
      buggyId: BUGGY_ID,
      lat: data.lat,
      lng: data.lng,
      speedKmh: typeof data.speed === "number" ? data.speed : 0,
      accuracy: typeof data.accuracy === "number" ? data.accuracy : DEFAULT_ACCURACY,
      heading: typeof data.heading === "number" ? data.heading : undefined,
      altitude: typeof data.altitude === "number" ? data.altitude : undefined,
      batteryLevel: typeof data.batteryLevel === "number" ? data.batteryLevel : undefined,
      forceResync: data.forceResync === true,
    };

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    if (!res.ok) {
      console.error("Failed to forward payload to SIMOBI API:", {
        status: res.status,
        response: responseText,
      });
      return;
    }

    console.log("Payload forwarded to SIMOBI API.", responseText);
  } catch (err) {
    console.error("Failed to process MQTT message:", err);
    console.error("API_URL:", API_URL);
  }
});

client.on("reconnect", () => {
  console.log("MQTT reconnecting...");
});

client.on("offline", () => {
  console.warn("MQTT client is offline.");
});

client.on("close", () => {
  console.warn("MQTT connection closed.");
});

client.on("error", (err) => {
  console.error("MQTT error:", err);
});
