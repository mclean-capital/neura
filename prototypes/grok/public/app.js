// ── DOM refs ────────────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
const micBtn = document.getElementById('mic-btn');
const transcriptEl = document.getElementById('transcript');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');

// ── State ───────────────────────────────────────────────────────────────────
let ws = null;
let audioCtx = null;
let micStream = null;
let micSource = null;
let workletNode = null;
let isActive = false;

// Playback — Grok outputs 24 kHz PCM
let playCtx = null;
let nextPlayTime = 0;

// Transcript tracking
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

// ── WebSocket ───────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  setStatus('connecting...', 'connecting');

  ws.onopen = () => {
    setStatus('connected', 'connected');
    textInput.disabled = false;
    sendBtn.disabled = false;
    addMessage('Session started');
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
        addMessage(`${msg.name}(${JSON.stringify(msg.args)})`, 'tool');
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

// ── Mic capture (24 kHz for Grok) ───────────────────────────────────────────
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

// ── Mic toggle ──────────────────────────────────────────────────────────────
micBtn.addEventListener('click', async () => {
  if (!isActive) {
    try {
      isActive = true;
      micBtn.classList.add('active');
      connectWS();
      await startMic();
      ensurePlayCtx();
    } catch (err) {
      console.error('Start failed:', err);
      setStatus('mic error: ' + err.message, 'error');
      isActive = false;
      micBtn.classList.remove('active');
    }
  } else {
    isActive = false;
    micBtn.classList.remove('active');
    stopMic();
    clearPlaybackQueue();
    ws?.close();
  }
});
