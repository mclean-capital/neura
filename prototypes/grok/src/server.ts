import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createGrokSession } from './session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(join(__dirname, '../public')));

wss.on('connection', (ws: WebSocket) => {
  console.log('[ws] client connected');

  const session = createGrokSession({
    onAudio(data: string) {
      send({ type: 'audio', data });
    },
    onInputTranscript(text: string) {
      send({ type: 'inputTranscript', text });
    },
    onOutputTranscript(text: string) {
      send({ type: 'outputTranscript', text });
    },
    onInterrupted() {
      send({ type: 'interrupted' });
    },
    onTurnComplete() {
      send({ type: 'turnComplete' });
    },
    onToolCall(name: string, args: Record<string, unknown>) {
      send({ type: 'toolCall', name, args });
    },
    onError(error: string) {
      send({ type: 'error', error });
    },
    onClose() {
      send({ type: 'sessionClosed' });
    },
  });

  function send(msg: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
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
      }
    } catch (err) {
      console.error('[ws] bad message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    session.close();
  });

  session.connect();
});

server.listen(PORT, () => {
  console.log(`\nGrok Voice prototype running at http://localhost:${PORT}\n`);
});
