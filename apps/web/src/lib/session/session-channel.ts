/*
 * Sincronização de sessão entre abas (architecture.md §8.5 · authentication.md §4 · FA-03):
 * `BroadcastChannel('cf-session')`, sem persistência. Cada aba ignora as próprias mensagens.
 */

export const SESSION_CHANNEL = 'cf-session';

export type SessionEvent =
  | { readonly type: 'tenant-switched'; readonly tenantId: string }
  | { readonly type: 'logout' }
  | { readonly type: 'expired' };

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  if (value.type === 'logout' || value.type === 'expired') return true;
  return (
    value.type === 'tenant-switched' && 'tenantId' in value && typeof value.tenantId === 'string'
  );
}

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL);
}

export function publishSessionEvent(event: SessionEvent): void {
  const bc = channel();
  if (!bc) return;
  bc.postMessage(event);
  bc.close();
}

/** Assina os eventos das outras abas; devolve a função de cancelamento. */
export function subscribeSessionEvents(handler: (event: SessionEvent) => void): () => void {
  const bc = channel();
  if (!bc) return () => undefined;
  bc.onmessage = (message: MessageEvent<unknown>) => {
    if (isSessionEvent(message.data)) handler(message.data);
  };
  return () => {
    bc.close();
  };
}
