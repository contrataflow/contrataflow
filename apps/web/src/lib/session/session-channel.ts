/*
 * Sincronização de sessão entre abas (architecture.md §8.5 · authentication.md §4 · RN-IAM-29):
 * `BroadcastChannel('cf-session')`, sem persistência. `logout` leva as outras abas à SCR-001;
 * `expired` abre o modal nelas; `extended` ("Continuar conectado") reinicia o contador de todas
 * com o novo prazo de ociosidade. Cada aba ignora as próprias mensagens (marca de origem): o
 * `BroadcastChannel` entrega também aos outros objetos da mesma aba, e a aba que sai precisa
 * seguir para o fim de sessão do Authentik, não para a SCR-001.
 */

export const SESSION_CHANNEL = 'cf-session';

export type SessionEvent =
  | { readonly type: 'tenant-switched'; readonly tenantId: string }
  | { readonly type: 'logout' }
  | { readonly type: 'expired' }
  | { readonly type: 'extended'; readonly idleExpiresAt: string };

/** Origem das mensagens desta aba (um valor por carregamento do módulo). */
const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  if (value.type === 'logout' || value.type === 'expired') return true;
  if (value.type === 'extended') {
    return (
      'idleExpiresAt' in value &&
      typeof value.idleExpiresAt === 'string' &&
      !Number.isNaN(Date.parse(value.idleExpiresAt))
    );
  }
  return (
    value.type === 'tenant-switched' && 'tenantId' in value && typeof value.tenantId === 'string'
  );
}

function fromThisTab(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'source' in value && value.source === TAB_ID
  );
}

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL);
}

export function publishSessionEvent(event: SessionEvent): void {
  const bc = channel();
  if (!bc) return;
  bc.postMessage({ ...event, source: TAB_ID });
  bc.close();
}

/** Assina os eventos das outras abas; devolve a função de cancelamento. */
export function subscribeSessionEvents(handler: (event: SessionEvent) => void): () => void {
  const bc = channel();
  if (!bc) return () => undefined;
  bc.onmessage = (message: MessageEvent<unknown>) => {
    if (isSessionEvent(message.data) && !fromThisTab(message.data)) handler(message.data);
  };
  return () => {
    bc.close();
  };
}
