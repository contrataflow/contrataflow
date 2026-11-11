import type { Outcome } from './authorization-harness.js';

/*
 * Divergências conhecidas entre permissions.md e o código (spec-635): NÃO corrigidas sem decisão
 * do piloto. Cada uma é uma regra nomeada, com o motivo, aplicada pela matriz gerada e pela
 * bateria de visibilidade. Regra que não casa mais nenhum caso reprova como obsoleta — quando a
 * decisão for tomada (código ou documento), a regra sai daqui.
 */

export interface MatrixCase {
  readonly route: string;
  readonly permission: string;
  readonly role: string;
  readonly scope: string;
  /** Situação do processo do parâmetro de rota; `null` = rota sem processo. */
  readonly situation: string | null;
}

export interface KnownDivergence {
  readonly id: string;
  readonly reason: string;
  /** O que o documento manda e o que o código faz hoje. */
  readonly documented: Outcome;
  readonly current: Outcome;
  readonly matches: (testCase: MatrixCase) => boolean;
}

/**
 * DIV-AUTHZ-01 — §7 ("Ver processos em que possui concessão USER — criador, responsável, aprovador,
 * participante — não depende de perfil") × rotas com `@RequirePermission('PROCESS_VIEW', {
 * processParam })` (documentos, tramitações, participantes, timeline, gerações de IA do processo):
 * o `AuthorizationService` acha o processo visível pela concessão USER, mas exige que o ESCOPO do
 * perfil cubra `PROCESS_VIEW` (`roleCoversProcess`) e responde 403. O detalhe do processo
 * (escopo `ANY` + visibilidade no caso de uso) responde 200 ao mesmo usuário. Participante não é
 * afetado (a participação concede `PROCESS_VIEW`).
 */
export const OWN_GRANT_PROCESS_VIEW: KnownDivergence = {
  id: 'DIV-AUTHZ-01',
  reason:
    'concessão USER (criador/responsável/aprovador) fora do escopo do perfil: §7 dá a visão, a rota com PROCESS_VIEW por processo nega 403',
  documented: 'ALLOW',
  current: 'PERMISSION_DENIED',
  matches: (testCase) =>
    testCase.situation === 'OWN_GRANT' && testCase.permission === 'PROCESS_VIEW',
};

export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [OWN_GRANT_PROCESS_VIEW];
