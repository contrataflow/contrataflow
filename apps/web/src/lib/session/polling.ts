/*
 * Consultas de sondagem (RN-IAM-21 · US-088): o contador de notificações (NTF-02) e os contadores
 * da caixa de tarefas (TSK-02) rodam sozinhos, sem ação do usuário — não renovam a ociosidade no
 * BFF nem reiniciam o contador local do shell. Lista única, usada pelo proxy e pelo cliente.
 */

export const POLLING_ROUTES: ReadonlySet<string> = new Set([
  '/notifications/unread-count',
  '/tasks/counters',
]);

/** `path` sem o prefixo `/api/v1` e sem query string. */
export function isPollingRequest(method: string, path: string): boolean {
  return method.toUpperCase() === 'GET' && POLLING_ROUTES.has(path);
}
