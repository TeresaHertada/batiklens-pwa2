import {
  FilesetResolver,
  ImageClassifier,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm";

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

const APP_VERSION = "batiklens-pwa2-fullframe-margin-v1";
console.info("BatikLens Padmanaba app version:", APP_VERSION);

const $ = (id) => document.getElementById(id);
const els = {
  video: $("video"),
  canvas: $("workCanvas"),
  startCamera: $("startCameraButton"),
  scan: $("scanButton"),
  auto: $("autoButton"),
  photoInput: $("photoInput"),
  install: $("installButton"),
  statusDot: $("statusDot"),
  statusTitle: $("statusTitle"),
  statusDetail: $("statusDetail"),
  resultCard: $("resultCard"),
  resultName: $("resultName"),
  resultConfidence: $("resultConfidence"),
  resultMessage: $("resultMessage"),
  latency: $("latencyValue"),
  delegate: $("delegateValue"),
  educationPanel: $("educationPanel"),
  origin: $("originValue"),
  meaning: $("meaningValue"),
  history: $("historyValue"),
  source: $("sourceValue"),
  topPredictions: $("topPredictions"),
  trueLabel: $("trueLabel"),
  lighting: $("lighting"),
  angle: $("angle"),
  distance: $("distance"),
  medium: $("medium"),
  downloadLog: $("downloadLogButton"),
  clearLog: $("clearLogButton"),
  logCount: $("logCount"),
};

let config;
let metadataMap = new Map();
let classifier;
let delegateName = "—";
let mediaStream;
let classifierReady = false;
let cameraReady = false;
let autoScanning = false;
let inferenceBusy = false;
let lastAutoRun = 0;
let smoothingBuffer = [];
let deferredInstallPrompt = null;
let scanLog = loadLog();

function setStatus(type, title, detail) {
  els.statusDot.className = `status-dot ${type}`;
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;
}

function displayName(label) {
  return metadataMap.get(label)?.display_name || label.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Gagal membaca ${path}: HTTP ${response.status}`);
  return response.json();
}

async function initialize() {
  try {
    setStatus("loading", "Menyiapkan model…", "Memuat konfigurasi dan mesin inferensi MediaPipe.");
    const [loadedConfig, list] = await Promise.all([
      loadJson("./data/config.json"),
      loadJson("./data/batik_metadata.json"),
    ]);
    config = loadedConfig;
    metadataMap = new Map(list.map((item) => [item.label, item]));
    populateTrueLabels();

    const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);

    // Gunakan CPU/WASM secara sengaja.
    // Model BatikLens memiliki wrapper uint8 -> float32; pada sebagian Android,
    // MediaPipe GPU/WebGL gagal mengonversi graph TFLite pada saat inferensi.
    classifier = await ImageClassifier.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: config.modelPath,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      maxResults: config.labels.length,
      scoreThreshold: 0.0,
    });
    delegateName = "CPU/WASM";

    classifierReady = true;
    els.delegate.textContent = delegateName;
    setStatus("ready", "Model siap", `Klasifikasi berjalan di perangkat dengan ${delegateName}.`);
    updateControlState();
    updateLogCount();
  } catch (error) {
    console.error(error);
    setStatus("error", "Model gagal dimuat", `${error.message}. Pastikan file models/batiklens_web_uint8.tflite tersedia.`);
  }
}

function populateTrueLabels() {
  for (const label of config.labels) {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = displayName(label);
    els.trueLabel.appendChild(option);
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Browser tidak menyediakan akses kamera. Gunakan Chrome melalui alamat HTTPS.");
  }

  setStatus("loading", "Membuka kamera…", "Berikan izin kamera apabila diminta.");
  stopCamera();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });

  els.video.srcObject = mediaStream;

  // Tunggu metadata video agar ukuran frame tersedia pada Android/PWA.
  if (els.video.readyState < 1) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Kamera terdeteksi, tetapi preview tidak siap.")),
        10000,
      );
      els.video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  await els.video.play();

  cameraReady = true;
  autoScanning = true;
  smoothingBuffer = [];

  setStatus(
    "ready",
    "Kamera aktif — pemindaian otomatis berjalan",
    "Arahkan satu motif dominan ke kotak. Hasil akan muncul setelah beberapa frame.",
  );
  updateControlState();

  // Jalankan prediksi pertama tanpa menunggu interval auto-scan.
  window.setTimeout(() => {
    if (cameraReady && classifierReady) {
      classifySource(els.video, {
        resetSmoothing: true,
        sourceType: "camera_initial",
      });
    }
  }, 350);
}

function stopCamera() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
  }
  mediaStream = null;
  cameraReady = false;
  autoScanning = false;
  updateControlState();
}

function updateControlState() {
  els.startCamera.disabled = !classifierReady || cameraReady;
  els.startCamera.textContent = cameraReady ? "Kamera aktif" : "Mulai kamera";
  els.scan.disabled = !(classifierReady && cameraReady) || inferenceBusy;
  els.auto.disabled = !(classifierReady && cameraReady);
  els.auto.textContent = `Auto scan: ${autoScanning ? "ON" : "OFF"}`;
}

function drawModelInput(source) {
  const canvas = els.canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const sourceWidth =
    source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight =
    source.videoHeight || source.naturalHeight || source.height;

  if (!sourceWidth || !sourceHeight) {
    throw new Error("Ukuran gambar belum tersedia.");
  }

  canvas.width = config.inputSize;
  canvas.height = config.inputSize;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Samakan preprocessing PWA dengan training:
  // seluruh frame/gambar di-resize menjadi input model 224x224.
  ctx.drawImage(
    source,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

function categoriesToVector(categories) {
  const vector = new Array(config.labels.length).fill(0);
  for (const category of categories) {
    if (Number.isInteger(category.index) && category.index >= 0 && category.index < vector.length) {
      vector[category.index] = category.score;
    }
  }
  return vector;
}

function smoothVector(vector, reset = false) {
  if (reset) smoothingBuffer = [];
  smoothingBuffer.push(vector);
  if (smoothingBuffer.length > config.smoothingWindow) smoothingBuffer.shift();
  const average = new Array(vector.length).fill(0);
  for (const item of smoothingBuffer) {
    item.forEach((value, index) => { average[index] += value; });
  }
  return average.map((value) => value / smoothingBuffer.length);
}

function bestIndex(values) {
  let index = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[index]) index = i;
  return index;
}

function setTextSafe(element, value, fallback = "Belum diisi") {
  if (element) {
    element.textContent = value || fallback;
  }
}

function getAcceptanceDecision(confidence, secondConfidence) {
  const primaryThreshold = Number(
    config.confidenceThreshold ?? 0.60
  );

  const secondaryThreshold = Number(
    config.secondaryConfidenceThreshold ?? 0.50
  );

  const marginThreshold = Number(
    config.confidenceMarginThreshold ?? 0.20
  );

  const margin = confidence - secondConfidence;

  const acceptedByPrimary =
    confidence >= primaryThreshold;

  const acceptedByMargin =
    confidence >= secondaryThreshold &&
    margin >= marginThreshold;

  return {
    accepted: acceptedByPrimary || acceptedByMargin,
    acceptedByPrimary,
    acceptedByMargin,
    primaryThreshold,
    secondaryThreshold,
    marginThreshold,
    margin,
  };
}


async function classifySource(source, { resetSmoothing = false, sourceType = "camera" } = {}) {
  if (!classifierReady || inferenceBusy) return;
  inferenceBusy = true;
  updateControlState();
  try {
    drawModelInput(source);

    const started = performance.now();
    const result = classifier.classifyForVideo(
      els.canvas,
      started,
    );
    const latencyMs = performance.now() - started;

    const categories =
      result.classifications?.[0]?.categories || [];

    if (!categories.length) {
      throw new Error(
        "Model tidak mengembalikan hasil klasifikasi."
      );
    }

    const vector = categoriesToVector(categories);
    const smoothed = smoothVector(
      vector,
      resetSmoothing,
    );

    const ranked = smoothed
      .map((score, index) => ({
        index,
        label: config.labels[index],
        score,
      }))
      .sort((a, b) => b.score - a.score);

    const top1 = ranked[0];
    const top2 = ranked[1] || {
      label: "",
      score: 0,
    };

    const label = top1.label;
    const confidence = top1.score;
    const secondLabel = top2.label;
    const secondConfidence = top2.score;

    const decision = getAcceptanceDecision(
      confidence,
      secondConfidence,
    );

    renderResult({
      label,
      confidence,
      secondLabel,
      secondConfidence,
      margin: decision.margin,
      accepted: decision.accepted,
      acceptedByPrimary: decision.acceptedByPrimary,
      acceptedByMargin: decision.acceptedByMargin,
      primaryThreshold: decision.primaryThreshold,
      secondaryThreshold: decision.secondaryThreshold,
      marginThreshold: decision.marginThreshold,
      latencyMs,
      probabilities: smoothed,
    });

    appendLog({
      label,
      confidence,
      secondLabel,
      secondConfidence,
      margin: decision.margin,
      accepted: decision.accepted,
      acceptedByPrimary: decision.acceptedByPrimary,
      acceptedByMargin: decision.acceptedByMargin,
      latencyMs,
      sourceType,
    });
  } catch (error) {
    console.error(error);
    els.resultName.textContent = "Pemindaian gagal";
    const raw = String(error?.message || error);
    if (raw.includes("Conversion from TfLite model failed")) {
      els.resultMessage.textContent =
        "Model TFLite belum kompatibel dengan MediaPipe pada perangkat ini. Mode CPU/WASM sudah digunakan. Jika pesan ini tetap muncul, model perlu diekspor ulang dalam format MediaPipe yang kompatibel.";
    } else {
      els.resultMessage.textContent = raw.length > 320 ? `${raw.slice(0, 320)}…` : raw;
    }
  } finally {
    inferenceBusy = false;
    updateControlState();
  }
}

function renderResult({
  label,
  confidence,
  secondLabel,
  secondConfidence,
  margin,
  accepted,
  acceptedByPrimary,
  acceptedByMargin,
  primaryThreshold,
  secondaryThreshold,
  marginThreshold,
  latencyMs,
  probabilities,
}) {
  els.resultCard.classList.remove("empty");
  els.resultConfidence.textContent =
    `${(confidence * 100).toFixed(1)}%`;
  els.latency.textContent =
    `${latencyMs.toFixed(0)} ms`;
  els.delegate.textContent = delegateName;

  // Selalu perbarui Top-3 lebih dulu.
  renderTopPredictions(probabilities);

  if (!accepted) {
    els.resultName.textContent =
      "Motif belum dikenali";

    els.resultMessage.textContent =
      `Prediksi teratas ${displayName(label)} ` +
      `${(confidence * 100).toFixed(1)}%, ` +
      `diikuti ${displayName(secondLabel)} ` +
      `${(secondConfidence * 100).toFixed(1)}%. ` +
      `Selisih ${(margin * 100).toFixed(1)}%. ` +
      `Motif belum memenuhi aturan penerimaan.`;

    if (els.educationPanel) {
      els.educationPanel.classList.add("hidden");
    }
    return;
  }

  const metadata =
    metadataMap.get(label) || {};

  els.resultName.textContent =
    displayName(label);

  if (acceptedByPrimary) {
    els.resultMessage.textContent =
      `Motif dikenali dengan confidence ` +
      `${(confidence * 100).toFixed(1)}%.`;
  } else if (acceptedByMargin) {
    els.resultMessage.textContent =
      `Motif dikenali: confidence ` +
      `${(confidence * 100).toFixed(1)}% dan ` +
      `selisih terhadap prediksi kedua ` +
      `${(margin * 100).toFixed(1)}%.`;
  } else {
    els.resultMessage.textContent =
      "Motif dikenali.";
  }

  setTextSafe(
    els.origin,
    metadata.origin,
  );
  setTextSafe(
    els.meaning,
    metadata.meaning,
  );
  setTextSafe(
    els.history,
    metadata.history,
  );
  setTextSafe(
    els.source,
    metadata.source_reference,
  );

  if (els.educationPanel) {
    els.educationPanel.classList.remove("hidden");
  }
}

function renderTopPredictions(probabilities) {
  const rows = probabilities
    .map((score, index) => ({ label: config.labels[index], score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  els.topPredictions.replaceChildren(...rows.map((row) => {
    const wrapper = document.createElement("div");
    wrapper.className = "prediction-row";
    wrapper.innerHTML = `
      <span>${escapeHtml(displayName(row.label))}</span>
      <div class="bar"><span style="width:${Math.max(0, Math.min(100, row.score * 100))}%"></span></div>
      <strong>${(row.score * 100).toFixed(1)}%</strong>`;
    return wrapper;
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

async function classifySelectedPhoto(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = async () => {
    try { await classifySource(image, { resetSmoothing: true, sourceType: "photo" }); }
    finally { URL.revokeObjectURL(url); }
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    els.resultMessage.textContent = "Foto tidak dapat dibaca.";
  };
  image.src = url;
}

function autoLoop(now) {
  if (autoScanning && cameraReady && !inferenceBusy && now - lastAutoRun >= config.scanIntervalMs) {
    lastAutoRun = now;
    classifySource(els.video, { sourceType: "camera_auto" });
  }
  requestAnimationFrame(autoLoop);
}

function appendLog({
  label,
  confidence,
  secondLabel,
  secondConfidence,
  margin,
  accepted,
  acceptedByPrimary,
  acceptedByMargin,
  latencyMs,
  sourceType,
}) {
  scanLog.push({
    sample_id: `SCAN-${Date.now()}`,
    timestamp: new Date().toISOString(),
    app_version: APP_VERSION,

    true_label: els.trueLabel.value,

    predicted_label:
      accepted ? label : "unknown",

    top_label_before_threshold:
      label,

    confidence:
      Number(confidence.toFixed(6)),

    top2_label:
      secondLabel,

    top2_confidence:
      Number(secondConfidence.toFixed(6)),

    confidence_margin:
      Number(margin.toFixed(6)),

    accepted,

    accepted_by_primary:
      acceptedByPrimary,

    accepted_by_margin:
      acceptedByMargin,

    latency_ms:
      Number(latencyMs.toFixed(2)),

    delegate:
      delegateName,

    source_type:
      sourceType,

    lighting:
      els.lighting.value,

    angle_deg:
      els.angle.value,

    distance_cm:
      els.distance.value,

    medium:
      els.medium.value,
  });

  localStorage.setItem(
    "batiklens_scan_log",
    JSON.stringify(scanLog),
  );

  updateLogCount();
}

function loadLog() {
  try { return JSON.parse(localStorage.getItem("batiklens_scan_log") || "[]"); }
  catch { return []; }
}

function updateLogCount() { els.logCount.textContent = `${scanLog.length} data`; }

function downloadLog() {
  if (!scanLog.length) return alert("Belum ada data pemindaian.");
  const columns = [
    ...new Set(
      scanLog.flatMap((row) => Object.keys(row))
    ),
  ];
  const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [columns.join(","), ...scanLog.map((row) => columns.map((key) => escapeCsv(row[key])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `batiklens_scan_log_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

els.startCamera.addEventListener("click", async () => {
  try {
    await startCamera();
  } catch (error) {
    console.error("Camera error:", error);
    const message =
      error?.name === "NotAllowedError"
        ? "Izin kamera ditolak. Izinkan kamera pada pengaturan Chrome/BatikLens, lalu buka ulang aplikasi."
        : error?.name === "NotFoundError"
          ? "Kamera tidak ditemukan pada perangkat."
          : error?.name === "NotReadableError"
            ? "Kamera sedang dipakai aplikasi lain. Tutup aplikasi kamera/video lain lalu coba kembali."
            : error?.message || String(error);
    setStatus("error", "Kamera gagal dibuka", message);
    alert(message);
  }
});
els.scan.addEventListener("click", () => classifySource(els.video, { resetSmoothing: true, sourceType: "camera_manual" }));
els.auto.addEventListener("click", () => {
  autoScanning = !autoScanning;
  if (!autoScanning) smoothingBuffer = [];
  updateControlState();
});
els.photoInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file && classifierReady) classifySelectedPhoto(file);
  event.target.value = "";
});
els.downloadLog.addEventListener("click", downloadLog);
els.clearLog.addEventListener("click", () => {
  if (confirm("Hapus seluruh log pemindaian pada perangkat ini?")) {
    scanLog = [];
    localStorage.removeItem("batiklens_scan_log");
    updateLogCount();
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  els.install.classList.remove("hidden");
});
els.install.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.install.classList.add("hidden");
});
window.addEventListener("appinstalled", () => els.install.classList.add("hidden"));
window.addEventListener("beforeunload", stopCamera);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));
}

requestAnimationFrame(autoLoop);
initialize();
