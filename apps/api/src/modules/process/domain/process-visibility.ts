import { isProcessVisible } from '#shared/auth/process-access.js';
import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';

import type { ProcessAccessGrants } from './process-runtime.js';

/*
 * Visibilidade de processos (DEC-024 · permissions.md §5/§7). Um usuário vê o processo se QUALQUER
 * condição for verdadeira:
 *   1/2. `PROCESS_VIEW` com escopo `TENANT` ou `ORGANIZATION` do processo;
 *   3.   `PROCESS_VIEW` com escopo de unidade (`DEPARTMENT`/`OWN_DEPARTMENTS`, expandido) e
 *        `ProcessAccess` para uma dessas unidades;
 *   4.   `ProcessAccess` para o próprio usuário (capacidade implícita — criador, responsável,
 *        participante, aprovador).
 * Não visível = 404 sem distinguir de inexistente. O escopo vem das permissões efetivas (US-097 —
 * `AccessFacade.processVisibilityScope`); a regra é a mesma do predicado SQL
 * (`#shared/database/process-visibility.js`).
 */

export type ProcessViewer = ProcessVisibilityScope;

export function canViewProcess(
  access: ProcessAccessGrants,
  viewer: ProcessViewer,
  organizationId: string | null = null,
): boolean {
  return isProcessVisible(viewer, { organizationId, ...access });
}
