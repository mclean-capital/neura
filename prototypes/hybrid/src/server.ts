import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHybridSession } from './grok-session.js';
import { createGeminiWatcher } from './gemini-watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3002', 10);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(join(__dirname, '../public')));

wss.on('connection', (ws: WebSocket) => {
  console.log('[ws] client connected');

  // Gemini Live watcher — continuous video context
  const watcher = createGeminiWatcher();

  const session = createHybridSession({
    onAudio(data) {
      send({ type: 'audio', data });
    },
    onInputTranscript(text) {
      send({ type: 'inputTranscript', text });
    },
    onOutputTranscript(text) {
      send({ type: 'outputTranscript', text });
    },
    onInterrupted() {
      send({ type: 'interrupted' });
    },
    onTurnComplete() {
      send({ type: 'turnComplete' });
    },
    onToolCall(name, args) {
      send({ type: 'toolCall', name, args });
    },
    onToolResult(name, result) {
      send({ type: 'toolResult', name, result });
    },
    onError(error) {
      send({ type: 'error', error });
    },
    onClose() {
      send({ type: 'sessionClosed' });
    },
    queryWatcher(prompt) {
      return watcher.query(prompt);
    },
  });

  function send(msg: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'audio':
          session.sendAudio(msg.data);
          break;
        case 'text':
          session.sendText(msg.text);
          break;
        case 'videoFrame':
          watcher.sendFrame(msg.data);
          break;
        case 'screenFrame':
          watcher.sendFrame(msg.data);
          break;
      }
    } catch (err) {
      console.error('[ws] bad message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    session.close();
    watcher.close();
  });

  // Start both connections
  watcher.connect();
  session.connect();
});

server.listen(PORT, () => {
  console.log(`\nHybrid prototype (Grok Eve + Gemini watcher) at http://localhost:${PORT}\n`);
});
