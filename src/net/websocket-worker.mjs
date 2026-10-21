import { EnvHttpProxyAgent } from 'undici';
import { createBoundedIpcWriter } from './websocket-process.mjs';

const LIMIT = 8 * 1024 * 1024;
let socket;
let dispatcher;
let started = false;
let ending = false;
const write = createBoundedIpcWriter((message, done) => process.send(message, done), { onFailure: () => fail() });
const post = (message, size = 256) => {
  if (!process.connected) return process.exit(1);
  try { write(message, size); }
  catch { process.exit(1); }
};
const fail = () => {
  if (ending) return;
  ending = true;
  if (!process.connected) return process.exit(1);
  setTimeout(() => process.exit(1), 50);
  try { process.send({ type: 'error' }, () => process.exit(1)); }
  catch { process.exit(1); }
};
process.on('disconnect', () => process.exit(1));
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.on('message', message => {
  try {
    if (!message || typeof message !== 'object') return fail();
    if (message.type === 'start' && !started) {
      started = true;
      const url = new URL(message.url);
      if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash
        || !Array.isArray(message.protocols) || message.protocols.length > 16
        || message.protocols.some(value => typeof value !== 'string' || value.length > 255)) return fail();
      dispatcher = new EnvHttpProxyAgent({ allowH2: false, noProxy: process.env.NO_PROXY ?? process.env.no_proxy });
      socket = new globalThis.WebSocket(url, { protocols: message.protocols, dispatcher });
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => post({ type: 'open', protocol: socket.protocol, extensions: socket.extensions }));
      socket.addEventListener('message', event => {
        if (ending) return;
        const data = event.data;
        const binary = data instanceof ArrayBuffer;
        if ((!binary && typeof data !== 'string') || (binary ? data.byteLength : Buffer.byteLength(data)) > LIMIT) return fail();
        post({ type: 'message', binary, data: binary ? Buffer.from(data) : data }, (binary ? data.byteLength : Buffer.byteLength(data)) + 256);
      });
      socket.addEventListener('error', fail);
      socket.addEventListener('close', event => {
        if (ending) return;
        ending = true;
        const message = { type: 'closed', code: event.code, clean: event.wasClean === true };
        if (!process.connected) return process.exit(0);
        try { process.send(message, () => process.exit(0)); }
        catch { process.exit(0); }
      });
      return;
    }
    if (!started || ending || !socket) return fail();
    if (message.type === 'send') {
      const data = message.data;
      if ((message.binary ? !Buffer.isBuffer(data) : typeof data !== 'string')
        || (message.binary ? data.byteLength : Buffer.byteLength(data)) > LIMIT
        || socket.bufferedAmount + (message.binary ? data.byteLength : Buffer.byteLength(data)) > LIMIT || socket.readyState !== WebSocket.OPEN) return fail();
      socket.send(data);
      return;
    }
    if (message.type === 'close') {
      if (message.code === undefined) socket.close();
      else socket.close(message.code, message.reason ?? '');
      return;
    }
    fail();
  } catch { fail(); }
});
