import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareDraft, createConsumer } from '../src/client.js';

function fixture() {
  const calls = [];
  const existing = { draft: '用户正在写的草稿', attachments: ['image'] };
  const controller = new AbortController();
  const binding = { sessionId: 'fresh' };
  const ctx = {
    layout: { beginNavigation: () => controller.signal },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready' }) }, create: async input => { calls.push(['workspace', input]); return { workspaceId: 'w' }; } },
    sessions: {
      list: { getSnapshot: () => ({ phase: 'ready' }) },
      create: async input => { calls.push(['create', input]); return 'fresh'; },
      retain: (id, options) => { calls.push(['retain', id, options]); return { release: () => calls.push(['release']) }; },
      binding: () => binding,
    },
    conversation: { input: { requestDraftInitialization: (target, options) => { calls.push(['draft', target, options]); return 'applied'; } } },
    uiWorkspace: { openSession: id => calls.push(['open', id]) },
  };
  return { ctx, calls, existing, controller, binding, job: { requestId: randomUUID(), projectPath: 'D:\\Project', prompt: '查看 @Source/Main.cpp:3', expiresAt: Date.now() + 10000, lease: 'lease' } };
}

test('native API fixture creates workspace and fresh Session, prepares its draft and opens it without sending', async () => {
  const { ctx, calls, existing, binding, job } = fixture();
  assert.deepEqual(await prepareDraft(ctx, job), { ok: true, sessionId: 'fresh', workspaceId: 'w' });
  assert.deepEqual(calls, [
    ['workspace', { path: job.projectPath }], ['create', { workspaceId: 'w' }],
    ['retain', 'fresh', { source: 'workspaceOperation' }],
    ['draft', binding, { prompt: job.prompt, clearPreviousDraft: false }], ['open', 'fresh'], ['release'],
  ]);
  assert.deepEqual(existing, { draft: '用户正在写的草稿', attachments: ['image'] });
  assert.equal(Object.hasOwn(ctx.sessions, 'prompt'), false);
});

test('later user navigation cancels the handoff before a draft or selection changes', async () => {
  const { ctx, calls, controller, job } = fixture();
  ctx.sessions.create = async () => { controller.abort(); return 'fresh'; };
  await assert.rejects(prepareDraft(ctx, job), { name: 'AbortError' });
  assert.deepEqual(calls.map(call => call[0]), ['workspace']);
});

test('blocked initialization releases its reference and never opens or overwrites the composer', async () => {
  const { ctx, calls, job } = fixture();
  ctx.conversation.input.requestDraftInitialization = () => 'blocked';
  await assert.rejects(prepareDraft(ctx, job), /without replacing/);
  assert.equal(calls.some(call => call[0] === 'open'), false);
  assert.equal(calls.at(-1)[0], 'release');
});

test('duplicate delivery after lost acknowledgement creates only one Session', async () => {
  const { ctx, calls, job } = fixture();
  const timers = { setTimeout: () => 1, clearTimeout() {} };
  let acknowledgements = 0;
  const remote = { take: async () => ({ ok: true, value: job }), complete: async () => { acknowledgements++; if (acknowledgements === 1) throw new Error('connection dropped'); return { ok: true, value: {} }; } };
  const consumer = createConsumer({ ctx, remote, clientId: randomUUID(), timers });
  await consumer.tick();
  await consumer.tick();
  consumer.stop();
  assert.equal(acknowledgements, 2);
  assert.equal(calls.filter(call => call[0] === 'create').length, 1);
});
