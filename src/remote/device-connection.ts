import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DeviceExecutor } from './device-executor.js';
import { executeSchema, MAX_WIRE_BYTES, type DeviceResult } from './protocol.js';

const controlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), epoch: z.string().uuid() }).strict(),
  z.object({ type: z.literal('ack'), epoch: z.string().uuid(), operationId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('heartbeat'), epoch: z.string().uuid() }).strict(),
]);

export function deviceUrl(endpoint: string) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Expected a bare relay origin');
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) url.protocol = 'ws:';
  else throw new Error('Device relay requires HTTPS (HTTP is allowed only for loopback tests)');
  url.pathname = '/device';
  return url.href;
}

/** Reconnects the channel only. Terminal commands are never replayed here. */
export async function runDeviceConnection(executor: DeviceExecutor, endpoint: string, token: string,
  signal: AbortSignal, report: (state: 'connected' | 'disconnected') => void = () => {}) {
  const url = deviceUrl(endpoint);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('Expected a randomly generated device token');
  const pending = new Map<string, DeviceResult>();
  let inFlight = 0;
  let retryMs = 1000;
  let active: WebSocket | undefined;
  let activeReady = false;
  while (!signal.aborted) {
    let fatal: Error | undefined;
    await new Promise<void>(resolve => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` },
        maxPayload: MAX_WIRE_BYTES, perMessageDeflate: false, handshakeTimeout: 10000,
        followRedirects: false });
      active = socket;
      activeReady = false;
      let ready = false;
      let pong = true;
      const handshake = setTimeout(() => { if (!ready) socket.terminate(); }, 15000);
      const abort = () => { socket.terminate(); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const send = (value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
      const heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!pong) return socket.terminate();
        pong = false;
        socket.ping();
        if (ready) send({ type: 'heartbeat', epoch: executor.epoch });
      }, 15000);
      socket.on('pong', () => { pong = true; });
      socket.on('open', () => send({ type: 'hello', epoch: executor.epoch }));
      socket.on('message', (data, binary) => {
        void (async () => {
          if (binary || signal.aborted) throw new Error('Invalid frame');
          const raw: unknown = JSON.parse(data.toString());
          const control = controlSchema.safeParse(raw);
          if (control.success) {
            if (control.data.epoch !== executor.epoch) throw new Error('Wrong epoch');
            if (control.data.type === 'ready') {
              if (ready) throw new Error('Repeated handshake');
              ready = true; activeReady = true; clearTimeout(handshake); retryMs = 1000; report('connected');
              for (const result of pending.values()) send(result);
            } else if (control.data.type === 'ack') {
              if (!ready) throw new Error('Acknowledgement before handshake');
              pending.delete(control.data.operationId);
            }
            return;
          }
          if (!ready || pending.size + inFlight >= 32) throw new Error('Device is not ready for more work');
          const request = executeSchema.parse(raw);
          if (request.epoch !== executor.epoch) throw new Error('Wrong epoch');
          inFlight++;
          try {
            const result = await executor.execute(request);
            pending.set(result.operationId, result);
            // The operation may finish after its original socket was replaced.
            if (activeReady && active?.readyState === WebSocket.OPEN) active.send(JSON.stringify(result));
          } finally { inFlight--; }
        })().catch(() => { socket.close(1002, 'Invalid or unserviceable relay message'); });
      });
      // No raw socket errors or payloads are logged: they may contain headers.
      socket.on('error', () => { ready = false; if (active === socket) activeReady = false; });
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        if ([401, 403, 409].includes(response.statusCode ?? 0)) {
          fatal = new Error(`Device connection rejected (HTTP ${response.statusCode}); check pairing or another active device process`);
        }
        socket.terminate();
      });
      socket.once('close', code => {
        if ([1002, 1008].includes(code)) fatal = new Error(`Device protocol rejected (WebSocket ${code}); check relay/device versions and configuration`);
        if (active === socket) { active = undefined; activeReady = false; }
        clearTimeout(handshake);
        clearInterval(heartbeat);
        signal.removeEventListener('abort', abort);
        report('disconnected');
        resolve();
      });
    });
    if (fatal) throw fatal;
    if (!signal.aborted) {
      try { await delay(retryMs, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
      retryMs = Math.min(10000, retryMs * 2);
    }
  }
}
