// Dados e API simulada do wizard "Novo processo" e do painel do processo (US-001 · SCR-005/006).
import type { CatalogType } from '@contrataflow/types';
import type {
  CatalogItemDto,
  DepartmentDto,
  DuplicateCandidate,
  OrganizationDto,
  PermissionScopeDto,
  ProcessDto,
  ProcessStageEntryDto,
  ProcessSummaryDto,
  WorkflowResolutionDto,
} from '@contrataflow/validation';
import { vi } from 'vitest';

import { jsonResponse, requestUrl } from './render';

export const ID = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export function organization(n: number, name: string, extra: Partial<OrganizationDto> = {}) {
  return {
    id: ID(n),
    name,
    shortName: name.slice(0, 4).toUpperCase(),
    cnpj: '11222333000181',
    type: 'DIRECT_ADMINISTRATION',
    isActive: true,
    isPrimary: false,
    email: null,
    phone: null,
    website: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
    addressCity: null,
    addressState: null,
    addressZipCode: null,
    ibgeCityCode: null,
    logoAttachmentId: null,
    metadata: {},
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...extra,
  } satisfies OrganizationDto;
}

export const ORG_MAIN = organization(100, 'Prefeitura Municipal', { isPrimary: true });
export const ORG_FUND = organization(101, 'Fundo Municipal de Saúde');

export function unit(
  n: number,
  name: string,
  parent: DepartmentDto | null,
  extra: Partial<DepartmentDto> = {},
): DepartmentDto {
  return {
    id: ID(n),
    organizationId: ORG_MAIN.id,
    parentId: parent?.id ?? null,
    type: parent ? 'SECTOR' : 'SECRETARIAT',
    name,
    acronym: null,
    code: null,
    email: null,
    phone: null,
    headUserId: null,
    deputyUserId: null,
    isActive: true,
    isSecretariat: parent === null,
    sortOrder: 0,
    path: `${parent?.path ?? '/'}${ID(n)}/`,
    depth: parent ? parent.depth + 1 : 0,
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...extra,
  };
}

export const OBRAS = unit(10, 'Secretaria de Obras', null);
export const MANUTENCAO = unit(11, 'Setor de Manutenção', OBRAS);
export const PROJETOS = unit(12, 'Departamento de Projetos', OBRAS, { type: 'DEPARTMENT' });
export const SAUDE = unit(20, 'Secretaria de Saúde', null);
export const FARMACIA = unit(21, 'Setor de Farmácia', SAUDE);
export const DEPARTMENTS = [OBRAS, MANUTENCAO, PROJETOS, SAUDE, FARMACIA];

export function catalogItem(
  n: number,
  type: CatalogType,
  code: string,
  label: string,
  extra: Partial<CatalogItemDto> = {},
): CatalogItemDto {
  return {
    id: ID(n),
    catalogType: type,
    code,
    label,
    description: null,
    isSystem: true,
    isActive: true,
    sortOrder: n,
    parentId: null,
    metadata: {},
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    ...extra,
  };
}

export const AQUISICAO = catalogItem(
  201,
  'CONTRACTING_TYPE',
  'AQUISICAO_BENS',
  'Aquisição de bens',
);
export const SERVICOS = catalogItem(202, 'CONTRACTING_TYPE', 'SERVICOS', 'Serviços comuns');
export const PREGAO = catalogItem(211, 'MODALITY', 'PREGAO', 'Pregão');
export const NAO_PREVISTA = catalogItem(
  221,
  'PROCESS_ORIGIN',
  'DEMANDA_NAO_PREVISTA',
  'Demanda não prevista',
);
export const PLANO_ANUAL = catalogItem(222, 'PROCESS_ORIGIN', 'PLANO_ANUAL', 'Plano anual');

export const UNIDADE = catalogItem(231, 'UNIT_OF_MEASURE', 'UN', 'Unidade');
export const METRO_CUBICO = catalogItem(232, 'UNIT_OF_MEASURE', 'M3', 'Metro cúbico');

export const CATALOGS: Partial<Record<CatalogType, CatalogItemDto[]>> = {
  CONTRACTING_TYPE: [AQUISICAO, SERVICOS],
  MODALITY: [PREGAO],
  PROCESS_ORIGIN: [NAO_PREVISTA, PLANO_ANUAL],
  UNIT_OF_MEASURE: [UNIDADE, METRO_CUBICO],
};

export const WORKFLOW_RESOLUTION: WorkflowResolutionDto = {
  workflowId: ID(300),
  workflowVersionId: ID(301),
  name: 'Fase preparatória — Lei 14.133/2021',
  versionNumber: 1,
  initialStage: { id: ID(302), key: 'ABERTURA', name: 'Formalização da demanda' },
};

export const PROCESS_ID = ID(400);

export function processDto(extra: Partial<ProcessDto> = {}): ProcessDto {
  return {
    id: PROCESS_ID,
    code: '0012/2026',
    number: 12,
    year: 2026,
    internalCode: null,
    title: 'Aquisição de cimento para manutenção de vias',
    object: 'Aquisição de cimento Portland para a manutenção das vias do município.',
    description: null,
    status: 'DRAFT',
    priority: 'MEDIUM',
    organization: { id: ORG_MAIN.id, shortName: 'PMSJ' },
    requestingSecretariat: { id: OBRAS.id, name: OBRAS.name },
    requestingDepartment: { id: MANUTENCAO.id, name: MANUTENCAO.name },
    contractingType: { id: AQUISICAO.id, code: AQUISICAO.code, label: AQUISICAO.label },
    modality: null,
    origin: { id: NAO_PREVISTA.id, code: NAO_PREVISTA.code, label: NAO_PREVISTA.label },
    isPriceRegistration: false,
    currentStage: {
      id: ID(302),
      key: 'ABERTURA',
      name: 'Formalização da demanda',
      dueAt: null,
      instructions: null,
      documentTypeCodes: ['DFD'],
    },
    currentDepartment: { id: MANUTENCAO.id, name: MANUTENCAO.name },
    currentResponsible: { id: ID(1), name: 'Ana Souza' },
    workflow: { id: ID(300), name: WORKFLOW_RESOLUTION.name, versionNumber: 1 },
    targetDate: null,
    estimatedValue: null,
    estimatedValueMasked: false,
    estimatedValueSource: null,
    isBudgetConfidential: false,
    pcaStatus: 'NOT_APPLICABLE',
    pcaYear: null,
    pcaItemCode: null,
    pcaJustification: null,
    notes: null,
    creationChannel: 'WEB',
    duplicatedFromId: null,
    openedAt: '2026-10-16T13:00:00.000Z',
    createdAt: '2026-10-16T13:00:00.000Z',
    updatedAt: '2026-10-16T13:00:00.000Z',
    createdBy: { id: ID(1), name: 'Ana Souza' },
    version: 1,
    ...extra,
  };
}

export const PLANEJAMENTO = { id: ID(13), name: 'Setor de Planejamento' };
export const MARCOS = { id: ID(2), name: 'Marcos Vinícius Rocha' };
export const DFD_ID = ID(501);
export const ETP_ID = ID(502);
export const RULE_ETP = ID(601);
export const RULE_RISK = ID(602);

/** PRC-07 do Background da US-004: 0012/2026 em ESTUDOS_PRELIMINARES com Marcos. */
export function summaryDto(extra: Partial<ProcessSummaryDto> = {}): ProcessSummaryDto {
  return {
    header: {
      code: '0012/2026',
      title: 'Aquisição de cimento para manutenção de vias',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      tags: [],
      isBudgetConfidential: false,
      estimatedValue: '85000.00',
      estimatedValueMasked: false,
      estimatedValueSource: 'DFD',
      organization: { id: ORG_MAIN.id, shortName: 'PMSJ' },
      showOrganization: false,
    },
    where: {
      stage: {
        key: 'ESTUDOS_PRELIMINARES',
        name: 'ETP e mapa de riscos',
        type: 'TASK',
        groupLabel: 'Planejamento',
      },
      department: PLANEJAMENTO,
      status: 'IN_PROGRESS',
      statusBeforeSuspension: null,
      suspensionReason: null,
      suspendedAt: null,
      completedAt: null,
      canceledAt: null,
      cancellationReason: null,
    },
    responsible: {
      user: { ...MARCOS, jobTitle: 'Analista de Planejamento' },
      queueDepartment: null,
      since: '2026-10-01T12:10:00.000Z',
      approver: null,
    },
    pending: {
      blockingCount: 1,
      warningCount: 1,
      items: [
        {
          ruleId: RULE_ETP,
          name: 'ETP completo',
          type: 'REQUIRED_DOCUMENT',
          severity: 'BLOCKING',
          message: 'O ETP deve estar completo.',
          evaluationFailed: false,
          link: { documentId: ETP_ID, restricted: false },
        },
        {
          ruleId: RULE_RISK,
          name: 'Mapa de riscos',
          type: 'REQUIRED_DOCUMENT',
          severity: 'WARNING',
          message: 'Recomenda-se elaborar o mapa de riscos.',
          evaluationFailed: false,
          link: { createDocumentTypeCode: 'RISK_MAP' },
        },
      ],
    },
    nextStep: {
      action: {
        action: 'FORWARD',
        transitionKey: 'ESTUDOS_PARA_PESQUISA',
        label: 'Encaminhar para Pesquisa de preços',
        enabled: false,
        reasons: [
          { code: 'TRANSITION_BLOCKED', message: 'Há 1 pendência obrigatória nesta etapa.' },
        ],
      },
      instructions: 'Elabore o **ETP** e o mapa de riscos.\n\n- Anexe a pesquisa preliminar',
    },
    deadline: {
      dueAt: '2026-10-08T02:59:59.000Z',
      slaType: 'BUSINESS',
      daysLeft: 2,
      overdueDays: null,
      isDueSoon: true,
      isOverdue: false,
      isPaused: false,
    },
    target: { targetDate: '2026-11-30', isOverdue: false, overdueDays: null },
    documents: [
      {
        id: DFD_ID,
        typeCode: 'DFD',
        typeName: 'DFD',
        code: 'DFD 0005/2026',
        title: 'DFD — cimento',
        status: 'APPROVED',
        versionNumber: 2,
        confidentiality: 'INTERNAL',
        restricted: false,
        inApproval: false,
      },
      {
        id: ETP_ID,
        typeCode: 'ETP',
        typeName: 'ETP',
        code: 'ETP 0003/2026',
        title: 'ETP — cimento',
        status: 'DRAFT',
        versionNumber: null,
        confidentiality: 'INTERNAL',
        restricted: false,
        inApproval: false,
      },
    ],
    approvals: [],
    counts: { documents: 2, items: 3, comments: 5, participants: 1 },
    version: 9,
    ...extra,
  };
}

type StagePass = ProcessStageEntryDto['passes'][number];

function stagePass(n: number, sequence: number, status: StagePass['status']): StagePass {
  return {
    processStageId: ID(800 + n),
    sequence,
    status,
    department: PLANEJAMENTO,
    assignee: MARCOS,
    enteredAt: '2026-09-20T12:00:00.000Z',
    exitedAt: status === 'ACTIVE' ? null : '2026-09-22T12:00:00.000Z',
    dueAt: null,
    dueDateOverridden: false,
    overdueSince: null,
  };
}

function stageEntry(
  n: number,
  key: string,
  name: string,
  groupLabel: string,
  extra: Partial<ProcessStageEntryDto> = {},
): ProcessStageEntryDto {
  return {
    workflowStageId: ID(700 + n),
    key,
    name,
    type: 'TASK',
    groupLabel,
    displayOrder: n,
    slaDays: 5,
    slaType: 'BUSINESS',
    lastPassStatus: null,
    isCurrent: false,
    passes: [],
    ...extra,
  };
}

/** PRC-10: devolvido uma vez de APROVACAO_DFD para ABERTURA e depois aprovado. */
export function stagesDto(): ProcessStageEntryDto[] {
  return [
    stageEntry(0, 'ABERTURA', 'Formalização da demanda', 'Demanda', {
      type: 'START',
      lastPassStatus: 'COMPLETED',
      passes: [stagePass(1, 1, 'COMPLETED'), stagePass(3, 3, 'COMPLETED')],
    }),
    stageEntry(1, 'APROVACAO_DFD', 'Aprovação da demanda', 'Demanda', {
      type: 'APPROVAL',
      lastPassStatus: 'COMPLETED',
      passes: [stagePass(2, 2, 'RETURNED'), stagePass(4, 4, 'COMPLETED')],
    }),
    stageEntry(2, 'ESTUDOS_PRELIMINARES', 'ETP e mapa de riscos', 'Planejamento', {
      lastPassStatus: 'ACTIVE',
      isCurrent: true,
      passes: [stagePass(5, 5, 'ACTIVE')],
    }),
    stageEntry(3, 'PESQUISA_PRECOS', 'Pesquisa de preços', 'Planejamento'),
    stageEntry(4, 'CONCLUSAO', 'Planejamento da contratação concluído', 'Conclusão', {
      type: 'END',
      slaDays: null,
      slaType: null,
    }),
  ];
}

export const CANDIDATE: DuplicateCandidate = {
  id: ID(401),
  code: '0011/2026',
  title: 'Aquisição de cimento p/ manutenção das vias',
  status: 'DRAFT',
  createdAt: '2026-10-16T12:57:00.000Z',
  createdBy: { id: ID(1), name: 'Ana Souza' },
};

export function problemResponse(
  status: number,
  code: string,
  extra: {
    errors?: { field: string; code: string; message: string }[];
    correlationId?: string;
    extension?: Record<string, unknown>;
    detail?: string;
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase().replaceAll('_', '-')}`,
      title: code,
      status,
      detail: extra.detail ?? code,
      instance: '/api/v1/processes',
      code,
      correlationId: extra.correlationId ?? 'c-test',
      errors: extra.errors ?? [],
      violations: [],
      ...extra.extension,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

export type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export interface ProcessApiOptions {
  permissions?: readonly string[];
  scopes?: PermissionScopeDto[];
  organizations?: OrganizationDto[];
  settings?: Record<string, unknown>;
  /** Lotações do vínculo no ME-03 (`implicit.ownDepartmentIds`; padrão: Setor de Manutenção). */
  lotations?: readonly string[];
  catalogs?: Partial<Record<CatalogType, CatalogItemDto[] | Handler>>;
  departments?: DepartmentDto[];
  duplicates?: Handler;
  resolve?: Handler;
  create?: Handler;
  process?: Handler;
  /** PRC-05 (US-005). */
  update?: Handler;
  summary?: Handler;
  stages?: Handler;
  actions?: Handler;
  /** PRC-13..17 (US-006): `/processes/{id}/items…` e `/process-items/{itemId}`. */
  items?: Handler;
  /**
   * RSK-01..08 (US-033/034): `/processes/{id}/risks`, `/risks/{riskId}…` e
   * `/risk-treatments/{treatmentId}`.
   */
  risks?: Handler;
  /**
   * RSK-09/10 e o DOC-08 lido pela aba "Matriz" (US-035): `/processes/{id}/risk-matrix`,
   * `/processes/{id}/risk-map` e `/documents/{id}/validation`.
   */
  riskMap?: Handler;
  /** DOC-01 (US-062): `/processes/{id}/documents`. */
  documents?: Handler;
  /** PRC-11 (US-054): `/processes/{id}/movements` — padrão: histórico vazio, sem IP. */
  movements?: Handler;
  /** DTY-01 (US-062): `/document-types` (tipos ativos). */
  documentTypes?: Handler;
  /** PRC-27 (US-011): `POST /processes/{id}/duplicate`. */
  duplicate?: Handler;
  /**
   * PRC-28..32 e as buscas USR-02/DEP-02 (US-012): `/processes/{id}/participants`,
   * `/process-participants/{id}`, `/processes/{id}/follow`, `/users/lookup` e `/departments/lookup`.
   */
  participants?: Handler;
  /** PRC-33 (US-013): `PUT /processes/{id}/confidentiality`. */
  confidentiality?: Handler;
  /** CMT-01..04 (US-071): `/processes/{id}/comments` e `/comments/{commentId}`. */
  comments?: Handler;
  /** CMT-05 (US-072): `/processes/{id}/mention-candidates?q=` (padrão: nenhum candidato). */
  mentionCandidates?: Handler;
  /** TAG-01..03 e PRC-18 (US-007): `/tags`, `/tags/{id}` e `PUT /processes/{id}/tags`. */
  tags?: Handler;
}

/** `fetch` simulado das leituras de apoio, PRC-02/03/04 e WF-06. */
export function mockProcessApi(options: ProcessApiOptions = {}) {
  const permissions = options.permissions ?? ['PROCESS_CREATE'];
  const scopes = options.scopes ?? [{ type: 'TENANT', includeSubtree: false }];
  const organizations = options.organizations ?? [ORG_MAIN];
  const departments = options.departments ?? DEPARTMENTS;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const respond = (handler: Handler | undefined, fallback: () => Response) =>
      Promise.resolve((handler ?? fallback)(url, init));

    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: permissions.map((code) => ({ code, scopes })),
            implicit: {
              headOfDepartmentIds: [],
              ownDepartmentIds: options.lotations ?? [MANUTENCAO.id],
            },
          },
        }),
      );
    }
    if (url.startsWith('/api/v1/organizations?')) {
      return Promise.resolve(jsonResponse({ data: organizations, meta: { page: 1 } }));
    }
    if (url.startsWith('/api/v1/settings/public')) {
      return Promise.resolve(jsonResponse({ data: options.settings ?? {} }));
    }
    const catalog = /^\/api\/v1\/catalogs\/([A-Z_]+)\/items\?/.exec(url);
    if (catalog && method === 'GET') {
      const type = catalog[1] as CatalogType;
      const configured = options.catalogs?.[type];
      if (typeof configured === 'function') return respond(configured, () => jsonResponse({}));
      const items = configured ?? CATALOGS[type] ?? [];
      return Promise.resolve(jsonResponse({ data: items, meta: { page: 1 } }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/departments?')) {
      const organizationId = new URL(url, 'http://x').searchParams.get('organizationId');
      const list = departments.filter((item) => item.organizationId === organizationId);
      return Promise.resolve(
        jsonResponse({ data: list, meta: { page: 1, totalItems: list.length } }),
      );
    }
    if (method === 'POST' && url === '/api/v1/processes/check-duplicates') {
      return respond(options.duplicates, () => jsonResponse({ data: { candidates: [] } }));
    }
    if (method === 'POST' && url === '/api/v1/workflows/resolve') {
      return respond(options.resolve, () => jsonResponse({ data: WORKFLOW_RESOLUTION }));
    }
    if (method === 'POST' && url === '/api/v1/processes') {
      return respond(options.create, () =>
        jsonResponse(
          { data: processDto() },
          {
            status: 201,
            headers: { Location: `/api/v1/processes/${PROCESS_ID}`, ETag: '"1"' },
          },
        ),
      );
    }
    if (method === 'POST' && url === `/api/v1/processes/${PROCESS_ID}/duplicate`) {
      return respond(options.duplicate, () =>
        jsonResponse(
          { data: processDto({ id: ID(410), code: '0045/2026', duplicatedFromId: PROCESS_ID }) },
          { status: 201, headers: { Location: `/api/v1/processes/${ID(410)}`, ETag: '"1"' } },
        ),
      );
    }
    if (method === 'GET' && url === `/api/v1/processes/${PROCESS_ID}`) {
      return respond(options.process, () => jsonResponse({ data: processDto() }));
    }
    if (method === 'PATCH' && url === `/api/v1/processes/${PROCESS_ID}`) {
      return respond(options.update, () => jsonResponse({ data: processDto({ version: 2 }) }));
    }
    if (method === 'PUT' && url === `/api/v1/processes/${PROCESS_ID}/confidentiality`) {
      return respond(options.confidentiality, () =>
        jsonResponse(
          { data: processDto({ isBudgetConfidential: true, version: 2 }) },
          { headers: { ETag: '"2"' } },
        ),
      );
    }
    if (method === 'GET' && url === `/api/v1/processes/${PROCESS_ID}/summary`) {
      return respond(options.summary, () => jsonResponse({ data: summaryDto() }));
    }
    if (method === 'GET' && url === `/api/v1/processes/${PROCESS_ID}/stages`) {
      return respond(options.stages, () => jsonResponse({ data: stagesDto() }));
    }
    if (url.startsWith('/api/v1/tags') || url === `/api/v1/processes/${PROCESS_ID}/tags`) {
      return respond(options.tags, () => jsonResponse({ data: [] }));
    }
    if (
      url.includes(`/processes/${PROCESS_ID}/items`) ||
      url.startsWith('/api/v1/process-items/')
    ) {
      return respond(options.items, () => jsonResponse({ data: [] }, { headers: { ETag: '"1"' } }));
    }
    if (
      url.includes(`/processes/${PROCESS_ID}/risk-matrix`) ||
      url.includes(`/processes/${PROCESS_ID}/risk-map`) ||
      /^\/api\/v1\/documents\/[^/]+\/validation/.test(url)
    ) {
      return respond(options.riskMap, () => problemResponse(404, 'NOT_FOUND'));
    }
    if (
      url.includes(`/processes/${PROCESS_ID}/risks`) ||
      url.startsWith('/api/v1/risks/') ||
      url.startsWith('/api/v1/risk-treatments/')
    ) {
      return respond(options.risks, () =>
        jsonResponse({ data: [], meta: { canManage: false, lockReason: 'PERMISSION_DENIED' } }),
      );
    }
    if (method === 'GET' && url.startsWith(`/api/v1/processes/${PROCESS_ID}/documents`)) {
      return respond(options.documents, () =>
        jsonResponse({
          data: [],
          meta: { currentStage: null, creatableTypeIds: [], pendingTypeIds: [] },
        }),
      );
    }
    if (method === 'GET' && url.startsWith(`/api/v1/processes/${PROCESS_ID}/movements`)) {
      return respond(options.movements, () =>
        jsonResponse({ data: [], meta: { nextCursor: null, hasMore: false, canViewIp: false } }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/document-types')) {
      return respond(options.documentTypes, () => jsonResponse({ data: [] }));
    }
    if (
      url.includes(`/processes/${PROCESS_ID}/participants`) ||
      url.includes(`/processes/${PROCESS_ID}/follow`) ||
      url.startsWith('/api/v1/process-participants/') ||
      url.startsWith('/api/v1/users/lookup') ||
      url.startsWith('/api/v1/departments/lookup')
    ) {
      return respond(options.participants, () =>
        jsonResponse({ data: [], meta: { canManage: false, me: null } }),
      );
    }
    if (url.includes('/available-actions')) {
      return respond(options.actions, () => jsonResponse({ data: [] }));
    }
    if (url.includes(`/processes/${PROCESS_ID}/mention-candidates`)) {
      return respond(options.mentionCandidates, () => jsonResponse({ data: [] }));
    }
    if (url.includes(`/processes/${PROCESS_ID}/comments`) || url.startsWith('/api/v1/comments/')) {
      return respond(options.comments, () =>
        jsonResponse({
          data: [],
          meta: {
            nextCursor: null,
            hasMore: false,
            canComment: false,
            readOnly: false,
            isBudgetConfidential: false,
          },
        }),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export type ProcessApiMock = ReturnType<typeof mockProcessApi>;

export function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
}

/** Chamadas ao endpoint (método + caminho exato). */
export function callsTo(api: ProcessApiMock, method: string, url: string) {
  return api.mock.calls
    .filter(([input, init]) => requestUrl(input) === url && (init?.method ?? 'GET') === method)
    .map(([input, init]) => ({
      url: requestUrl(input),
      init,
      headers: new Headers(init?.headers),
      body: bodyOf(init),
    }));
}
