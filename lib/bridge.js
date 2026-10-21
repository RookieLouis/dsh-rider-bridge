import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 8192;
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const validId = value => typeof value === 'string' && UUID.test(value);
const failure = error => ({ ok: false, code: error.code || 'bridge/error', message: error.message || String(error) });

/** A bounded local handoff queue. Only the DSH Client may claim and acknowledge work. */
export function createQueue({ timeoutMs = 60000, historyLimit = 128, now = Date.now } = {}) {
  const entries = new Map();
  let disposed = false;
  let lastClientPoll = 0;
  const finish = (entry, result) => {
    if (entry.result) return;
    clearTimeout(entry.timer);
    entry.result = result;
    entry.resolve(result);
  };
  return {
    enqueue(request) {
      if (disposed) throw fault(503, 'bridge/stopped', 'DSH bridge is stopping.');
      const prior = entries.get(request.requestId);
      if (prior) {
        if (prior.projectPath !== request.projectPath || prior.prompt !== request.prompt) throw fault(409, 'bridge/id-reused', 'Request ID was already used for different context.');
        return prior.promise;
      }
      const pending = [...entries.values()].filter(entry => !entry.result);
      if (pending.length >= 8) throw fault(429, 'bridge/busy', 'Too many pending IDE requests.');
      while (entries.size >= historyLimit) {
        const completed = [...entries].find(([, entry]) => entry.result);
        if (!completed) break;
        entries.delete(completed[0]);
      }
      const entry = { ...request, expiresAt: now() + timeoutMs, lease: randomBytes(24).toString('hex') };
      entry.promise = new Promise(resolve => { entry.resolve = resolve; });
      entry.timer = setTimeout(() => finish(entry, { status: 504, body: { ok: false, code: 'bridge/ui-timeout', message: 'DSH did not prepare the draft in time. Reopen DSH and retry.' } }), timeoutMs);
      entries.set(entry.requestId, entry);
      return entry.promise;
    },
    take(clientId) {
      if (!validId(clientId)) throw new TypeError('Invalid client ID.');
      lastClientPoll = now();
      const owned = [...entries.values()].find(entry => !entry.result && entry.clientId === clientId);
      const entry = owned || [...entries.values()].find(candidate => !candidate.result && !candidate.clientId);
      if (!entry || entry.expiresAt <= now()) return null;
      entry.clientId = clientId;
      return { requestId: entry.requestId, projectPath: entry.projectPath, prompt: entry.prompt, expiresAt: entry.expiresAt, lease: entry.lease };
    },
    complete(requestId, clientId, lease, resultJson) {
      if (!validId(requestId) || !validId(clientId)) throw new TypeError('Invalid request or client ID.');
      const entry = entries.get(requestId);
      if (!entry || entry.clientId !== clientId || entry.lease !== lease) throw new Error('Handoff lease is not owned by this client.');
      if (entry.result) return { acknowledged: true };
      if (typeof resultJson !== 'string' || Buffer.byteLength(resultJson) > 4096) throw new TypeError('Invalid completion.');
      const result = JSON.parse(resultJson);
      if (result.ok === true) {
        if (typeof result.sessionId !== 'string' || !result.sessionId || typeof result.workspaceId !== 'string' || !result.workspaceId) throw new TypeError('Missing prepared Session identity.');
        finish(entry, { status: 200, body: { ok: true, requestId, sessionId: result.sessionId, workspaceId: result.workspaceId } });
      } else {
        finish(entry, { status: 409, body: { ok: false, requestId, code: 'bridge/preparation-failed', message: String(result.message || 'DSH could not prepare the draft.').slice(0, 1000) } });
      }
      return { acknowledged: true };
    },
    status() { return { clientReady: !disposed && lastClientPoll > 0 && now() - lastClientPoll < 3000 }; },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) finish(entry, { status: 503, body: { ok: false, code: 'bridge/stopped', message: 'DSH bridge stopped before completing the handoff.' } });
    },
  };
}

async function readRequest(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw fault(413, 'bridge/too-large', 'IDE context exceeds 8 KB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw fault(413, 'bridge/too-large', 'IDE context exceeds 8 KB.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fault(400, 'bridge/invalid-json', 'Expected a JSON request.'); }
  if (!value || !validId(value.requestId) || typeof value.projectPath !== 'string' || !path.isAbsolute(value.projectPath) || value.projectPath.includes('\0') || typeof value.prompt !== 'string') throw fault(400, 'bridge/invalid-request', 'Expected requestId, absolute projectPath and prompt.');
  const directory = await stat(value.projectPath).catch(() => null);
  if (!directory?.isDirectory()) throw fault(400, 'bridge/project-missing', 'IDE project directory does not exist.');
  return { requestId: value.requestId, projectPath: path.resolve(value.projectPath), prompt: value.prompt };
}

/** Own a loopback-only endpoint with its own secret; never reads Harness credentials. */
export async function startBridge({ home, queue = createQueue() }) {
  const token = randomBytes(32).toString('hex');
  const directory = path.join(home, 'ide-bridge');
  const descriptor = path.join(directory, 'desktop.properties');
  let stopped = false;
  const send = (response, status, body) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    try {
      // Browsers do not need this endpoint; the native IDE supplies no Origin.
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) throw fault(403, 'bridge/browser-refused', 'Browser requests are not accepted.');
      const expected = Buffer.from(`Bearer ${token}`);
      const supplied = Buffer.from(request.headers.authorization || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fault(401, 'bridge/unauthorized', 'Missing or invalid bridge authorization.');
      if (request.url === '/health' && request.method === 'GET') { send(response, 200, { ok: true, protocolVersion: 1, ...queue.status() }); return; }
      if (request.url !== '/open' || request.method !== 'POST') throw fault(404, 'bridge/not-found', 'Unknown bridge endpoint.');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw fault(415, 'bridge/content-type', 'Expected application/json.');
      const result = await queue.enqueue(await readRequest(request));
      send(response, result.status, result.body);
    } catch (error) { send(response, error.status || 500, failure(error)); }
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const content = `port=${port}\ntoken=${token}\n`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${descriptor}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, descriptor);
  } catch (error) { queue.dispose(); server.close(); throw error; }
  return {
    queue,
    port,
    descriptor,
    async dispose() {
      if (stopped) return;
      stopped = true;
      queue.dispose();
      await new Promise(resolve => server.close(resolve));
      if (await readFile(descriptor, 'utf8').catch(() => '') === content) await unlink(descriptor).catch(() => {});
    },
  };
}
