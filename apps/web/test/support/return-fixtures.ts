// Dados e API simulada do diálogo "Devolver processo" (US-048 · SCR-104).
import type { ActionEntry, ReturnedProcessDto } from '@contrataflow/validation';
import { vi } from 'vitest';

import { inStudies, PROCESS_URL } from './forward-fixtures';
import { ID, problemResponse, processDto } from './process-fixtures';
import type { Handler } from './process-fixtures';
import { jsonResponse, requestUrl } from './render';

export const RETURN_URL = `${PROCESS_URL}/return`;
export const STAGE_ABERTURA = ID(401);
export const STAGE_APROVACAO = ID(402);
export const T_DEVOLVER_ABERTURA = ID(911);
export const T_DEVOLVER_APROVACAO = ID(912);
export const MANUTENCAO = { id: ID(32), name: 'Setor de Manutenção' };
export const ANA = { id: ID(62), name: 'Ana Souza' };

/** Entrada `RETURN` do PRC-08 (padrão: ABERTURA, percorrida em 30/09, prazo alterável). */
export function returnEntry(extra: Partial<ActionEntry> = {}): ActionEntry {
  return {
    action: 'RETURN',
    transitionId: T_DEVOLVER_ABERTURA,
    transitionKey: 'DEVOLVER_ESTUDOS_ABERTURA',
    label: 'Devolver à formalização da demanda',
    toStageKey: 'ABERTURA',
    toStageId: STAGE_ABERTURA,
    toStageName: 'Formalização da demanda',
    toStageType: 'START',
    lastPassedAt: '2026-09-30T15:00:00.000Z',
    enabled: true,
    reasons: [],
    requiresComment: true,
    allowDueDateOverride: true,
    ...extra,
  };
}

/** Segunda etapa percorrida (APROVACAO_DFD), sem prazo alterável. */
export function secondReturnEntry(extra: Partial<ActionEntry> = {}): ActionEntry {
  return returnEntry({
    transitionId: T_DEVOLVER_APROVACAO,
    transitionKey: 'DEVOLVER_ESTUDOS_APROVACAO',
    label: 'Devolver à aprovação da demanda',
    toStageKey: 'APROVACAO_DFD',
    toStageId: STAGE_APROVACAO,
    toStageName: 'Aprovação da demanda',
    toStageType: 'APPROVAL',
    lastPassedAt: '2026-10-01T15:00:00.000Z',
    allowDueDateOverride: false,
    ...extra,
  });
}

/** PRC-20: o processo devolvido para a ABERTURA com a Ana. */
export function returnedDto(extra: Partial<ReturnedProcessDto> = {}): ReturnedProcessDto {
  return {
    ...processDto({
      status: 'RETURNED',
      version: 15,
      code: '0012/2026',
      currentStage: {
        id: ID(304),
        key: 'ABERTURA',
        name: 'Formalização da demanda',
        dueAt: '2026-10-14T02:59:59.999Z',
        instructions: null,
        documentTypeCodes: ['DFD'],
      },
      currentDepartment: MANUTENCAO,
      currentResponsible: ANA,
    }),
    movement: { id: ID(951), sequence: 8 },
    statusFrom: 'IN_PROGRESS',
    ...extra,
  };
}

export interface ReturnApiOptions {
  process?: Handler;
  actions?: ActionEntry[] | Handler;
  giveBack?: Handler;
}

/** `fetch` simulado do diálogo: PRC-04, PRC-08 e PRC-20. */
export function mockReturnApi(options: ReturnApiOptions = {}) {
  const process = options.process ?? (() => jsonResponse({ data: inStudies() }));
  const actions: Handler =
    typeof options.actions === 'function'
      ? options.actions
      : () => jsonResponse({ data: options.actions ?? [returnEntry()] });
  const giveBack = options.giveBack ?? (() => jsonResponse({ data: returnedDto() }));
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const answer = (handler: Handler) => Promise.resolve(handler(url, init));
    if (method === 'GET' && url === PROCESS_URL) return answer(process);
    if (method === 'GET' && url === `${PROCESS_URL}/available-actions`) return answer(actions);
    if (method === 'POST' && url === RETURN_URL) return answer(giveBack);
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
