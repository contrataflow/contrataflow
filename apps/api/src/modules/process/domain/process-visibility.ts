import type { ProcessAccessGrants } from './process-runtime.js';

/*
 * Visibilidade de processos (DEC-024 · permissions.md §5/§7). Um usuário vê o processo se QUALQUER
 * condição for verdadeira:
 *   1/2. `PROCESS_VIEW` com escopo `TENANT` (ou `ORGANIZATION` do processo);
 *   3.   `PROCESS_VIEW` com escopo de unidade e `ProcessAccess` para uma das suas unidades;
 *   4.   `ProcessAccess` para o próprio usuário (capacidade implícita — criador, responsável,
 *        participante, aprovador).
 * Não visível = 404 sem distinguir de inexistente. PONTE até as atribuições com escopo (US-096/097):
 * o escopo amplo vem do perfil padrão (`defaultAssignmentScope = TENANT`) e o de unidade, das
 * lotações; `ORGANIZATION` cai no caso por unidade (nunca amplia o acesso).
 */

export interface ProcessViewer {
  readonly userId: string;
  /** Tem `PROCESS_VIEW` em algum escopo. */
  readonly hasProcessView: boolean;
  /** O `PROCESS_VIEW` cobre todas as unidades do tenant. */
  readonly viewsWholeTenant: boolean;
  /** Unidades de lotação. */
  readonly departmentIds: readonly string[];
}

export function canViewProcess(access: ProcessAccessGrants, viewer: ProcessViewer): boolean {
  if (access.userIds.includes(viewer.userId)) return true;
  if (!viewer.hasProcessView) return false;
  if (viewer.viewsWholeTenant) return true;
  return access.departmentIds.some((departmentId) => viewer.departmentIds.includes(departmentId));
}
