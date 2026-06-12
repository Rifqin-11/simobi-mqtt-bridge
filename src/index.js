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
const TOPIC = process.env.MQTT_TOPIC || "buggy/+/data";
const TOPICS = resolveMqttTopics(TOPIC);
const API_URL = readRequiredEnv("API_URL");
const BUGGY_INGEST_TOKEN = readRequiredEnv("BUGGY_INGEST_TOKEN");
const DEFAULT_ACCURACY = Number(process.env.DEFAULT_ACCURACY || 10);
const MOVING_SPEED_THRESHOLD_KMH = Number(process.env.MOVING_SPEED_THRESHOLD_KMH || 1);
const FORWARD_DISTANCE_THRESHOLD_METERS = Number(
  process.env.FORWARD_DISTANCE_THRESHOLD_METERS || 10,
);
const STATIONARY_HEARTBEAT_MS = Number(process.env.STATIONARY_HEARTBEAT_MS || 60000);
const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const lastForwardByDevice = new Map();

const status = {
  mqttConnected: false,
  subscribed: false,
  lastMessageAt: null,
  lastForwardAt: null,
  lastForwardStatus: null,
  lastSkippedAt: null,
  lastSkippedReason: null,
  lastError: null,
};

if (!Number.isFinite(PORT)) {
  console.error("PORT must be a number.");
  process.exit(1);
}

if (
  !Number.isFinite(MOVING_SPEED_THRESHOLD_KMH) ||
  MOVING_SPEED_THRESHOLD_KMH < 0
) {
  console.error("MOVING_SPEED_THRESHOLD_KMH must be a non-negative number.");
  process.exit(1);
}

if (
  !Number.isFinite(FORWARD_DISTANCE_THRESHOLD_METERS) ||
  FORWARD_DISTANCE_THRESHOLD_METERS < 0
) {
  console.error("FORWARD_DISTANCE_THRESHOLD_METERS must be a non-negative number.");
  process.exit(1);
}

if (!Number.isFinite(STATIONARY_HEARTBEAT_MS) || STATIONARY_HEARTBEAT_MS < 0) {
  console.error("STATIONARY_HEARTBEAT_MS must be a non-negative number.");
  process.exit(1);
}

function resolveMqttTopics(value) {
  const configuredTopics = value
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
  const topics = configuredTopics.length > 0 ? configuredTopics : ["buggy/+/data"];

  for (const topic of [...topics]) {
    const statusTopic = topic.replace(/\/data$/, "/status");
    if (statusTopic !== topic && !topics.includes(statusTopic)) {
      topics.push(statusTopic);
    }
  }

  return topics;
}

function inferDeviceIdFromTopic(topic) {
  const match = topic.match(/^(?:buggy|device|devices)\/([^/]+)\/(?:data|status)$/);
  if (!match) return null;

  return match[1];
}

function isStatusTopic(topic) {
  return /^(?:buggy|device|devices)\/[^/]+\/status$/.test(topic);
}

function readDevicesId(topic, data) {
  const rawDevicesId =
    data.devicesId ??
    data.deviceId ??
    data.buggyId ??
    inferDeviceIdFromTopic(topic) ??
    process.env.DEVICES_ID ??
    process.env.DEVICE_ID ??
    process.env.BUGGY_ID ??
    2;

  if (typeof rawDevicesId === "number" && Number.isFinite(rawDevicesId)) {
    return String(rawDevicesId);
  }

  if (typeof rawDevicesId === "string" && rawDevicesId.trim() !== "") {
    return rawDevicesId.trim();
  }

  return null;
}

function readOptionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readOptionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function hasValidGpsFix(data) {
  if (data.gpsValid === false) {
    return { valid: false, reason: "gpsValid=false" };
  }

  if (
    typeof data.lat !== "number" ||
    typeof data.lng !== "number" ||
    !Number.isFinite(data.lat) ||
    !Number.isFinite(data.lng)
  ) {
    return { valid: false, reason: "lat/lng is missing or not finite" };
  }

  if (data.lat < -90 || data.lat > 90 || data.lng < -180 || data.lng > 180) {
    return { valid: false, reason: "lat/lng is out of range" };
  }

  if (data.lat === 0 && data.lng === 0) {
    return { valid: false, reason: "lat/lng is 0,0" };
  }

  return { valid: true };
}

function haversineMeters(a, b) {
  const earthRadiusMeters = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

function shouldForwardPayload(devicesId, payload) {
  if (payload.forceResync === true) {
    return { forward: true, reason: "forceResync" };
  }

  const previous = lastForwardByDevice.get(devicesId);
  if (!previous) {
    return { forward: true, reason: "first GPS point" };
  }

  const now = Date.now();
  const elapsedMs = now - previous.forwardedAtMs;
  const distanceMeters = haversineMeters(
    { lat: previous.lat, lng: previous.lng },
    { lat: payload.lat, lng: payload.lng },
  );
  const speedKmh =
    typeof payload.speedKmh === "number" && Number.isFinite(payload.speedKmh)
      ? Math.max(0, payload.speedKmh)
      : 0;

  if (speedKmh >= MOVING_SPEED_THRESHOLD_KMH) {
    return {
      forward: true,
      reason: `moving speed ${speedKmh.toFixed(1)}km/h after ${elapsedMs}ms, ${distanceMeters.toFixed(1)}m`,
    };
  }

  if (distanceMeters >= FORWARD_DISTANCE_THRESHOLD_METERS) {
    return {
      forward: true,
      reason: `moved ${distanceMeters.toFixed(1)}m after ${elapsedMs}ms`,
    };
  }

  if (elapsedMs >= STATIONARY_HEARTBEAT_MS) {
    return {
      forward: true,
      stationaryHeartbeat: true,
      reason: `stationary heartbeat after ${elapsedMs}ms, ${distanceMeters.toFixed(1)}m`,
    };
  }

  return {
    forward: false,
    reason: `stationary throttled ${devicesId}: ${elapsedMs}ms, ${distanceMeters.toFixed(1)}m`,
  };
}

function readGsmTelemetry(data) {
  const source =
    data.gsm && typeof data.gsm === "object" && !Array.isArray(data.gsm)
      ? data.gsm
      : data;

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }

  const gsm = {
    apn: readOptionalString(source.apn),
    signalCsq: readOptionalNumber(source.signalCsq),
    signalDbm: readOptionalNumber(source.signalDbm),
    signalPercent: readOptionalNumber(source.signalPercent),
    simStatus: readOptionalNumber(source.simStatus),
    simStatusText: readOptionalString(source.simStatusText),
    networkConnected: readOptionalBoolean(source.networkConnected),
    gprsConnected: readOptionalBoolean(source.gprsConnected),
    localIp: readOptionalString(source.localIp),
    networkType: readOptionalString(source.networkType),
    mqttState: readOptionalNumber(source.mqttState),
    mqttStateText: readOptionalString(source.mqttStateText),
  };

  const entries = Object.entries(gsm).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const healthServer = http.createServer((req, res) => {
  const body = JSON.stringify({
    ok: true,
    service: "simobi-mqtt-bridge",
    topic: TOPIC,
    topics: TOPICS,
    apiUrl: API_URL,
    movingSpeedThresholdKmh: MOVING_SPEED_THRESHOLD_KMH,
    forwardDistanceThresholdMeters: FORWARD_DISTANCE_THRESHOLD_METERS,
    stationaryHeartbeatMs: STATIONARY_HEARTBEAT_MS,
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
  client.subscribe(TOPICS, (err) => {
    if (err) {
      status.subscribed = false;
      status.lastError = err.message;
      console.error("Failed to subscribe to topic:", err);
      return;
    }

    status.subscribed = true;
    console.log(`Subscribed to topics: ${TOPICS.join(", ")}`);
    console.log(`Forwarding MQTT GPS payloads to: ${API_URL}`);
  });
});

client.on("message", async (topic, message) => {
  try {
    const raw = message.toString();
    const data = JSON.parse(raw);
    status.lastMessageAt = new Date().toISOString();
    console.log("Received MQTT payload:", { topic, data });

    const devicesId = readDevicesId(topic, data);
    if (devicesId === null) {
      console.warn("Skipping payload because devicesId/deviceId is missing or invalid:", { topic, data });
      return;
    }

    const gsm = readGsmTelemetry(data);
    if (isStatusTopic(topic)) {
      if (!gsm) {
        console.warn("Skipping status payload because no valid GSM fields were found:", data);
        return;
      }

      const payload = {
        devicesId,
        statusOnly: true,
        source: "mqtt_status",
        gsm,
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
        console.error("Failed to forward status payload to SIMOBI API:", {
          status: res.status,
          response: responseText,
        });
        return;
      }

      status.lastForwardAt = new Date().toISOString();
      status.lastForwardStatus = res.status;
      status.lastError = null;
      console.log("Status payload forwarded to SIMOBI API.", responseText);
      return;
    }

    const gpsFix = hasValidGpsFix(data);
    if (!gpsFix.valid) {
      console.warn(`Skipping payload because GPS fix is invalid: ${gpsFix.reason}`, data);
      return;
    }

    const payload = {
      devicesId,
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
      gsm,
    };

    const forwardDecision = shouldForwardPayload(devicesId, payload);
    if (!forwardDecision.forward) {
      status.lastSkippedAt = new Date().toISOString();
      status.lastSkippedReason = forwardDecision.reason;
      console.log("Skipping MQTT GPS payload:", forwardDecision.reason);
      return;
    }
    if (forwardDecision.stationaryHeartbeat === true) {
      payload.stationaryHeartbeat = true;
    }

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
    status.lastSkippedReason = null;
    lastForwardByDevice.set(devicesId, {
      forwardedAtMs: Date.now(),
      lat: payload.lat,
      lng: payload.lng,
    });
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
