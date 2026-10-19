/*
 * Consultas de sondagem (RN-IAM-21 · US-088): o contador de notificações (NTF-02), os contadores
 * da caixa de tarefas (TSK-02) e o painel situacional do processo (PRC-08/PRC-09 — US-041, com o
 * id no caminho) rodam sozinhos, sem ação do usuário — não renovam a ociosidade no BFF nem
 * reiniciam o contador local do shell; o heartbeat de presença (DOC-24) é a sondagem de escrita.
 * Lista única, usada pelo proxy e pelo cliente.
 */

export const POLLING_ROUTES: ReadonlySet<string> = new Set([
  '/notifications/unread-count',
  '/tasks/counters',
]);

/**
 * Sondagens com id no caminho: ações disponíveis e checklist do processo (US-041) e o status do
 * PDF em geração (DOC-22 — US-067) e da prévia do template (TPL-12 — US-109); o download
 * `/download` é ação do usuário e fica de fora.
 */
export const POLLING_PATTERNS: readonly RegExp[] = [
  /^\/processes\/[0-9a-f-]{36}\/(?:available-actions|checklist)$/i,
  /^\/document-renditions\/[0-9a-f-]{36}$/i,
  /^\/template-versions\/[0-9a-f-]{36}\/preview\/[0-9a-f-]{36}$/i,
];

/**
 * Escritas automáticas, sem ação do usuário: o heartbeat de presença do editor de seções (DOC-24 —
 * US-070), a cada 20 s enquanto o editor está em foco.
 */
export const POLLING_WRITE_PATTERNS: readonly RegExp[] = [
  /^\/documents\/[0-9a-f-]{36}\/presence$/i,
];

/** `path` sem o prefixo `/api/v1` e sem query string. */
export function isPollingRequest(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === 'PUT') return POLLING_WRITE_PATTERNS.some((pattern) => pattern.test(path));
  return (
    verb === 'GET' &&
    (POLLING_ROUTES.has(path) || POLLING_PATTERNS.some((pattern) => pattern.test(path)))
  );
}
