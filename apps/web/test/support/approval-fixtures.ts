// Dados e API simulada do detalhe da aprovação / decisão (US-052 · SCR-015).
import type {
  ApprovalDecisionOption,
  ApprovalDto,
  ApprovalMeta,
  DecidedApprovalDto,
} from '@contrataflow/validation';
import { vi } from 'vitest';

import { checklistRule } from './forward-fixtures';
import { ID, PROCESS_ID, problemResponse } from './process-fixtures';
import type { Handler } from './process-fixtures';
import { jsonResponse, requestUrl } from './render';

export const APPROVAL_ID = ID(1100);
export const APPROVAL_URL = `/api/v1/approvals/${APPROVAL_ID}`;
export const DECIDE_URL = `${APPROVAL_URL}/decide`;
/** US-053: APV-04/APV-05 e as buscas de novo aprovador (USR-02/DEP-02). */
export const WITHDRAW_URL = `${APPROVAL_URL}/withdraw`;
export const REASSIGN_URL = `${APPROVAL_URL}/reassign`;
export const USERS_LOOKUP_URL = '/api/v1/users/lookup';
export const DEPARTMENTS_LOOKUP_URL = '/api/v1/departments/lookup';
export const DIEGO = { id: ID(71), name: 'Diego Albuquerque', email: 'diego@prefeitura-a.test' };

export const DOC_ETP = ID(1201);
export const DOC_TR = ID(1202);
export const VERSION_ETP = ID(1211);
export const VERSION_TR = ID(1212);

export const T_APROVAR = ID(1301);
export const T_DEVOLVER_ESTUDOS = ID(1302);
export const T_DEVOLVER_ABERTURA = ID(1303);
export const T_INDEFERIR = ID(1304);

export const RULE_RISCOS = ID(1401);
export const RULE_PARECER = ID(1402);

export const CARLA = { id: ID(70), name: 'Carla Menezes' };
export const MARCOS_REQUESTER = { id: ID(2), name: 'Marcos Vinícius Rocha' };

/** Aprovação pendente cobrindo o ETP (v2) e o TR (v1), com a versão 3 (a `ETag`). */
export function approvalDto(extra: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id: APPROVAL_ID,
    subjectType: 'PROCESS_STAGE',
    status: 'PENDING',
    title: 'Aprovação do ETP e do Termo de Referência',
    process: {
      id: PROCESS_ID,
      code: '0012/2026',
      title: 'Aquisição de cimento para manutenção de vias',
    },
    processStageId: ID(802),
    documentId: null,
    requestedBy: MARCOS_REQUESTER,
    requestedAt: '2026-10-14T15:00:00.000Z',
    requestComment: 'Seguem o ETP e o TR para a sua análise.',
    dueAt: '2026-10-21T02:59:59.999Z',
    approver: {
      type: 'USER',
      userId: CARLA.id,
      roleId: null,
      departmentId: null,
      label: CARLA.name,
    },
    allowDeputy: false,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    decisionComment: null,
    decidedAsDeputy: false,
    documents: [
      {
        documentId: DOC_ETP,
        documentVersionId: VERSION_ETP,
        versionNumber: 2,
        code: 'ETP 0003/2026',
        title: 'ETP — cimento',
        typeCode: 'ETP',
        typeName: 'Estudo Técnico Preliminar',
        status: 'IN_REVIEW',
      },
      {
        documentId: DOC_TR,
        documentVersionId: VERSION_TR,
        versionNumber: 1,
        code: null,
        title: 'Termo de Referência — cimento',
        typeCode: 'TR',
        typeName: 'Termo de Referência',
        status: 'IN_REVIEW',
      },
    ],
    version: 3,
    ...extra,
  };
}

/** Opção de decisão (padrão: aprovar, habilitada, sem regra pendente). */
export function decisionOption(
  extra: Partial<ApprovalDecisionOption> = {},
): ApprovalDecisionOption {
  return {
    decision: 'APPROVE',
    transitionId: T_APROVAR,
    label: 'Aprovar',
    toStage: {
      id: ID(803),
      key: 'CONCLUSAO',
      name: 'Planejamento da contratação concluído',
      type: 'END',
    },
    requiresComment: false,
    enabled: true,
    violations: [],
    ...extra,
  };
}

export function returnOption(extra: Partial<ApprovalDecisionOption> = {}): ApprovalDecisionOption {
  return decisionOption({
    decision: 'RETURN',
    transitionId: T_DEVOLVER_ESTUDOS,
    label: 'Devolver para ETP e mapa de riscos',
    toStage: { id: ID(804), key: 'ESTUDOS', name: 'ETP e mapa de riscos', type: 'TASK' },
    requiresComment: true,
    ...extra,
  });
}

export function secondReturnOption(
  extra: Partial<ApprovalDecisionOption> = {},
): ApprovalDecisionOption {
  return returnOption({
    transitionId: T_DEVOLVER_ABERTURA,
    label: 'Devolver para Formalização da demanda',
    toStage: { id: ID(805), key: 'ABERTURA', name: 'Formalização da demanda', type: 'START' },
    ...extra,
  });
}

export function rejectOption(extra: Partial<ApprovalDecisionOption> = {}): ApprovalDecisionOption {
  return decisionOption({
    decision: 'REJECT',
    transitionId: T_INDEFERIR,
    label: 'Indeferir',
    toStage: { id: ID(804), key: 'ESTUDOS', name: 'ETP e mapa de riscos', type: 'TASK' },
    requiresComment: true,
    ...extra,
  });
}

/** Regra `TRANSITION` não satisfeita (aviso ou bloqueio) como o APV-02 a traz na opção. */
export function transitionRule(
  ruleId: string,
  severity: 'BLOCKING' | 'WARNING',
  message: string,
): ApprovalDecisionOption['violations'][number] {
  return checklistRule(ruleId, severity, message, { scope: 'TRANSITION' });
}

/** `meta` do APV-02 de quem pode decidir (padrão: uma opção por decisão). */
export function approvalMeta(extra: Partial<ApprovalMeta> = {}): ApprovalMeta {
  return {
    allowedActions: ['DECIDE'],
    decisionOptions: [decisionOption(), returnOption(), rejectOption()],
    decidesAsDeputy: false,
    decisionBlocker: null,
    ...extra,
  };
}

/** `meta` de quem só consulta: sem `DECIDE` e com o motivo. */
export function readOnlyMeta(
  decisionBlocker: ApprovalMeta['decisionBlocker'],
  extra: Partial<ApprovalMeta> = {},
): ApprovalMeta {
  return approvalMeta({ allowedActions: [], decisionOptions: [], decisionBlocker, ...extra });
}

/** Aprovação já decidida: Carla aprovou (substituto = `decidedAsDeputy`). */
export function decidedApprovalDto(extra: Partial<ApprovalDto> = {}): ApprovalDto {
  return approvalDto({
    status: 'APPROVED',
    decision: 'APPROVE',
    decidedBy: CARLA,
    decidedAt: '2026-10-15T13:30:00.000Z',
    decisionComment: 'De acordo com o parecer jurídico.',
    version: 4,
    ...extra,
  });
}

/** APV-03: a aprovação decidida e a nova etapa/status do processo. */
export function decidedDto(extra: Partial<DecidedApprovalDto> = {}): DecidedApprovalDto {
  return {
    ...decidedApprovalDto(),
    processStage: { key: 'CONCLUSAO', name: 'Planejamento da contratação concluído' },
    processStatus: 'COMPLETED',
    chainedApprovalId: null,
    ...extra,
  };
}

export interface ApprovalApiOptions {
  /** APV-02 (padrão: aprovação pendente + `meta` de quem decide, `ETag: "3"`). */
  readonly approval?: Handler;
  /** APV-03 (padrão: 200 com a aprovação decidida). */
  readonly decide?: Handler;
  /** APV-04 (padrão: 200 com a aprovação cancelada e a etapa anterior). */
  readonly withdraw?: Handler;
  /** APV-05 (padrão: 200 com a aprovação redirecionada a Diego). */
  readonly reassign?: Handler;
  /** USR-02/DEP-02 (padrão: Diego / Secretaria de Saúde). */
  readonly lookup?: Handler;
}

/** `fetch` simulado do SCR-015: APV-02, APV-03 e (US-053) APV-04, APV-05 e as buscas. */
export function mockApprovalApi(options: ApprovalApiOptions = {}) {
  const approval: Handler =
    options.approval ??
    (() =>
      jsonResponse({ data: approvalDto(), meta: approvalMeta() }, { headers: { ETag: '"3"' } }));
  const decide: Handler =
    options.decide ?? (() => jsonResponse({ data: decidedDto() }, { headers: { ETag: '"4"' } }));
  const withdraw: Handler =
    options.withdraw ??
    (() =>
      jsonResponse(
        {
          data: {
            ...approvalDto({ status: 'CANCELED', version: 4 }),
            processStage: { key: 'TERMO_REFERENCIA', name: 'Termo de Referência' },
            processStatus: 'RETURNED',
          },
        },
        { headers: { ETag: '"4"' } },
      ));
  const reassign: Handler =
    options.reassign ??
    (() =>
      jsonResponse(
        {
          data: approvalDto({
            version: 4,
            approver: {
              type: 'USER',
              userId: DIEGO.id,
              roleId: null,
              departmentId: null,
              label: DIEGO.name,
            },
          }),
        },
        { headers: { ETag: '"4"' } },
      ));
  const lookup: Handler =
    options.lookup ??
    ((url) =>
      jsonResponse({
        data: url.startsWith(USERS_LOOKUP_URL)
          ? [
              {
                id: DIEGO.id,
                name: DIEGO.name,
                email: DIEGO.email,
                membershipType: 'INTERNAL',
                membershipExpiresAt: null,
              },
            ]
          : [{ id: ID(901), name: 'Secretaria de Saúde', type: 'SECRETARIAT', path: '/x/' }],
      }));
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const answer = (handler: Handler) => Promise.resolve(handler(url, init));
    if (method === 'GET' && url === APPROVAL_URL) return answer(approval);
    if (method === 'POST' && url === DECIDE_URL) return answer(decide);
    if (method === 'POST' && url === WITHDRAW_URL) return answer(withdraw);
    if (method === 'POST' && url === REASSIGN_URL) return answer(reassign);
    if (url.startsWith(USERS_LOOKUP_URL) || url.startsWith(DEPARTMENTS_LOOKUP_URL)) {
      return answer(lookup);
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Resposta do APV-02 com a aprovação e o `meta` informados. */
export function approvalResponse(data: ApprovalDto, meta: ApprovalMeta): Response {
  return jsonResponse({ data, meta }, { headers: { ETag: `"${String(data.version)}"` } });
}
