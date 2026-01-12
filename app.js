const trainerStatus = document.getElementById("trainer-status");
const trainerControlStatus = document.getElementById("trainer-control-status");
const connectTrainerBtn = document.getElementById("connect-trainer");
const disconnectTrainerBtn = document.getElementById("disconnect-trainer");
const connectZwiftBtn = document.getElementById("connect-zwift");
const disconnectZwiftBtn = document.getElementById("disconnect-zwift");
const zwiftStatus = document.getElementById("zwift-status");
const zwiftCharStatus = document.getElementById("zwift-char");
const powerEl = document.getElementById("power");
const cadenceEl = document.getElementById("cadence");
const speedEl = document.getElementById("speed");
const gradeDisplay = document.getElementById("grade-display");
const distanceDisplay = document.getElementById("distance-display");
const autoResistanceToggle = document.getElementById("auto-resistance");
const baseResistanceInput = document.getElementById("base-resistance");
const gradeFactorInput = document.getElementById("grade-factor");
const eventLog = document.getElementById("event-log");
const gearDisplay = document.getElementById("gear-display");
const loopStatus = document.getElementById("loop-status");
const reloadRouteBtn = document.getElementById("reload-route");
const connectDiagnosticBtn = document.getElementById("connect-diagnostic");
const disconnectDiagnosticBtn = document.getElementById("disconnect-diagnostic");
const diagnosticDevicesEl = document.getElementById("diagnostic-devices");
const diagnosticServicesInput = document.getElementById("diagnostic-services");

const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const INDOOR_BIKE_DATA = "00002ad2-0000-1000-8000-00805f9b34fb";
const CONTROL_POINT = "00002ad9-0000-1000-8000-00805f9b34fb";
const SUPPORTED_RESISTANCE_RANGE = "00002ad6-0000-1000-8000-00805f9b34fb";
const FITNESS_MACHINE_STATUS = "00002ada-0000-1000-8000-00805f9b34fb";

let trainerDevice = null;
let trainerServer = null;
let controlPointChar = null;
let bikeDataChar = null;
let resistanceRange = { min: 0, max: 100 };
let telemetry = { power: null, cadence: null, speed: null };

let zwiftDevice = null;
let zwiftServer = null;
let zwiftNotifyChar = null;
let gear = 0;

let routeData = [];
let routeDistances = [];
let routeGrades = [];
let totalRouteDistance = 0;
let currentDistance = 0;
let lastLoopAt = null;
let autoLoopTimer = null;
let lastResistanceSet = null;

const diagnostics = new Map();

const map = new ol.Map({
  target: "map",
  layers: [
    new ol.layer.Tile({
      source: new ol.source.OSM(),
    }),
  ],
  view: new ol.View({
    center: ol.proj.fromLonLat([-122.483695, 37.833027]),
    zoom: 14,
  }),
});

const routeLayer = new ol.layer.Vector({
  source: new ol.source.Vector(),
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#2563eb", width: 4 }),
  }),
});
map.addLayer(routeLayer);

const positionLayer = new ol.layer.Vector({
  source: new ol.source.Vector(),
  style: new ol.style.Style({
    image: new ol.style.Circle({
      radius: 6,
      fill: new ol.style.Fill({ color: "#f97316" }),
      stroke: new ol.style.Stroke({ color: "#fff", width: 2 }),
    }),
  }),
});
map.addLayer(positionLayer);

function logEvent(message) {
  const entry = document.createElement("div");
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] ${message}`;
  eventLog.prepend(entry);
}

function formatBytes(value) {
  if (!value) {
    return "--";
  }
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function formatAscii(value) {
  if (!value) {
    return "--";
  }
  const ascii = Array.from(value)
    .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."))
    .join("");
  return ascii || "--";
}

function updateTelemetryUI() {
  powerEl.textContent = telemetry.power == null ? "-- W" : `${telemetry.power} W`;
  cadenceEl.textContent =
    telemetry.cadence == null ? "-- rpm" : `${telemetry.cadence} rpm`;
  speedEl.textContent =
    telemetry.speed == null ? "-- km/h" : `${telemetry.speed.toFixed(1)} km/h`;
}

function setTrainerStatus(text, connected) {
  trainerStatus.textContent = text;
  trainerStatus.dataset.connected = connected ? "true" : "false";
}

function setZwiftStatus(text, connected) {
  zwiftStatus.textContent = text;
  zwiftStatus.dataset.connected = connected ? "true" : "false";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function metersBetween([lon1, lat1], [lon2, lat2]) {
  const radius = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radius * c;
}

function buildRouteMetrics(coords) {
  routeDistances = [0];
  routeGrades = [];
  totalRouteDistance = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const segmentDistance = metersBetween(prev, curr);
    totalRouteDistance += segmentDistance;
    routeDistances.push(totalRouteDistance);

    const elevPrev = prev[2] || 0;
    const elevCurr = curr[2] || 0;
    const grade = segmentDistance > 0 ? ((elevCurr - elevPrev) / segmentDistance) * 100 : 0;
    routeGrades.push(grade);
  }
}

function getGradeAtDistance(distanceMeters) {
  if (routeDistances.length === 0) {
    return 0;
  }
  for (let i = 1; i < routeDistances.length; i += 1) {
    if (distanceMeters <= routeDistances[i]) {
      return routeGrades[i - 1] || 0;
    }
  }
  return routeGrades[routeGrades.length - 1] || 0;
}

function updatePositionMarker(distanceMeters) {
  if (routeData.length === 0) {
    return;
  }
  let targetIndex = routeDistances.findIndex((d) => d >= distanceMeters);
  if (targetIndex === -1) {
    targetIndex = routeData.length - 1;
  }
  const coord = routeData[targetIndex];
  positionLayer.getSource().clear();
  const feature = new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat([coord[0], coord[1]])),
  });
  positionLayer.getSource().addFeature(feature);
}

async function loadRoute() {
  const response = await fetch("sample-route.geojson");
  const geojson = await response.json();
  const feature = geojson.features[0];
  routeData = feature.geometry.coordinates;
  buildRouteMetrics(routeData);
  const vectorSource = new ol.source.Vector({
    features: new ol.format.GeoJSON().readFeatures(feature, {
      featureProjection: map.getView().getProjection(),
    }),
  });
  routeLayer.setSource(vectorSource);
  map.getView().fit(vectorSource.getExtent(), { padding: [40, 40, 40, 40] });
  currentDistance = 0;
  updatePositionMarker(0);
  gradeDisplay.textContent = "0.0%";
  distanceDisplay.textContent = "0.00 km";
}

function parseIndoorBikeData(dataView) {
  let offset = 0;
  const flags = dataView.getUint16(offset, true);
  offset += 2;

  let speed;
  if (flags & 0x0001) {
    speed = dataView.getUint16(offset, true) / 100;
    offset += 2;
  }

  if (flags & 0x0002) {
    offset += 2;
  }

  if (flags & 0x0004) {
    const cadenceRaw = dataView.getUint16(offset, true);
    telemetry.cadence = cadenceRaw / 2;
    offset += 2;
  }

  if (flags & 0x0008) {
    offset += 2;
  }

  if (flags & 0x0010) {
    offset += 2;
  }

  if (flags & 0x0020) {
    const power = dataView.getInt16(offset, true);
    telemetry.power = power;
    offset += 2;
  }

  if (speed != null) {
    telemetry.speed = speed;
  }

  updateTelemetryUI();
}

function parseServicesInput(rawValue) {
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (/^[0-9a-fA-F-]{4,}$/.test(entry)) {
        return entry.toLowerCase();
      }
      return entry.toLowerCase().replace(/\s+/g, "_");
    });
}

async function connectTrainer() {
  try {
    trainerDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [FTMS_SERVICE],
    });
  } catch (error) {
    logEvent(`Trainer selection cancelled: ${error.message}`);
    return;
  }

  trainerDevice.addEventListener("gattserverdisconnected", () => {
    setTrainerStatus("Disconnected", false);
    trainerControlStatus.textContent = "Unavailable";
    disconnectTrainerBtn.disabled = true;
    connectTrainerBtn.disabled = false;
    stopAutoLoop();
  });

  trainerServer = await trainerDevice.gatt.connect();
  const ftms = await trainerServer.getPrimaryService(FTMS_SERVICE);

  try {
    bikeDataChar = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
    await bikeDataChar.startNotifications();
    bikeDataChar.addEventListener("characteristicvaluechanged", (event) => {
      parseIndoorBikeData(event.target.value);
    });
  } catch (error) {
    logEvent(`Indoor bike data unavailable: ${error.message}`);
  }

  try {
    controlPointChar = await ftms.getCharacteristic(CONTROL_POINT);
    trainerControlStatus.textContent = "Ready";
  } catch (error) {
    trainerControlStatus.textContent = "Unsupported";
    controlPointChar = null;
    logEvent(`Control point not available: ${error.message}`);
  }

  try {
    const resistanceChar = await ftms.getCharacteristic(SUPPORTED_RESISTANCE_RANGE);
    const rangeValue = await resistanceChar.readValue();
    resistanceRange = {
      min: rangeValue.getInt16(0, true),
      max: rangeValue.getInt16(2, true),
    };
  } catch (error) {
    resistanceRange = { min: 0, max: 100 };
  }

  try {
    const statusChar = await ftms.getCharacteristic(FITNESS_MACHINE_STATUS);
    await statusChar.startNotifications();
    statusChar.addEventListener("characteristicvaluechanged", () => {
      logEvent("Trainer status updated.");
    });
  } catch (error) {
    logEvent(`Trainer status notifications unavailable: ${error.message}`);
  }

  setTrainerStatus("Connected", true);
  connectTrainerBtn.disabled = true;
  disconnectTrainerBtn.disabled = false;
  logEvent(`Trainer connected: ${trainerDevice.name || "Unknown"}`);
}

async function disconnectTrainer() {
  if (trainerDevice?.gatt?.connected) {
    trainerDevice.gatt.disconnect();
  }
  trainerDevice = null;
  trainerServer = null;
  controlPointChar = null;
  bikeDataChar = null;
  stopAutoLoop();
  setTrainerStatus("Disconnected", false);
  connectTrainerBtn.disabled = false;
  disconnectTrainerBtn.disabled = true;
}

async function sendResistanceCommand(resistance) {
  if (!controlPointChar) {
    return;
  }
  const opCode = 0x04; // Set Target Resistance Level
  const value = new DataView(new ArrayBuffer(3));
  value.setUint8(0, opCode);
  value.setInt16(1, resistance, true);
  try {
    await controlPointChar.writeValue(value);
    logEvent(`Resistance set to ${resistance}.`);
  } catch (error) {
    logEvent(`Resistance write failed: ${error.message}`);
  }
}

function computeTargetResistance(grade) {
  const base = Number(baseResistanceInput.value || 0);
  const factor = Number(gradeFactorInput.value || 0);
  const raw = Math.round(base + grade * factor);
  return clamp(raw, resistanceRange.min, resistanceRange.max);
}

function startAutoLoop() {
  if (autoLoopTimer) {
    return;
  }
  loopStatus.textContent = "Running";
  lastLoopAt = performance.now();
  autoLoopTimer = setInterval(async () => {
    if (!autoResistanceToggle.checked) {
      return;
    }
    const now = performance.now();
    const elapsedSec = (now - lastLoopAt) / 1000;
    lastLoopAt = now;

    if (telemetry.speed != null) {
      currentDistance += (telemetry.speed / 3.6) * elapsedSec;
    }
    if (currentDistance > totalRouteDistance) {
      currentDistance = totalRouteDistance;
    }

    const grade = getGradeAtDistance(currentDistance);
    const target = computeTargetResistance(grade);

    gradeDisplay.textContent = `${grade.toFixed(1)}%`;
    distanceDisplay.textContent = `${(currentDistance / 1000).toFixed(2)} km`;
    updatePositionMarker(currentDistance);

    if (lastResistanceSet == null || Math.abs(target - lastResistanceSet) >= 1) {
      await sendResistanceCommand(target);
      lastResistanceSet = target;
    }
  }, 1000);
}

function stopAutoLoop() {
  if (autoLoopTimer) {
    clearInterval(autoLoopTimer);
    autoLoopTimer = null;
  }
  loopStatus.textContent = "Stopped";
}

async function connectZwiftPlay() {
  try {
    zwiftDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ["device_information", "battery_service"],
    });
  } catch (error) {
    logEvent(`Zwift Play selection cancelled: ${error.message}`);
    return;
  }

  zwiftDevice.addEventListener("gattserverdisconnected", () => {
    setZwiftStatus("Disconnected", false);
    zwiftCharStatus.textContent = "Not selected";
    disconnectZwiftBtn.disabled = true;
    connectZwiftBtn.disabled = false;
  });

  zwiftServer = await zwiftDevice.gatt.connect();
  setZwiftStatus("Connected", true);
  connectZwiftBtn.disabled = true;
  disconnectZwiftBtn.disabled = false;
  logEvent(`Zwift Play connected: ${zwiftDevice.name || "Unknown"}`);

  const services = await zwiftServer.getPrimaryServices();
  let notifyCharacteristic = null;
  for (const service of services) {
    const characteristics = await service.getCharacteristics();
    for (const characteristic of characteristics) {
      if (characteristic.properties.notify) {
        notifyCharacteristic = characteristic;
        break;
      }
    }
    if (notifyCharacteristic) {
      break;
    }
  }

  if (!notifyCharacteristic) {
    zwiftCharStatus.textContent = "No notify char found";
    logEvent("No notify characteristic found. Use DevTools to inspect services.");
    return;
  }

  zwiftNotifyChar = notifyCharacteristic;
  zwiftCharStatus.textContent = notifyCharacteristic.uuid;
  await zwiftNotifyChar.startNotifications();
  zwiftNotifyChar.addEventListener("characteristicvaluechanged", (event) => {
    parseZwiftNotification(event.target.value);
  });
}

function parseZwiftNotification(dataView) {
  const bytes = new Uint8Array(dataView.buffer);
  const payload = Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join(" ");
  logEvent(`Zwift raw: ${payload}`);

  if (bytes.length === 0) {
    return;
  }
  const code = bytes[0];
  switch (code) {
    case 0x01:
      logEvent("Button: left");
      break;
    case 0x02:
      logEvent("Button: right");
      break;
    case 0x03:
      gear += 1;
      gearDisplay.textContent = `${gear}`;
      logEvent("Button: gear up");
      break;
    case 0x04:
      gear -= 1;
      gearDisplay.textContent = `${gear}`;
      logEvent("Button: gear down");
      break;
    default:
      logEvent(`Button code ${code} received`);
  }
}

function createDataCard(title) {
  const card = document.createElement("div");
  card.className = "data-card";
  const label = document.createElement("strong");
  label.textContent = title;
  const value = document.createElement("span");
  value.textContent = "--";
  card.append(label, value);
  return { card, value };
}

function updateDeviceButtons(state) {
  const entries = Array.from(state.buttons.values());
  entries.sort((a, b) => a.label.localeCompare(b.label));
  state.buttonsEl.innerHTML = "";
  if (entries.length === 0) {
    const pill = document.createElement("div");
    pill.className = "button-pill";
    pill.textContent = "No button events yet";
    state.buttonsEl.appendChild(pill);
    return;
  }
  entries.forEach((entry) => {
    const pill = document.createElement("div");
    pill.className = "button-pill";
    pill.textContent = `${entry.label}: ${entry.count}`;
    state.buttonsEl.appendChild(pill);
  });
}

function registerButtonEvent(state, characteristic, payload) {
  const label = `${characteristic.uuid.slice(0, 8)} • ${payload}`;
  const existing = state.buttons.get(label) || { label, count: 0 };
  existing.count += 1;
  state.buttons.set(label, existing);
  updateDeviceButtons(state);
}

function updateDataCard(state, characteristic, payload) {
  const key = characteristic.uuid;
  let cardEntry = state.dataCards.get(key);
  if (!cardEntry) {
    cardEntry = createDataCard(`Char ${characteristic.uuid}`);
    state.dataCards.set(key, cardEntry);
    state.dataGrid.appendChild(cardEntry.card);
  }
  cardEntry.value.textContent = payload;
}

async function attachCharacteristic(state, characteristic) {
  const properties = [];
  if (characteristic.properties.read) {
    properties.push("read");
  }
  if (characteristic.properties.notify) {
    properties.push("notify");
  }
  if (characteristic.properties.indicate) {
    properties.push("indicate");
  }

  if (characteristic.properties.read) {
    try {
      const value = await characteristic.readValue();
      const bytes = new Uint8Array(value.buffer);
      updateDataCard(state, characteristic, formatBytes(bytes));
    } catch (error) {
      updateDataCard(state, characteristic, `Read error: ${error.message}`);
    }
  }

  if (characteristic.properties.notify || characteristic.properties.indicate) {
    try {
      await characteristic.startNotifications();
      characteristic.addEventListener("characteristicvaluechanged", (event) => {
        const value = new Uint8Array(event.target.value.buffer);
        const hex = formatBytes(value);
        const ascii = formatAscii(value);
        const combined = `${hex} | ${ascii}`;
        updateDataCard(state, characteristic, combined);
        registerButtonEvent(state, characteristic, hex);
      });
      state.activeNotifications.push(characteristic);
    } catch (error) {
      updateDataCard(state, characteristic, `Notify error: ${error.message}`);
    }
  }
}

async function discoverDeviceDetails(state) {
  state.status.textContent = "Discovering services...";
  const services = await state.server.getPrimaryServices();
  for (const service of services) {
    const characteristics = await service.getCharacteristics();
    for (const characteristic of characteristics) {
      await attachCharacteristic(state, characteristic);
    }
  }
  state.status.textContent = "Listening";
}

function createDiagnosticsCard(state) {
  const card = document.createElement("div");
  card.className = "diagnostic-card";

  const header = document.createElement("div");
  header.className = "diagnostic-header";

  const title = document.createElement("strong");
  title.textContent = state.device.name || "Unknown device";

  const status = document.createElement("span");
  status.className = "status";
  status.textContent = "Connected";

  const meta = document.createElement("div");
  meta.className = "diagnostic-meta";
  const idLine = document.createElement("div");
  idLine.textContent = `ID: ${state.device.id}`;
  const servicesLine = document.createElement("div");
  servicesLine.textContent = `Services: ${state.requestedServices.length || "All"}`;
  meta.append(idLine, servicesLine);

  header.append(title, status);

  const actions = document.createElement("div");
  actions.className = "diagnostic-actions";
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "Refresh data";
  const rereadBtn = document.createElement("button");
  rereadBtn.textContent = "Re-read characteristics";
  rereadBtn.className = "secondary";
  const disconnectBtn = document.createElement("button");
  disconnectBtn.textContent = "Disconnect";
  disconnectBtn.className = "warn";
  actions.append(refreshBtn, rereadBtn, disconnectBtn);

  const buttonSection = document.createElement("div");
  const buttonTitle = document.createElement("strong");
  buttonTitle.textContent = "Button/notify activity";
  const buttonsEl = document.createElement("div");
  buttonsEl.className = "button-grid";
  buttonSection.append(buttonTitle, buttonsEl);

  const dataSection = document.createElement("div");
  const dataTitle = document.createElement("strong");
  dataTitle.textContent = "Characteristic data";
  const dataGrid = document.createElement("div");
  dataGrid.className = "data-grid";
  dataSection.append(dataTitle, dataGrid);

  card.append(header, meta, actions, buttonSection, dataSection);

  refreshBtn.addEventListener("click", () => {
    state.dataCards.forEach((entry) => {
      entry.value.textContent = "--";
    });
  });

  rereadBtn.addEventListener("click", async () => {
    state.dataCards.forEach((entry) => {
      entry.value.textContent = "Refreshing...";
    });
    state.buttons.clear();
    updateDeviceButtons(state);
    await discoverDeviceDetails(state);
  });

  disconnectBtn.addEventListener("click", () => {
    if (state.device?.gatt?.connected) {
      state.device.gatt.disconnect();
    }
  });

  state.status = status;
  state.buttonsEl = buttonsEl;
  state.dataGrid = dataGrid;
  state.card = card;
  state.meta = meta;
  state.refreshBtn = refreshBtn;
  state.disconnectBtn = disconnectBtn;
  state.rereadBtn = rereadBtn;
  updateDeviceButtons(state);

  return card;
}

async function connectDiagnosticDevice() {
  let device;
  const requestedServices = parseServicesInput(diagnosticServicesInput.value);
  const options = { acceptAllDevices: true };
  if (requestedServices.length) {
    options.optionalServices = requestedServices;
  }

  try {
    device = await navigator.bluetooth.requestDevice(options);
  } catch (error) {
    logEvent(`Diagnostic selection cancelled: ${error.message}`);
    return;
  }

  if (!device) {
    return;
  }

  const server = await device.gatt.connect();
  const state = {
    device,
    server,
    requestedServices,
    dataCards: new Map(),
    buttons: new Map(),
    activeNotifications: [],
    status: null,
    buttonsEl: null,
    dataGrid: null,
    card: null,
    meta: null,
    refreshBtn: null,
    disconnectBtn: null,
    rereadBtn: null,
  };

  diagnostics.set(device.id, state);
  const card = createDiagnosticsCard(state);
  diagnosticDevicesEl.prepend(card);
  disconnectDiagnosticBtn.disabled = false;

  device.addEventListener("gattserverdisconnected", () => {
    state.status.textContent = "Disconnected";
    state.status.dataset.connected = "false";
    logEvent(`Diagnostic device disconnected: ${device.name || device.id}`);
    diagnostics.delete(device.id);
    if (diagnostics.size === 0) {
      disconnectDiagnosticBtn.disabled = true;
    }
  });

  logEvent(`Diagnostic connected: ${device.name || "Unknown"}`);
  await discoverDeviceDetails(state);
}

async function disconnectAllDiagnostics() {
  diagnostics.forEach((state) => {
    if (state.device?.gatt?.connected) {
      state.device.gatt.disconnect();
    }
  });
  diagnostics.clear();
  diagnosticDevicesEl.innerHTML = "";
  disconnectDiagnosticBtn.disabled = true;
}

async function disconnectZwiftPlay() {
  if (zwiftDevice?.gatt?.connected) {
    zwiftDevice.gatt.disconnect();
  }
  zwiftDevice = null;
  zwiftServer = null;
  zwiftNotifyChar = null;
  setZwiftStatus("Disconnected", false);
  connectZwiftBtn.disabled = false;
  disconnectZwiftBtn.disabled = true;
}

connectTrainerBtn.addEventListener("click", connectTrainer);
disconnectTrainerBtn.addEventListener("click", disconnectTrainer);
connectZwiftBtn.addEventListener("click", connectZwiftPlay);
disconnectZwiftBtn.addEventListener("click", disconnectZwiftPlay);
autoResistanceToggle.addEventListener("change", () => {
  if (autoResistanceToggle.checked) {
    startAutoLoop();
  } else {
    stopAutoLoop();
  }
});

reloadRouteBtn.addEventListener("click", loadRoute);
connectDiagnosticBtn.addEventListener("click", connectDiagnosticDevice);
disconnectDiagnosticBtn.addEventListener("click", disconnectAllDiagnostics);

loadRoute();
updateTelemetryUI();
