import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  collection,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  addDoc,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBkXRY91cIA24l8io4IXpuf8WCs-XzqzkY",
  authDomain: "praktik-nessa-p1-243026010.firebaseapp.com",
  databaseURL:
    "https://praktik-nessa-p1-243026010-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "praktik-nessa-p1-243026010",
  storageBucket: "praktik-nessa-p1-243026010.firebasestorage.app",
  messagingSenderId: "899976657760",
  appId: "1:899976657760:web:a02ea4c386c337e0ec7c05",
};

const LOG_COLLECTION = "detection_logs";
const MOCK_STORAGE_KEY = "edge_ai_inventory_mock_logs";
const DEVICE_STORAGE_KEY = "edge_ai_inventory_device_id";
const SAVE_THROTTLE_MS = 3000;
const MAX_VISIBLE_LOGS = 30;

const TARGET_CLASSES = [
  "mouse",
  "keyboard",
  "cell phone",
  "book",
  "scissors",
  "laptop",
  "person",
];

const CLASS_LABELS = {
  mouse: "Mouse",
  keyboard: "Keyboard",
  "cell phone": "HP / Cell Phone",
  book: "Buku",
  scissors: "Gunting",
  laptop: "Laptop",
  person: "Orang",
};

const state = {
  dbMode: "mock",
  db: null,
  firebaseEnabled: false,
  unsubscribe: null,
  mockListener: null,
  stream: null,
  model: null,
  modelLoading: false,
  isDetecting: false,
  detectionBusy: false,
  frameHandle: null,
  cameraStarted: false,
  lastSaveAt: 0,
  selectedTargets: new Set(TARGET_CLASSES),
  confidence: 0.6,
  logs: [],
};

const el = {
  video: document.getElementById("video"),
  canvas: document.getElementById("canvas"),
  ctx: document.getElementById("canvas").getContext("2d"),
  cameraContainer: document.getElementById("cameraContainer"),
  overlayMsg: document.getElementById("overlayMsg"),
  overlayText: document.getElementById("overlayText"),
  startCameraBtn: document.getElementById("startCameraBtn"),
  stopCameraBtn: document.getElementById("stopCameraBtn"),
  facingMode: document.getElementById("facingMode"),
  loadModelBtn: document.getElementById("loadModelBtn"),
  toggleAiBtn: document.getElementById("toggleAiBtn"),
  modelStatus: document.getElementById("modelStatus"),
  dbStatus: document.getElementById("dbStatus"),
  aiState: document.getElementById("aiState"),
  confidenceRange: document.getElementById("confidenceRange"),
  confidenceValue: document.getElementById("confidenceValue"),
  targetClasses: document.getElementById("targetClasses"),
  dataList: document.getElementById("dataList"),
  detectionCount: document.getElementById("detectionCount"),
  cameraStatus: document.getElementById("cameraStatus"),
  logCount: document.getElementById("logCount"),
  logModeBadge: document.getElementById("logModeBadge"),
  syncIndicator: document.getElementById("syncIndicator"),
  exportBtn: document.getElementById("exportBtn"),
  clearLogsBtn: document.getElementById("clearLogsBtn"),
};

function hasValidFirebaseConfig() {
  const required = [
    firebaseConfig.apiKey,
    firebaseConfig.authDomain,
    firebaseConfig.projectId,
    firebaseConfig.storageBucket,
    firebaseConfig.messagingSenderId,
    firebaseConfig.appId,
  ];

  return (
    required.every(Boolean) &&
    !firebaseConfig.apiKey.includes("PASTE_") &&
    !firebaseConfig.projectId.includes("PROJECT_ID_ANDA") &&
    !firebaseConfig.appId.includes("APP_ID_ANDA")
  );
}

function initFirebase() {
  if (state.firebaseEnabled && state.db) return true;
  if (!hasValidFirebaseConfig()) return false;

  try {
    const app = initializeApp(firebaseConfig);
    state.db = getFirestore(app);
    state.firebaseEnabled = true;
    return true;
  } catch (error) {
    console.error("Firebase init error:", error);
    state.firebaseEnabled = false;
    state.db = null;
    return false;
  }
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (!id) {
    id =
      `BROWSER-${crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10)}`.toUpperCase();
    localStorage.setItem(DEVICE_STORAGE_KEY, id);
  }
  return id;
}

function readMockLogs() {
  try {
    const data = JSON.parse(localStorage.getItem(MOCK_STORAGE_KEY) || "[]");
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Mock storage parse error:", error);
    return [];
  }
}

function writeMockLogs(logs) {
  localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(logs));
  window.dispatchEvent(new CustomEvent("edge-ai-mock-change"));
}

function getMockLogsSorted() {
  return readMockLogs().sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function mockListen(callback) {
  const render = () =>
    callback({ docs: getMockLogsSorted().slice(0, MAX_VISIBLE_LOGS) });
  const handler = () => render();
  window.addEventListener("edge-ai-mock-change", handler);
  window.addEventListener("storage", handler);
  render();
  return () => {
    window.removeEventListener("edge-ai-mock-change", handler);
    window.removeEventListener("storage", handler);
  };
}

function normalizeFirestoreTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeLog(doc, firebaseDoc = true) {
  const data = firebaseDoc && typeof doc.data === "function" ? doc.data() : doc;
  return {
    id: firebaseDoc ? doc.id : data.id || crypto.randomUUID(),
    items: Array.isArray(data.items) ? data.items : [],
    itemsString:
      data.itemsString ||
      (Array.isArray(data.items) ? data.items.join(", ") : "-"),
    count: Number(data.count || 0),
    deviceId: data.deviceId || "BROWSER-UNKNOWN",
    timestamp:
      normalizeFirestoreTimestamp(data.timestamp) ||
      data.timestamp ||
      new Date().toISOString(),
    mode: data.mode || (state.dbMode === "firebase" ? "firebase" : "mock"),
  };
}

function closeDbListener() {
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  if (state.mockListener) {
    state.mockListener();
    state.mockListener = null;
  }
}

function listenToDatabase() {
  closeDbListener();
  setSyncIndicator("Menyinkronkan", true);

  if (state.dbMode === "firebase" && state.firebaseEnabled && state.db) {
    const logsRef = collection(state.db, LOG_COLLECTION);
    const logsQuery = query(
      logsRef,
      orderBy("timestamp", "desc"),
      limit(MAX_VISIBLE_LOGS),
    );

    state.unsubscribe = onSnapshot(
      logsQuery,
      (snapshot) => {
        state.logs = snapshot.docs.map((doc) => normalizeLog(doc, true));
        renderLogs();
        setSyncIndicator("Firebase real-time", true);
      },
      (error) => {
        console.error("Firestore listener error:", error);
        setDbStatus("Firebase error", "warn");
        setSyncIndicator("Firebase gagal, cek Rules", false);
      },
    );
    return;
  }

  state.mockListener = mockListen((snapshot) => {
    state.logs = snapshot.docs.map((doc) => normalizeLog(doc, false));
    renderLogs();
    setSyncIndicator("Mock LocalStorage", true);
  });
}

async function saveToDatabase(detections) {
  const now = Date.now();
  if (now - state.lastSaveAt < SAVE_THROTTLE_MS) return false;

  const items = detections.map((item) => ({
    class: item.class,
    label: CLASS_LABELS[item.class] || item.class,
    confidence: Number((item.score * 100).toFixed(2)),
  }));

  const payload = {
    items,
    itemsString: items
      .map((item) => `${item.label} (${item.confidence}%)`)
      .join(", "),
    count: items.length,
    deviceId: getDeviceId(),
    mode: state.dbMode,
    timestamp:
      state.dbMode === "firebase"
        ? serverTimestamp()
        : new Date().toISOString(),
  };

  try {
    if (state.dbMode === "firebase" && state.firebaseEnabled && state.db) {
      await addDoc(collection(state.db, LOG_COLLECTION), payload);
    } else {
      const current = readMockLogs();
      current.push({
        ...payload,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      });

      writeMockLogs(current.slice(-200));
    }
    state.lastSaveAt = now;
    return true;
  } catch (error) {
    console.error("Gagal menyimpan ke database:", error);
    setDbStatus("DB write error", "warn");
    return false;
  }
}

async function exportLogsAsCsv() {
  let logs = [];

  try {
    if (state.dbMode === "firebase" && state.firebaseEnabled && state.db) {
      const snapshot = await getDocs(collection(state.db, LOG_COLLECTION));
      logs = snapshot.docs
        .map((doc) => normalizeLog(doc, true))
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
    } else {
      logs = getMockLogsSorted();
    }

    if (!logs.length) {
      alert("Belum ada log untuk diekspor.");
      return;
    }

    const rows = [
      ["Waktu", "Items", "Jumlah", "Device ID", "Mode"],
      ...logs.map((log) => [
        formatDate(log.timestamp),
        log.itemsString,
        log.count,
        log.deviceId,
        log.mode,
      ]),
    ];

    const csv = rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\r\n");

    const blob = new Blob(["\ufeff" + csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Export error:", error);
    alert("Gagal mengekspor log. Cek console browser.");
  }
}

function clearMockLogs() {
  if (state.dbMode !== "mock") {
    alert("Tombol ini hanya menghapus log Mock/LocalStorage.");
    return;
  }

  if (!confirm("Hapus semua log Mock di browser ini?")) return;
  localStorage.removeItem(MOCK_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent("edge-ai-mock-change"));
}

function setDbStatus(text, type = "neutral") {
  el.dbStatus.textContent = `DB: ${text}`;
  el.dbStatus.className = `status-pill status-${type}`;
}

function setModelStatus(text, type = "neutral") {
  el.modelStatus.textContent = text;
  el.modelStatus.className = `status-pill status-${type}`;
}

function setSyncIndicator(text, live = false) {
  el.syncIndicator.innerHTML = `<i></i> ${escapeHtml(text)}`;
  el.syncIndicator.classList.toggle("live", live);
}

function setOverlay(text, show = true) {
  el.overlayText.textContent = text;
  el.overlayMsg.classList.toggle("hidden", !show);
}

function renderTargetCheckboxes() {
  el.targetClasses.innerHTML = TARGET_CLASSES.map((target) => {
    const checked = state.selectedTargets.has(target) ? "checked" : "";
    return `
      <label class="target-option">
        <input type="checkbox" value="${target}" ${checked} />
        <span>${CLASS_LABELS[target] || target}</span>
      </label>
    `;
  }).join("");

  el.targetClasses.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        state.selectedTargets.add(input.value);
      } else {
        state.selectedTargets.delete(input.value);
      }

      updateTargetSelectedCount();
    });
  });
}

function renderLogs() {
  el.logCount.textContent = String(state.logs.length);

  if (!state.logs.length) {
    el.dataList.innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">🌸</div>
        <strong>Belum ada objek terdeteksi</strong>
        <span>Start Camera → Muat Model → Start AI</span>
      </div>
    `;
    return;
  }

  el.dataList.innerHTML = state.logs
    .map((log) => {
      const labels = (log.items || []).map(
        (item) => item.label || item.class || "Unknown",
      );
      const uniqueLabels = [...new Set(labels)];
      return `
      <article class="log-item">
        <div>
          <div class="log-time">${escapeHtml(formatDate(log.timestamp))}</div>
          <div class="log-items">${escapeHtml(log.itemsString || "- ")}</div>
          <div class="log-meta">
            ${uniqueLabels
              .slice(0, 7)
              .map(
                (label) => `<span class="log-tag">${escapeHtml(label)}</span>`,
              )
              .join("")}
            <span class="log-tag">${escapeHtml(log.deviceId)}</span>
          </div>
        </div>
        <div class="log-count-badge">${Number(log.count || 0)} obj</div>
      </article>
    `;
    })
    .join("");
}

function formatDate(value) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function syncCanvasSize() {
  if (!el.video.videoWidth || !el.video.videoHeight) return;
  el.canvas.width = el.video.videoWidth;
  el.canvas.height = el.video.videoHeight;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert(
      "Browser ini tidak mendukung getUserMedia(). Gunakan Chrome/Edge/Firefox terbaru melalui HTTPS atau localhost.",
    );
    return;
  }

  stopCamera();
  setOverlay("Meminta izin kamera...", true);

  try {
    const facingMode = el.facingMode.value;
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    el.video.srcObject = state.stream;

    el.video.style.transform = "none";
    el.canvas.style.transform = "none";

    await el.video.play();
    await new Promise((resolve) => {
      if (el.video.readyState >= 2) resolve();
      else el.video.addEventListener("loadedmetadata", resolve, { once: true });
    });

    syncCanvasSize();
    state.cameraStarted = true;
    el.startCameraBtn.disabled = true;
    el.stopCameraBtn.disabled = false;
    el.toggleAiBtn.disabled = !state.model;
    el.cameraStatus.textContent = "ON";
    setOverlay("Kamera siap. Muat model AI lalu Start AI.", false);
  } catch (error) {
    console.error("Camera error:", error);
    setOverlay(
      "Kamera gagal dibuka. Cek izin kamera dan gunakan HTTPS/localhost.",
      true,
    );
    alert(`Gagal mengakses kamera: ${error.message}`);
  }
}

function stopCamera() {
  stopDetection();

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  el.video.srcObject = null;
  state.cameraStarted = false;
  el.startCameraBtn.disabled = false;
  el.stopCameraBtn.disabled = true;
  el.toggleAiBtn.disabled = true;
  el.cameraStatus.textContent = "OFF";
  el.ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  setOverlay("Kamera berhenti. Klik Start Camera untuk memulai lagi.", true);
}

async function loadModel() {
  if (state.model || state.modelLoading) return;
  state.modelLoading = true;
  el.loadModelBtn.disabled = true;
  setModelStatus("Memuat model...", "warn");
  setOverlay("Mengunduh model COCO-SSD. Tunggu sebentar...", true);

  try {
    await tf.ready();
    state.model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    setModelStatus("Model siap", "success");
    el.toggleAiBtn.disabled = !state.cameraStarted;
    el.loadModelBtn.textContent = "✅ Model Siap";

    if (state.cameraStarted) {
      setOverlay("Model siap. Klik Start AI.", false);
    } else {
      setOverlay("Model siap. Sekarang nyalakan kamera.", true);
    }
  } catch (error) {
    console.error("Model load error:", error);
    state.model = null;
    el.loadModelBtn.disabled = false;
    setModelStatus("Model gagal", "warn");
    setOverlay("Gagal memuat model. Pastikan internet aktif.", true);
    alert(
      "Gagal memuat COCO-SSD. Coba refresh halaman dan pastikan koneksi internet aktif.",
    );
  } finally {
    state.modelLoading = false;
  }
}

function drawDetections(predictions) {
  syncCanvasSize();
  const ctx = el.ctx;
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);

  const scaleX = el.canvas.width / Math.max(el.video.videoWidth, 1);
  const scaleY = el.canvas.height / Math.max(el.video.videoHeight, 1);

  predictions.forEach((pred) => {
    const [x, y, width, height] = pred.bbox;
    const canvasX = x * scaleX;
    const canvasY = y * scaleY;
    const canvasW = width * scaleX;
    const canvasH = height * scaleY;
    const isTarget = state.selectedTargets.has(pred.class);
    const meets = pred.score >= state.confidence;

    ctx.lineWidth = isTarget ? 3 : 1.5;
    ctx.strokeStyle = isTarget ? "#ec4899" : "#a78bfa";
    ctx.strokeRect(canvasX, canvasY, canvasW, canvasH);

    if (isTarget && meets) {
      const label = `${CLASS_LABELS[pred.class] || pred.class} ${(pred.score * 100).toFixed(0)}%`;
      ctx.font = "700 14px Nunito, sans-serif";
      const labelWidth = ctx.measureText(label).width + 14;
      const labelY = Math.max(canvasY - 25, 0);
      ctx.fillStyle = "#ec4899";
      ctx.fillRect(canvasX, labelY, labelWidth, 25);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, canvasX + 7, labelY + 17);
    }
  });
}

async function detectFrame() {
  if (!state.isDetecting) return;
  if (!state.cameraStarted || !state.model) {
    stopDetection();
    return;
  }

  if (!state.detectionBusy && el.video.readyState >= 2) {
    state.detectionBusy = true;
    try {
      const predictions = await state.model.detect(el.video);
      const targetPredictions = predictions.filter(
        (pred) =>
          state.selectedTargets.has(pred.class) &&
          pred.score >= state.confidence,
      );

      drawDetections(predictions);
      el.detectionCount.textContent = String(targetPredictions.length);

      if (targetPredictions.length > 0) {
        await saveToDatabase(targetPredictions);
      }
    } catch (error) {
      console.error("Detection error:", error);
    } finally {
      state.detectionBusy = false;
    }
  }

  state.frameHandle = requestAnimationFrame(detectFrame);
}

function startDetection() {
  if (!state.cameraStarted) {
    alert("Nyalakan kamera terlebih dahulu.");
    return;
  }
  if (!state.model) {
    alert("Muat model AI terlebih dahulu.");
    return;
  }
  if (state.isDetecting) return;

  state.isDetecting = true;
  state.lastSaveAt = 0;
  el.aiState.textContent = "ON";
  el.aiState.className = "mini-state pink";
  el.toggleAiBtn.textContent = "⏸ Stop AI";
  el.toggleAiBtn.className = "btn btn-secondary full-width";
  setOverlay("AI aktif. Arahkan kamera ke objek target.", false);
  detectFrame();
}

function stopDetection() {
  state.isDetecting = false;
  state.detectionBusy = false;
  if (state.frameHandle) cancelAnimationFrame(state.frameHandle);
  state.frameHandle = null;
  el.aiState.textContent = "OFF";
  el.aiState.className = "mini-state";
  el.toggleAiBtn.textContent = "▶ Start AI";
  el.toggleAiBtn.className = "btn btn-success full-width";
  el.detectionCount.textContent = "0";
  el.ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
}

function applyDbMode(mode) {
  state.dbMode = mode;
  document.querySelectorAll("[data-db-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.dbMode === mode);
  });
  el.logModeBadge.textContent = mode.toUpperCase();

  if (mode === "firebase") {
    if (!state.firebaseEnabled) {
      const initialized = initFirebase();
      if (!initialized) {
        alert(
          "Firebase config belum valid. Isi firebaseConfig di app.js terlebih dahulu.",
        );
        state.dbMode = "mock";
        document.querySelectorAll("[data-db-mode]").forEach((button) => {
          button.classList.toggle("active", button.dataset.dbMode === "mock");
        });
        el.logModeBadge.textContent = "MOCK";
        setDbStatus("Mock Mode", "pink");
        listenToDatabase();
        return;
      }
    }
    setDbStatus("Firebase ON", "success");
    el.clearLogsBtn.style.display = "none";
  } else {
    setDbStatus("Mock Mode", "pink");
    el.clearLogsBtn.style.display = "inline-flex";
  }

  listenToDatabase();
}

el.startCameraBtn.addEventListener("click", startCamera);
el.stopCameraBtn.addEventListener("click", stopCamera);
el.loadModelBtn.addEventListener("click", loadModel);
el.toggleAiBtn.addEventListener("click", () => {
  state.isDetecting ? stopDetection() : startDetection();
});
el.facingMode.addEventListener("change", () => {
  if (state.cameraStarted) startCamera();
});
el.confidenceRange.addEventListener("input", (event) => {
  state.confidence = Number(event.target.value) / 100;
  el.confidenceValue.textContent = `${event.target.value}%`;
});
el.exportBtn.addEventListener("click", exportLogsAsCsv);
el.clearLogsBtn.addEventListener("click", clearMockLogs);
document.querySelectorAll("[data-db-mode]").forEach((button) => {
  button.addEventListener("click", () => applyDbMode(button.dataset.dbMode));
});
window.addEventListener("resize", syncCanvasSize);
window.addEventListener("beforeunload", () => {
  closeDbListener();
  stopCamera();
});

function initApp() {
  renderTargetCheckboxes();
  renderLogs();
  applyDbMode("mock");

  const firebaseReady = initFirebase();
  if (firebaseReady) {
    setDbStatus("Siap · config tersedia", "success");
  } else {
    setDbStatus("Mock Mode", "pink");
  }

  console.log("✅ Edge AI Inventory Scanner siap.");
  console.log("📱 Device ID:", getDeviceId());
  console.log("☁️ Firebase config tersedia:", firebaseReady);
}

initApp();
