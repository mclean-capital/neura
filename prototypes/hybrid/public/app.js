// ── DOM refs ────────────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
const micBtn = document.getElementById('mic-btn');
const transcriptEl = document.getElementById('transcript');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const videoEl = document.getElementById('camera');
const cameraContainer = document.getElementById('camera-container');
const visionBadge = document.getElementById('vision-badge');
const cameraOff = document.getElementById('camera-off');
const screenPreview = document.getElementById('screen-preview');
const screenContainer = document.getElementById('screen-container');
const screenBadge = document.getElementById('screen-badge');
const screenBtn = document.getElementById('screen-btn');

// ── State ───────────────────────────────────────────────────────────────────
let ws = null;
let audioCtx = null;
let micStream = null;
let micSource = null;
let workletNode = null;
let cameraStream = null;
let frameInterval = null;
let screenStream = null;
let screenVideo = null;
let screenInterval = null;
let isActive = false;

// Playback
let playCtx = null;
let nextPlayTime = 0;

// Transcript
let currentUserMsg = null;
let currentAssistantMsg = null;

// ── Helpers ─────────────────────────────────────────────────────────────────
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function addMessage(text, type) {
  const el = document.createElement('div');
  el.className = 'msg ' + (type || 'system');
  el.textContent = text;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return el;
}

function updateTranscript(text, role) {
  if (role === 'user') {
    if (!currentUserMsg) currentUserMsg = addMessage(text, 'user');
    else currentUserMsg.textContent += text;
  } else {
    if (!currentAssistantMsg) currentAssistantMsg = addMessage(text, 'assistant');
    else currentAssistantMsg.textContent += text;
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ── Camera ──────────────────────────────────────────────────────────────────
const captureCanvas = document.createElement('canvas');
captureCanvas.width = 640;
captureCanvas.height = 480;
const captureCtx = captureCanvas.getContext('2d');

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    videoEl.srcObject = cameraStream;
    cameraOff.style.display = 'none';
    cameraContainer.classList.add('active');

    // Send a frame every 2 seconds
    frameInterval = setInterval(sendFrame, 2000);
  } catch (err) {
    console.warn('Camera not available:', err.message);
    addMessage('Camera not available — voice-only mode', 'system');
  }
}

function sendFrame() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !cameraStream) return;
  captureCtx.drawImage(videoEl, 0, 0, 640, 480);
  const dataUrl = captureCanvas.toDataURL('image/jpeg', 0.7);
  const base64 = dataUrl.split(',')[1];
  ws.send(JSON.stringify({ type: 'videoFrame', data: base64 }));
}

function stopCamera() {
  clearInterval(frameInterval);
  frameInterval = null;
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  videoEl.srcObject = null;
  cameraOff.style.display = '';
  cameraContainer.classList.remove('active');
}

// ── Screen share ────────────────────────────────────────────────────────────
const screenCanvas = document.createElement('canvas');
screenCanvas.width = 1280;
screenCanvas.height = 720;
const screenCtx = screenCanvas.getContext('2d');

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenPreview.srcObject = screenStream;
    screenContainer.classList.add('active');

    // Stop gracefully if user clicks browser's "Stop sharing" button
    screenStream.getVideoTracks()[0].onended = () => stopScreenShare();

    screenInterval = setInterval(sendScreenFrame, 2000);
    addMessage('Screen sharing started', 'system');
  } catch (err) {
    console.warn('Screen share cancelled:', err.message);
  }
}

function sendScreenFrame() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !screenStream) return;
  const track = screenStream.getVideoTracks()[0];
  if (!track) return;
  const settings = track.getSettings();
  screenCanvas.width = settings.width || 1280;
  screenCanvas.height = settings.height || 720;
  screenCtx.drawImage(screenPreview, 0, 0, screenCanvas.width, screenCanvas.height);
  const dataUrl = screenCanvas.toDataURL('image/jpeg', 0.7);
  const base64 = dataUrl.split(',')[1];
  ws.send(JSON.stringify({ type: 'screenFrame', data: base64 }));
}

function stopScreenShare() {
  clearInterval(screenInterval);
  screenInterval = null;
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  screenPreview.srcObject = null;
  screenContainer.classList.remove('active');
}

screenBtn.addEventListener('click', () => {
  if (screenStream) {
    stopScreenShare();
    addMessage('Screen sharing stopped', 'system');
  } else {
    startScreenShare();
  }
});

// ── WebSocket ───────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  setStatus('connecting...', 'connecting');

  ws.onopen = () => {
    setStatus('connected', 'connected');
    textInput.disabled = false;
    sendBtn.disabled = false;
    addMessage('Session started — try "what do you see?"', 'system');
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'audio':
        playAudioChunk(msg.data);
        break;
      case 'inputTranscript':
        updateTranscript(msg.text, 'user');
        break;
      case 'outputTranscript':
        updateTranscript(msg.text, 'assistant');
        break;
      case 'interrupted':
        clearPlaybackQueue();
        break;
      case 'turnComplete':
        currentUserMsg = null;
        currentAssistantMsg = null;
        break;
      case 'toolCall':
        if (msg.name === 'describe_camera') {
          visionBadge.classList.add('active');
          addMessage('Analyzing camera...', 'tool');
        } else if (msg.name === 'describe_screen') {
          screenBadge.classList.add('active');
          addMessage('Analyzing screen...', 'tool');
        } else {
          addMessage(`${msg.name}(${JSON.stringify(msg.args)})`, 'tool');
        }
        break;
      case 'toolResult':
        visionBadge.classList.remove('active');
        screenBadge.classList.remove('active');
        if (msg.result?.result) {
          addMessage('Watcher: ' + msg.result.result, 'tool');
        } else if (msg.result?.error) {
          addMessage('Watcher error: ' + msg.result.error, 'tool');
        }
        break;
      case 'error':
        addMessage('Error: ' + msg.error, 'system');
        setStatus('error', 'error');
        break;
      case 'sessionClosed':
        addMessage('Session closed', 'system');
        break;
    }
  };

  ws.onclose = () => {
    setStatus('disconnected');
    textInput.disabled = true;
    sendBtn.disabled = true;
  };

  ws.onerror = () => {
    setStatus('connection error', 'error');
  };
}

// ── Mic capture (24 kHz) ────────────────────────────────────────────────────
async function startMic() {
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('pcm-processor.js');

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  micSource = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');

  workletNode.port.onmessage = (ev) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'audio',
          data: arrayBufferToBase64(ev.data.pcm),
        })
      );
    }
  };

  micSource.connect(workletNode);
  workletNode.connect(audioCtx.destination);
}

function stopMic() {
  workletNode?.disconnect();
  micSource?.disconnect();
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  workletNode = null;
  micSource = null;
  micStream = null;
  audioCtx = null;
}

// ── Audio playback (24 kHz) ─────────────────────────────────────────────────
function ensurePlayCtx() {
  if (!playCtx || playCtx.state === 'closed') {
    playCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = 0;
  }
}

function playAudioChunk(base64) {
  ensurePlayCtx();

  const pcmBuf = base64ToArrayBuffer(base64);
  const int16 = new Int16Array(pcmBuf);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }

  const audioBuf = playCtx.createBuffer(1, float32.length, 24000);
  audioBuf.getChannelData(0).set(float32);

  const src = playCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(playCtx.destination);

  const now = playCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  src.start(nextPlayTime);
  nextPlayTime += audioBuf.duration;
}

function clearPlaybackQueue() {
  if (playCtx) nextPlayTime = playCtx.currentTime;
}

// ── Text input ──────────────────────────────────────────────────────────────
function sendText() {
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  addMessage(text, 'user');
  ws.send(JSON.stringify({ type: 'text', text }));
  textInput.value = '';
  currentUserMsg = null;
}

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendText();
});
sendBtn.addEventListener('click', sendText);

// ── Start / stop ────────────────────────────────────────────────────────────
micBtn.addEventListener('click', async () => {
  if (!isActive) {
    try {
      isActive = true;
      micBtn.classList.add('active');
      connectWS();
      await startCamera();
      await startMic();
      ensurePlayCtx();
    } catch (err) {
      console.error('Start failed:', err);
      setStatus('error: ' + err.message, 'error');
      isActive = false;
      micBtn.classList.remove('active');
    }
  } else {
    isActive = false;
    micBtn.classList.remove('active');
    stopMic();
    stopCamera();
    stopScreenShare();
    clearPlaybackQueue();
    ws?.close();
  }
});
