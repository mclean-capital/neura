import WebSocket from 'ws';
import { toolDefs, handleToolCall } from './tools.js';

const XAI_API_KEY = process.env.XAI_API_KEY;
if (!XAI_API_KEY) {
  console.error('XAI_API_KEY is required — set it in .env');
  process.exit(1);
}

const WS_URL = 'wss://api.x.ai/v1/realtime';

export interface SessionCallbacks {
  onAudio: (base64: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onError: (error: string) => void;
  onClose: () => void;
}

export function createGrokSession(cb: SessionCallbacks) {
  let ws: WebSocket | null = null;

  function connect() {
    ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });

    ws.on('open', () => {
      console.log('[grok] connected');
      ws!.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            voice: 'eve',
            instructions:
              'You are a helpful voice assistant. Be concise and conversational.',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              silence_duration_ms: 1000,
              prefix_padding_ms: 300,
            },
            tools: toolDefs,
          },
        }),
      );
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(msg);
      } catch (err) {
        console.error('[grok] parse error:', err);
      }
    });

    ws.on('error', (err) => {
      console.error('[grok] ws error:', err);
      cb.onError(err.message);
    });

    ws.on('close', () => {
      console.log('[grok] disconnected');
      cb.onClose();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMessage(msg: any) {
    // Debug: log all event types (except high-frequency audio)
    if (msg.type !== 'response.audio.delta') {
      console.log('[grok] event:', msg.type, msg.type === 'error' ? JSON.stringify(msg.error) : '');
    }

    switch (msg.type) {
      case 'session.created':
      case 'conversation.created':
        console.log('[grok] session ready');
        break;

      case 'session.updated':
        console.log('[grok] session configured');
        break;

      // Audio output
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (msg.delta) cb.onAudio(msg.delta);
        break;

      // Output transcription
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (msg.delta) cb.onOutputTranscript(msg.delta);
        break;

      // Input transcription
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) cb.onInputTranscript(msg.transcript);
        break;

      // User started speaking — interrupt playback
      case 'input_audio_buffer.speech_started':
        cb.onInterrupted();
        break;

      // Response complete
      case 'response.done':
        cb.onTurnComplete();
        break;

      // Function call
      case 'response.function_call_arguments.done':
        handleFunctionCallDone(msg);
        break;

      // Errors
      case 'error':
        console.error('[grok] error:', msg.error);
        cb.onError(msg.error?.message || 'Unknown error');
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleFunctionCallDone(msg: any) {
    const name: string = msg.name || '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(msg.arguments || '{}');
    } catch {
      /* malformed args */
    }

    cb.onToolCall(name, args);
    const result = handleToolCall(name, args);

    // Send function result back
    ws?.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: msg.call_id,
          output: JSON.stringify(result),
        },
      }),
    );

    // Trigger model to respond with the result
    ws?.send(JSON.stringify({ type: 'response.create' }));
  }

  function sendAudio(base64: string) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
    }
  }

  function sendText(text: string) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      }),
    );
    ws.send(JSON.stringify({ type: 'response.create' }));
  }

  function close() {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  return { connect, sendAudio, sendText, close };
}
