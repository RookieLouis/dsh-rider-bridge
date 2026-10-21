import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BRIDGE_REMOTE_CONTRIBUTION } from '../src/client.js';

assert.ok(process.versions.electron, 'Run with Desktop Electron in Node mode.');
const packageRoot = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
const nativeImport = name => import(pathToFileURL(path.join(packageRoot, name, 'lib', 'index.js')).href);
const cordis = await nativeImport('cordis');
const { createRuntimeResolution, PluginPackages, evaluatePluginCompatibility } = await nativeImport('dsh-app-boot');
const { createLaunchEnvironmentSnapshot } = await nativeImport('dsh-launch-environment');
const { TypertRegistry } = await nativeImport('dsh-typert-registry');
const { TypertGatewayService } = await nativeImport('dsh-api-gateway');
const { RemoteAccessService } = await nativeImport('dsh-api-remote-access');
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = new cordis.Context();
const client = new cordis.Context();
const temporaryHome = mkdtempSync(path.join(os.tmpdir(), 'dsh-rider-native-'));
let offRemote;
try {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const version = JSON.parse(readFileSync(path.join(packageRoot, 'dsh', 'package.json'), 'utf8')).version;
  assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined);
  const resolution = await createRuntimeResolution({ installAnchor: path.join(packageRoot, 'dsh', 'package.json'), home: temporaryHome });
  await host.plugin(PluginPackages, { resolution: { ...resolution, linkedRoots: [{ name: 'dsh-rider-bridge', realPath: pluginRoot }] } }).await();
  await host.plugin(TypertRegistry).await();
  await host.plugin(RemoteAccessService).await();
  await host.plugin(TypertGatewayService).await();
  host.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: temporaryHome } }]));
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'index.js')).href);
  await host.plugin(plugin).await();
  const gateway = host.get('typertGateway');
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const direct = (method, args) => gateway.invoke({ namespace: 'dshIdeBridge', method, args, peer });
  let browserGateway;
  const gatewayManifest = JSON.parse(readFileSync(path.join(packageRoot, 'dsh-api-gateway', 'package.json'), 'utf8'));
  const clientExport = gatewayManifest.exports['./client'];
  const clientEntry = typeof clientExport === 'string' ? clientExport : clientExport.browser || clientExport.default;
  vm.runInNewContext(readFileSync(path.join(packageRoot, 'dsh-api-gateway', clientEntry), 'utf8'), {
    window: { __ModuleLoader__: { load(definition) { browserGateway = definition.factory(name => { assert.equal(name, '@deepseek-ai/cordis'); return cordis; }); } } },
    console, AbortController, AbortSignal, TextDecoder, TextEncoder, crypto: globalThis.crypto, setTimeout, clearTimeout, performance,
  });
  await client.plugin(TypertRegistry).await();
  client.provide('connection', {
    isLoopback: true,
    generation: { getSnapshot: () => ({ host: { home: 'isolated' } }), subscribe: () => () => {} },
    registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
    rpc: { open: () => (async function* () {})(), async call(base, endpoint, payload) {
      assert.equal(base, '/api');
      const method = endpoint.split('/')[1];
      try { return { ok: true, value: await direct(method, payload.args) }; }
      catch (error) { return { ok: false, error: { code: error.code || 'gateway/internal', message: error.message, details: {} } }; }
    } },
  });
  await client.plugin(browserGateway).await();
  offRemote = await client.remote.$mount(BRIDGE_REMOTE_CONTRIBUTION);
  const remote = client.get('remote.dshIdeBridge');
  const clientId = randomUUID();
  const requestId = randomUUID();
  const properties = Object.fromEntries(readFileSync(path.join(temporaryHome, 'ide-bridge', 'desktop.properties'), 'utf8').trim().split('\n').map(line => line.split('=')));
  const completion = fetch(`http://127.0.0.1:${properties.port}/open`, { method: 'POST', headers: { authorization: `Bearer ${properties.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId, projectPath: pluginRoot, prompt: '只准备草稿' }) });
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await remote.take(clientId);
    if (result.ok && result.value) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(result.ok, true);
  assert.equal(result.value.requestId, requestId);
  const ack = await remote.complete(requestId, clientId, result.value.lease, JSON.stringify({ ok: true, sessionId: 'new-session', workspaceId: 'w' }));
  assert.equal(ack.ok, true);
  const httpResult = await completion;
  assert.equal(httpResult.status, 200);
  assert.equal((await httpResult.json()).sessionId, 'new-session');
  // Check the installed product implements the precise native APIs used by our fixture.
  const workspaceClient = readFileSync(path.join(packageRoot, 'dsh-api-workspace-controller', 'lib', 'client.js'), 'utf8');
  const sessionClient = readFileSync(path.join(packageRoot, 'dsh-api-session-controller', 'lib', 'client.js'), 'utf8');
  const conversationClient = readFileSync(path.join(packageRoot, 'dsh-client-ui-conversation', 'lib', 'client.js'), 'utf8');
  const navigationClient = readFileSync(path.join(packageRoot, 'dsh-client-ui-workspace', 'lib', 'client.js'), 'utf8');
  assert.match(workspaceClient, /async create\(input\)/);
  assert.match(sessionClient, /async create\(opts = \{\}\)/);
  assert.match(conversationClient, /requestDraftInitialization\(binding, options\)/);
  assert.match(navigationClient, /openSession\(target\)/);
  assert.match(navigationClient, /source: "workspaceOperation"|source: "mainView"/);
  const runtime = JSON.parse(readFileSync(path.join(packageRoot, 'dsh-api-gateway', 'package.json'), 'utf8')).version;
  console.log(JSON.stringify({ passed: true, runtime, checks: ['native package compatibility and complete Host load', 'authenticated real loopback HTTP', 'native Host SRC dispatch', 'native Client $mount and named arguments', 'claim and acknowledgement round trip', 'installed native workspace/Session/composer/navigation API contracts'] }));
} finally {
  await offRemote?.();
  await client.fiber.dispose();
  await host.fiber.dispose();
  assert.equal(path.dirname(temporaryHome), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryHome).startsWith('dsh-rider-native-'));
  rmSync(temporaryHome, { recursive: true });
}
