// DSH 0.2.x slash RPC + remote.mux. No browser/log scanning or credentials export.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import WebSocket from 'ws';

export function hostError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
export function redact(message) {
  return String(message).replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/([?&](?:token|key|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:authorization|cookie|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}
export function localBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw hostError('DSH 地址必须是没有凭据、路径或查询参数的本机 HTTP(S) 地址', 'INVALID_BASE_URL');
  }
  if (!(url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))) {
    throw hostError('接入入口仅支持本机 DSH；不会向远程地址传递登录会话', 'NONLOCAL_HOST');
  }
  return url.origin;
}
function sessionCookie(baseUrl, dshHome) {
  let doc;
  try { doc = yaml.load(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8'), { schema: yaml.JSON_SCHEMA }); }
  catch { throw hostError('无法读取已授权的本机 DSH 会话；核对 --dsh-home 或使用 DSH_AUTH_COOKIE / DSH_LAUNCH_TOKEN', 'AUTH_REQUIRED'); }
  const record = doc?.records?.['client-connection/browser-session'];
  const encoded = record?.payload?.secret;
  const key = typeof encoded === 'string' ? Buffer.from(encoded, 'base64url') : Buffer.alloc(0);
  if (record?.kind !== 'grant' || record?.payload?.version !== 1 || key.length !== 32) {
    throw hostError('本机 DSH 会话格式不受支持；使用当前启动链接的 DSH_LAUNCH_TOKEN', 'UNSUPPORTED_AUTH');
  }
  const authority = new URL(baseUrl).host;
  const issuedAt = Date.now();
  const payload = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 600000 })).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}=v1.${payload}.${signature}`;
}
export class DshClient {
  constructor({ baseUrl = process.env.DSH_BASE_URL ?? 'http://127.0.0.1:3080',
    cookie = process.env.DSH_AUTH_COOKIE, token = process.env.DSH_LAUNCH_TOKEN,
    useLocalSession = false, dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), timeoutMs = 10000 } = {}) {
    this.baseUrl = localBase(baseUrl);
    this.cookie = cookie;
    this.token = token;
    this.useLocalSession = useLocalSession;
    this.dshHome = dshHome;
    this.timeoutMs = timeoutMs;
  }
  async authenticate() {
    if (this.cookie) return;
    if (this.useLocalSession) { this.cookie = sessionCookie(this.baseUrl, this.dshHome); return; }
    if (!this.token) throw hostError('需要 DSH 登录授权：设置 DSH_AUTH_COOKIE / DSH_LAUNCH_TOKEN，或经允许使用 --use-local-session', 'AUTH_REQUIRED');
    const url = new URL('/', this.baseUrl);
    url.searchParams.set('token', this.token);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).find(s => s.startsWith('dsh-auth-'));
    await response.body?.cancel();
    if (!cookie) throw hostError('DSH 启动授权已失效；重新取得当前启动链接', 'AUTH_FAILED', { status: response.status });
    this.cookie = cookie;
  }
  async callUnary(method, payload = {}, signal) {
    await this.authenticate();
    const endpoint = method.replaceAll('.', '/');
    const empty = new Set(['session/modelCatalog', 'session/models', 'host/describe', 'agentPresets/list']);
    const request = endpoint === 'session/prompt' ? { ...payload, requestId: payload.requestId ?? randomUUID() } : payload;
    const args = empty.has(endpoint) ? {} : ['commands/list', 'commands/execute'].includes(endpoint) ? request
      : { [endpoint === 'session/list' ? '_request' : 'request']: request };
    const rpcId = randomUUID();
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', cookie: this.cookie },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
      });
    } catch (error) { throw hostError('DSH 请求超时或连接中断', error.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw hostError(`DSH 接口返回 HTTP ${response.status}`, response.status === 401 ? 'AUTH_FAILED' : 'HOST_HTTP', { status: response.status });
    }
    let envelope;
    try { envelope = await response.json(); }
    catch { throw hostError('DSH 未返回有效 RPC 信封', 'UNSUPPORTED_PROTOCOL'); }
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') {
      throw hostError('DSH RPC 协议不受支持；需要 slash RPC + remote.mux 宿主', 'UNSUPPORTED_PROTOCOL');
    }
    return envelope;
  }
  async rpc(method, payload, signal) {
    const envelope = await this.callUnary(method, payload, signal);
    if (!envelope.result.ok) {
      const error = envelope.result.error ?? {};
      throw hostError(redact(error.message ?? `${method} 失败`), error.code ?? 'HOST_REJECTED', { status: error.status });
    }
    return envelope.result.value;
  }
  async catalog() {
    const catalog = await this.rpc('session/modelCatalog');
    if (!Array.isArray(catalog?.groups)) throw hostError('DSH 模型目录格式不受支持', 'UNSUPPORTED_CATALOG');
    return catalog;
  }
  // Readiness means session/follow has delivered its baseline, not merely that
  // the TCP socket is open. A closed stream is terminal; prompts are never replayed.
  async follow(sessionId, onEvent, { signal } = {}) {
    await this.authenticate();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie }, followRedirects: false, maxPayload: 16 * 1024 * 1024 });
    const streamId = randomUUID();
    let ready = false, ended = false, resolveReady, rejectReady;
    const opened = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => fail(hostError('DSH 事件订阅未就绪，未提交任务', 'FOLLOW_TIMEOUT')), this.timeoutMs);
    const close = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      socket.on('error', () => {});
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
      if (!ready) rejectReady(hostError('事件订阅已取消', 'FOLLOW_CLOSED'));
    };
    const fail = error => {
      if (ended) return;
      if (!ready) rejectReady(error); else onEvent({ type: 'stream/error', data: { error: { code: error.code } } });
      close();
    };
    const abort = () => fail(hostError('事件订阅已取消', 'ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: {
      args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } }
    } })));
    socket.on('message', bytes => {
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.streamId !== streamId) return;
        if (frame.type === 'end' || frame.type === 'error') { fail(hostError(redact(frame.error?.message ?? 'DSH 会话事件流已结束'), frame.error?.code ?? 'STREAM_CLOSED')); return; }
        if (frame.type !== 'item') return;
        if (frame.value?.type === 'snapshot') {
          if (!ready) { ready = true; clearTimeout(timeout); resolveReady(); }
          return;
        }
        if (frame.value?.type === 'event' && ready) onEvent(frame.value.event);
      } catch { fail(hostError('DSH 事件流格式不受支持', 'UNSUPPORTED_EVENT')); }
    });
    socket.on('error', () => fail(hostError('DSH 事件连接失败', 'TRANSPORT')));
    socket.on('close', () => fail(hostError('DSH 事件连接中断', 'STREAM_CLOSED')));
    if (signal?.aborted) abort();
    try { await opened; return { close }; }
    catch (error) { close(); throw error; }
  }
  async stopOwnedSession(sessionId) {
    // Only used for the runner's newly-created session. Never accept a caller's
    // existing chat here or assume cancel success proves side effects absent.
    try {
      const projection = await this.rpc('session/projections', { sessionId });
      const inbox = projection?.values?.inbox;
      if (!inbox || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) throw new Error('unknown inbox');
      for (const item of [...inbox['next-turn'], ...inbox['next-step']]) {
        if (typeof item.id !== 'string') throw new Error('unknown inbox item');
        await this.rpc('session/updateQueue', { sessionId, itemId: item.id, action: { kind: 'remove' } });
      }
    } catch {
      await this.rpc('session/cancel', { sessionId }).catch(() => {});
      return false;
    }
    try {
      await this.rpc('session/cancel', { sessionId });
      const projection = await this.rpc('session/projections', { sessionId });
      const values = projection?.values;
      return projection === null || values?.agent?.status === 'idle'
        && values.inbox?.['next-turn']?.length === 0 && values.inbox?.['next-step']?.length === 0;
    } catch { return false; }
  }
}
