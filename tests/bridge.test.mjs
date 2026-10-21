import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createQueue, startBridge } from '../lib/bridge.js';

test('real loopback HTTP requires its own token, refuses browsers, and waits for a UI acknowledgement', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-rider-bridge-'));
  const bridge = await startBridge({ home });
  try {
    const properties = Object.fromEntries((await readFile(bridge.descriptor, 'utf8')).trim().split('\n').map(line => line.split('=')));
    assert.equal(Number(properties.port), bridge.port);
    assert.match(properties.token, /^[0-9a-f]{64}$/);
    const base = `http://127.0.0.1:${bridge.port}`;
    const headers = { authorization: `Bearer ${properties.token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/health`)).status, 401);
    const idleHealth = await fetch(`${base}/health`, { headers });
    assert.equal(idleHealth.status, 200);
    assert.equal((await idleHealth.json()).clientReady, false);
    assert.equal((await fetch(`${base}/health`, { headers: { ...headers, origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${base}/open`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), projectPath: home, prompt: 'x'.repeat(8192) }) })).status, 413);
    const requestId = randomUUID();
    const clientId = randomUUID();
    const response = fetch(`${base}/open`, { method: 'POST', headers, body: JSON.stringify({ requestId, projectPath: home, prompt: '只准备草稿' }) });
    let job;
    for (let attempt = 0; attempt < 30 && !job; attempt++) { await new Promise(resolve => setTimeout(resolve, 5)); job = bridge.queue.take(clientId); }
    assert.equal(job.requestId, requestId);
    assert.equal((await (await fetch(`${base}/health`, { headers })).json()).clientReady, true);
    bridge.queue.complete(requestId, clientId, job.lease, JSON.stringify({ ok: true, sessionId: 'new-session', workspaceId: 'workspace' }));
    const accepted = await response;
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, requestId, sessionId: 'new-session', workspaceId: 'workspace' });
  } finally {
    await bridge.dispose();
    await assert.rejects(readFile(bridge.descriptor), { code: 'ENOENT' });
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('dsh-rider-bridge-'));
    await rm(home, { recursive: true });
  }
});

test('queue deduplicates requests and leases work to exactly one renderer', async () => {
  const queue = createQueue();
  try {
    const request = { requestId: randomUUID(), projectPath: path.resolve('.'), prompt: 'hello' };
    const first = queue.enqueue(request);
    assert.equal(queue.enqueue({ ...request }), first);
    assert.throws(() => queue.enqueue({ ...request, prompt: 'changed' }), /different context/);
    const clientId = randomUUID();
    const job = queue.take(clientId);
    assert.deepEqual(queue.take(clientId), job);
    assert.equal(queue.take(randomUUID()), null);
    assert.throws(() => queue.complete(job.requestId, randomUUID(), job.lease, '{}'), /not owned/);
    queue.complete(job.requestId, clientId, job.lease, JSON.stringify({ ok: true, sessionId: 's', workspaceId: 'w' }));
    assert.equal((await first).status, 200);
    assert.deepEqual(queue.complete(job.requestId, clientId, job.lease, '{}'), { acknowledged: true });
    assert.equal(queue.take(clientId), null);
  } finally { queue.dispose(); }
});

test('UI deadline and disposal resolve waiting IDE requests', async () => {
  const queue = createQueue({ timeoutMs: 15 });
  const result = await queue.enqueue({ requestId: randomUUID(), projectPath: path.resolve('.'), prompt: '' });
  assert.equal(result.status, 504);
  const second = queue.enqueue({ requestId: randomUUID(), projectPath: path.resolve('.'), prompt: '' });
  queue.dispose();
  assert.equal((await second).status, 503);
});
