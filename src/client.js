const stringParameter = name => ({ name, wire: name, source: 'json', codec: {
  mode: 'strict', typeSymbol: 'string', create: () => ({ parse(value) { if (typeof value !== 'string') throw new TypeError('Expected string'); return value; } }),
} });

export const BRIDGE_REMOTE_CONTRIBUTION = {
  package: 'dsh-rider-bridge',
  descriptors: [
    { method: 'take', parameters: ['clientId'] },
    { method: 'complete', parameters: ['requestId', 'clientId', 'lease', 'resultJson'] },
  ].map(({ method, parameters }) => ({
    id: `dsh-rider-bridge#dshIdeBridge/${method}`, service: 'dshIdeBridge', namespace: 'dshIdeBridge', method,
    invocation: { kind: 'direct' }, parameters: parameters.map(stringParameter), result: { mode: 'src-json' },
  })),
};

function rpcValue(result) {
  if (result?.ok === true) return result.value;
  throw new Error(result?.error?.message || 'DSH IDE bridge is unavailable.');
}

/** Native Session and composer APIs only. No prompt admission or Send operation. */
export async function prepareDraft(ctx, job, { now = Date.now, signal } = {}) {
  const check = () => {
    signal?.throwIfAborted();
    if (now() >= job.expiresAt) throw new Error('IDE handoff expired before the draft was prepared.');
  };
  check();
  const navigation = ctx.layout.beginNavigation();
  const checkCurrent = () => { check(); navigation.throwIfAborted(); };
  const workspace = await ctx.workspaces.create({ path: job.projectPath });
  checkCurrent();
  // Omit sessionId: even an existing blank with unsent user text must stay intact.
  const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
  checkCurrent();
  const reference = ctx.sessions.retain(sessionId, { source: 'workspaceOperation' });
  try {
    checkCurrent();
    const binding = ctx.sessions.binding(sessionId);
    if (!binding) throw new Error('New DSH Session has no retained binding.');
    if (job.prompt !== '') {
      const prepared = ctx.conversation.input.requestDraftInitialization(binding, { prompt: job.prompt, clearPreviousDraft: false });
      if (prepared !== 'applied') throw new Error('The new DSH draft could not be prepared without replacing existing input.');
    }
    ctx.uiWorkspace.openSession(sessionId);
    return { ok: true, sessionId, workspaceId: workspace.workspaceId };
  } finally { reference.release(); }
}

/** One serial consumer per renderer; repeated delivery only repeats the acknowledgement. */
export function createConsumer({ ctx, remote, clientId, signal, timers = globalThis, now = Date.now }) {
  const completed = new Map();
  let timer;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (ctx.workspaces.list.getSnapshot().phase !== 'ready' || ctx.sessions.list.getSnapshot().phase !== 'ready') return;
      const job = rpcValue(await remote.take(clientId));
      if (!job || stopped) return;
      let result = completed.get(job.requestId);
      if (!result) {
        try { result = await prepareDraft(ctx, job, { now, signal }); }
        catch (error) { result = { ok: false, message: String(error?.message || error) }; }
        completed.set(job.requestId, result);
        while (completed.size > 128) completed.delete(completed.keys().next().value);
      }
      if (!stopped) rpcValue(await remote.complete(job.requestId, clientId, job.lease, JSON.stringify(result)));
    } catch (error) {
      // A transient connection loss is retried; the Host deadline resolves the IDE.
    } finally {
      running = false;
      if (!stopped) timer = timers.setTimeout(tick, 500);
    }
  };
  return {
    start() { void tick(); },
    stop() { stopped = true; if (timer !== undefined) timers.clearTimeout(timer); },
    tick,
  };
}

export function createBridgeClient(globals = globalThis) {
  return {
    inject: ['remote', 'uiWorkspace', 'sessions', 'workspaces', 'conversation', 'layout'],
    async apply(ctx) {
      const offRemote = await ctx.remote.$mount(BRIDGE_REMOTE_CONTRIBUTION);
      const lifetime = new AbortController();
      const consumer = createConsumer({ ctx, remote: ctx.get('remote.dshIdeBridge'), clientId: globals.crypto.randomUUID(), signal: lifetime.signal, timers: globals });
      ctx.effect(() => {
        consumer.start();
        return () => { lifetime.abort(); consumer.stop(); };
      }, 'dsh-rider-bridge draft handoff');
      return offRemote;
    },
  };
}
