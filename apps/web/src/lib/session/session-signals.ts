/*
 * Sinais da sessão dentro da aba (US-088): o cliente de API avisa o `SessionWatcher` de cada ação
 * do usuário atendida (reinicia o contador de ociosidade — FA-02), de sessão expirada (401
 * `SESSION_EXPIRED` → modal) e de indisponibilidade (503 → banner, nunca "sessão expirada" —
 * RN-IAM-33). Entre abas, quem propaga é o `BroadcastChannel` (`session-channel.ts`).
 */

export type SessionSignal =
  { readonly type: 'activity' } | { readonly type: 'expired' } | { readonly type: 'unavailable' };

type Listener = (signal: SessionSignal) => void;

const listeners = new Set<Listener>();

export function emitSessionSignal(signal: SessionSignal): void {
  for (const listener of listeners) listener(signal);
}

/** Assina os sinais desta aba; devolve a função de cancelamento. */
export function onSessionSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
