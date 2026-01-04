const WS_URL = `ws://${location.host}/ws`;
const DEFAULT_FRAME_SIZE = 1024;

const wsDot = document.getElementById("wsDot");
const wsText = document.getElementById("wsText");
const deviceSelect = document.getElementById("deviceSelect");
const refreshDevicesBtn = document.getElementById("refreshDevices");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const levelBar = document.getElementById("levelBar");
const srEl = document.getElementById("sr");
const fsEl = document.getElementById("fs");
const sentEl = document.getElementById("sent");
const droppedEl = document.getElementById("dropped");
const logEl = document.getElementById("log");

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

let ws = null;
let audioContext = null;
let mediaStream = null;
let captureNode = null;
let sentFrames = 0;
let droppedFrames = 0;

function setWsStatus(ok, text) {
  wsDot.classList.toggle("ok", ok);
  wsText.textContent = text;
}

async function ensurePermission() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });
  stream.getTracks().forEach((t) => t.stop());
}

async function refreshDevices() {
  try {
    await ensurePermission();
  } catch {
    // ignore: user might refuse; enumerateDevices can still return labels blank
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  deviceSelect.innerHTML = "";
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Audio input (${d.deviceId.slice(0, 6)}…)`;
    deviceSelect.appendChild(opt);
  }
  if (inputs.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No audio inputs found";
    deviceSelect.appendChild(opt);
  }
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws;
  }
  ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    setWsStatus(true, "WS: connected");
    ws.send(JSON.stringify({ type: "hello", client: "capture" }));
  });

  ws.addEventListener("close", () => {
    setWsStatus(false, "WS: disconnected");
  });

  ws.addEventListener("error", () => {
    setWsStatus(false, "WS: error");
  });

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === "status") {
          // optional
        }
      } catch {
        // ignore
      }
    }
  });

  return ws;
}

function updateStatsUI(sampleRate) {
  srEl.textContent = sampleRate ? `${sampleRate} Hz` : "-";
  fsEl.textContent = `${DEFAULT_FRAME_SIZE} frames`;
  sentEl.textContent = String(sentFrames);
  droppedEl.textContent = String(droppedFrames);
}

async function startCapture() {
  if (audioContext) return;

  connectWs();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Waiting for WS…");
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS timeout")), 2000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceSelect.value ? { exact: deviceSelect.value } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  audioContext = new AudioContext({ latencyHint: "interactive" });
  await audioContext.audioWorklet.addModule("/worklet.js");

  const src = audioContext.createMediaStreamSource(mediaStream);
  captureNode = new AudioWorkletNode(audioContext, "pcm-capture", {
    processorOptions: {
      frameSize: DEFAULT_FRAME_SIZE,
      channels: 1
    }
  });

  const mute = audioContext.createGain();
  mute.gain.value = 0;

  src.connect(captureNode);
  captureNode.connect(mute);
  mute.connect(audioContext.destination);

  sentFrames = 0;
  droppedFrames = 0;
  updateStatsUI(audioContext.sampleRate);

  ws.send(
    JSON.stringify({
      type: "pcm",
      format: "f32le",
      sampleRate: audioContext.sampleRate,
      channels: 1,
      frames: DEFAULT_FRAME_SIZE
    })
  );

  captureNode.port.onmessage = (ev) => {
    const { frame, level } = ev.data || {};
    if (typeof level === "number") {
      const pct = Math.max(0, Math.min(1, level)) * 100;
      levelBar.style.width = `${pct.toFixed(2)}%`;
    }
    if (!(frame instanceof ArrayBuffer)) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      droppedFrames++;
      return;
    }
    ws.send(frame);
    sentFrames++;
    if (sentFrames % 10 === 0) updateStatsUI(audioContext.sampleRate);
  };

  startBtn.disabled = true;
  stopBtn.disabled = false;
  log("Capture started");
}

async function stopCapture() {
  startBtn.disabled = false;
  stopBtn.disabled = true;

  if (captureNode) {
    captureNode.port.onmessage = null;
    captureNode.disconnect();
    captureNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  levelBar.style.width = "0%";
  log("Capture stopped");
}

refreshDevicesBtn.addEventListener("click", () => {
  refreshDevices().catch((e) => log(`Device refresh failed: ${e.message}`));
});
startBtn.addEventListener("click", () => {
  startCapture().catch((e) => log(`Start failed: ${e.message}`));
});
stopBtn.addEventListener("click", () => {
  stopCapture().catch((e) => log(`Stop failed: ${e.message}`));
});

refreshDevices().catch(() => {});
setWsStatus(false, "WS: disconnected");
log(`Connecting to ${WS_URL}`);
connectWs();

