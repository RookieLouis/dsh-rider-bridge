import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export function installRemote(ctx, queue) {
  const initializers = [];
  class IdeBridgeRemote extends TypertRemoteService {
    constructor(owner) {
      super(owner, 'dshIdeBridge');
      for (const initialize of initializers) initialize.call(this);
    }
    take(clientId) { return queue.take(clientId); }
    complete(requestId, clientId, lease, resultJson) { return queue.complete(requestId, clientId, lease, resultJson); }
  }
  for (const method of ['take', 'complete']) Remote(method)(IdeBridgeRemote.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer: initialize => initializers.push(initialize),
  });
  return ctx.plugin(IdeBridgeRemote);
}
