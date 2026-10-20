// Dados e API simulada do painel "Encaminhar processo" (US-047 · SCR-103).
import type {
  ActionEntry,
  ChecklistViolation,
  ForwardedProcessDto,
  ProcessDocumentDto,
  ProcessDto,
  Violation,
} from '@contrataflow/validation';
import { vi } from 'vitest';

import { ID, PROCESS_ID, problemResponse, processDto, stagesDto } from './process-fixtures';
import type { Handler } from './process-fixtures';
import { jsonResponse, requestUrl } from './render';

export const STAGE_ID = ID(302);
export const NEXT_STAGE_ID = ID(303);
export const T_PESQUISA = ID(901);
export const T_APROVACAO = ID(902);
export const T_OUTRA = ID(903);
export const RULE_ETP_FORWARD = ID(611);
export const RULE_RISK_FORWARD = ID(612);
export const COMPRAS = { id: ID(30), name: 'Departamento de Compras' };
export const LICITACOES = { id: ID(31), name: 'Departamento de Licitações' };
export const DOC_ETP = ID(521);
export const DOC_RISKS = ID(522);
export const DOC_DFD = ID(523);

export const PROCESS_URL = `/api/v1/processes/${PROCESS_ID}`;
export const FORWARD_URL = `${PROCESS_URL}/forward`;

/** Processo 0012/2026 na etapa ESTUDOS_PRELIMINARES, versão 14 (Background da US-047). */
export function inStudies(extra: Partial<ProcessDto> = {}): ProcessDto {
  return processDto({
    status: 'IN_PROGRESS',
    version: 14,
    currentStage: {
      id: STAGE_ID,
      key: 'ESTUDOS_PRELIMINARES',
      name: 'ETP e mapa de riscos',
      dueAt: null,
      instructions: null,
      documentTypeCodes: ['ETP'],
    },
    ...extra,
  });
}

/** Entrada `FORWARD` do PRC-08 (padrão: unidade fixa, sem sobrescrita de prazo). */
export function forwardEntry(extra: Partial<ActionEntry> = {}): ActionEntry {
  return {
    action: 'FORWARD',
    transitionId: T_PESQUISA,
    transitionKey: 'ESTUDOS_PARA_PESQUISA',
    label: 'Encaminhar para pesquisa de preços',
    toStageKey: 'PESQUISA_PRECOS',
    toStageName: 'Pesquisa de preços',
    toStageType: 'TASK',
    enabled: true,
    primary: true,
    reasons: [],
    departmentResolution: {
      mode: 'FIXED',
      departmentId: COMPRAS.id,
      departmentName: COMPRAS.name,
    },
    requiresComment: false,
    allowDueDateOverride: false,
    dueAtPreview: '2026-10-21T02:59:59.000Z',
    approverPreview: null,
    ...extra,
  };
}

/** Transição para a etapa de aprovação do DFD, com o aprovador previsto. */
export function approvalEntry(extra: Partial<ActionEntry> = {}): ActionEntry {
  return forwardEntry({
    transitionId: T_APROVACAO,
    transitionKey: 'ABERTURA_PARA_APROVACAO',
    label: 'Enviar para aprovação da demanda',
    toStageKey: 'APROVACAO_DFD',
    toStageName: 'Aprovação da demanda',
    toStageType: 'APPROVAL',
    departmentResolution: { mode: 'REQUESTING_SECRETARIAT', departmentName: 'Secretaria de Obras' },
    dueAtPreview: null,
    approverPreview: { type: 'USER', label: 'Carlos Lima (titular da Secretaria de Obras)' },
    ...extra,
  });
}

export function violation(
  ruleId: string,
  severity: Violation['severity'],
  message: string,
  extra: Partial<Violation> = {},
): Violation {
  return {
    code: 'WORKFLOW_RULE',
    severity,
    message,
    ruleId,
    sectionKey: null,
    field: null,
    itemId: null,
    params: {},
    ...extra,
  };
}

/** Pendência do PRC-09 (`STAGE_EXIT` por padrão). */
export function checklistRule(
  ruleId: string,
  severity: ChecklistViolation['severity'],
  message: string,
  extra: Partial<ChecklistViolation> = {},
): ChecklistViolation {
  return {
    ...violation(ruleId, severity, message),
    code: 'WORKFLOW_RULE',
    ruleId,
    name: message,
    type: 'REQUIRED_DOCUMENT',
    satisfied: false,
    scope: 'STAGE_EXIT',
    ...extra,
  };
}

let documentSequence = 0;

export function documentDto(
  id: string,
  title: string,
  typeCode: string,
  typeName: string,
  extra: Partial<ProcessDocumentDto> = {},
): ProcessDocumentDto {
  documentSequence += 1;
  return {
    id,
    processId: PROCESS_ID,
    documentType: {
      id: ID(700 + documentSequence),
      code: typeCode,
      name: typeName,
      kind: 'FREE_TEXT',
      systemModule: null,
      requiresApproval: false,
    },
    templateVersionId: null,
    number: null,
    year: null,
    code: null,
    title,
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftRevision: 1,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ID(1),
    responsibleName: 'Paula Souza',
    submittedAt: null,
    submittedById: null,
    finalizedAt: null,
    finalizedById: null,
    approvedAt: null,
    returnedAt: null,
    rejectedAt: null,
    reopenedAt: null,
    reopenedById: null,
    reopenReason: null,
    canceledAt: null,
    canceledById: null,
    cancellationReason: null,
    sourceDocumentId: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-10-17T13:30:00.000Z',
    createdById: ID(1),
    version: 1,
    summary: null,
    meta: { allowedActions: [] },
    ...extra,
  };
}

/** ETP e mapa de riscos alterados na etapa atual; o DFD é anterior (não vem marcado). */
export function defaultDocuments(): ProcessDocumentDto[] {
  return [
    documentDto(DOC_ETP, 'ETP — cimento', 'ETP', 'Estudo Técnico Preliminar', {
      status: 'FINALIZED',
      currentVersionNumber: 1,
    }),
    documentDto(DOC_RISKS, 'Mapa de riscos — cimento', 'RISK_MAP', 'Mapa de riscos'),
    documentDto(DOC_DFD, 'DFD — cimento', 'DFD', 'DFD', {
      status: 'APPROVED',
      currentVersionNumber: 2,
      updatedAt: '2026-09-01T12:00:00.000Z',
    }),
  ];
}

/** PRC-19: o processo na etapa de destino, com a tramitação gravada. */
export function forwardedDto(extra: Partial<ForwardedProcessDto> = {}): ForwardedProcessDto {
  return {
    ...processDto({
      status: 'IN_PROGRESS',
      version: 15,
      code: '0012/2026',
      currentStage: {
        id: NEXT_STAGE_ID,
        key: 'PESQUISA_PRECOS',
        name: 'Pesquisa de preços',
        dueAt: '2026-10-21T02:59:59.000Z',
        instructions: null,
        documentTypeCodes: [],
      },
      currentDepartment: COMPRAS,
      currentResponsible: null,
    }),
    movement: { id: ID(950), sequence: 7 },
    numberAssigned: false,
    statusFrom: 'IN_PROGRESS',
    ...extra,
  };
}

export type ForwardResource<T> = T | Handler;

export interface ForwardApiOptions {
  process?: Handler;
  actions?: ForwardResource<ActionEntry[]>;
  checklist?: ForwardResource<ChecklistViolation[]>;
  documents?: ForwardResource<ProcessDocumentDto[]>;
  stages?: Handler;
  forward?: Handler;
  /** DEP-02 (`/departments/lookup?organizationId=…`). */
  departments?: Handler;
  /** USR-02 (`/users/lookup?q=…`). */
  users?: Handler;
}

function resolve<T>(
  resource: ForwardResource<T> | undefined,
  fallback: T,
  wrap: (value: T) => Response,
): Handler {
  if (typeof resource === 'function') return resource as Handler;
  return () => wrap(resource ?? fallback);
}

/** `fetch` simulado do painel: PRC-04/08/09/10, DOC-01, DEP-02, USR-02 e PRC-19. */
export function mockForwardApi(options: ForwardApiOptions = {}) {
  const process = options.process ?? (() => jsonResponse({ data: inStudies() }));
  const actions = resolve(options.actions, [forwardEntry()], (data) => jsonResponse({ data }));
  const checklist = resolve(options.checklist, [], (violations) =>
    jsonResponse({ data: { violations } }),
  );
  const documents = resolve(options.documents, defaultDocuments(), (data) =>
    jsonResponse({
      data,
      meta: { currentStage: null, creatableTypeIds: [], pendingTypeIds: [] },
    }),
  );
  const stages = options.stages ?? (() => jsonResponse({ data: stagesDto() }));
  const forward = options.forward ?? (() => jsonResponse({ data: forwardedDto() }));
  const departments =
    options.departments ??
    (() =>
      jsonResponse({
        data: [COMPRAS, LICITACOES].map((unit) => ({
          ...unit,
          type: 'DEPARTMENT',
          path: `/${unit.id}/`,
        })),
      }));
  const users =
    options.users ??
    (() =>
      jsonResponse({
        data: [
          {
            id: ID(61),
            name: 'Rui Almeida',
            email: 'rui@prefeitura.gov.br',
            membershipType: 'INTERNAL',
            membershipExpiresAt: null,
          },
        ],
      }));

  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const answer = (handler: Handler) => Promise.resolve(handler(url, init));
    if (method === 'GET' && url === PROCESS_URL) return answer(process);
    if (method === 'GET' && url === `${PROCESS_URL}/available-actions`) return answer(actions);
    if (method === 'GET' && url === `${PROCESS_URL}/checklist`) return answer(checklist);
    if (method === 'GET' && url.startsWith(`${PROCESS_URL}/documents`)) return answer(documents);
    if (method === 'GET' && url === `${PROCESS_URL}/stages`) return answer(stages);
    if (method === 'GET' && url === `${PROCESS_URL}/summary`) {
      return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
    }
    if (method === 'GET' && url.startsWith('/api/v1/departments/lookup')) {
      return answer(departments);
    }
    if (method === 'GET' && url.startsWith('/api/v1/users/lookup')) return answer(users);
    if (method === 'POST' && url === FORWARD_URL) return answer(forward);
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
