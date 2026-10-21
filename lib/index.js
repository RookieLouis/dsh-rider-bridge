import path from 'node:path';
import { homedir } from 'node:os';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { startBridge } from './bridge.js';
import { installRemote } from './remote.js';

export const name = 'dsh-rider-bridge';
export async function apply(ctx) {
  const env = launchEnvironmentOf(ctx);
  const home = path.resolve(env.get('DSH_HOME')?.value || process.env.DSH_HOME || path.join(homedir(), '.dsh'));
  const bridge = await startBridge({ home });
  ctx.effect(() => () => bridge.dispose(), 'dsh-rider-bridge loopback cleanup');
  await installRemote(ctx, bridge.queue).await();
}
