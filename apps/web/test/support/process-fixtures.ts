// Dados e API simulada do wizard "Novo processo" e do painel do processo (US-001 · SCR-005/006).
import type { CatalogType } from '@contrataflow/types';
import type {
  CatalogItemDto,
  DepartmentDto,
  DuplicateCandidate,
  OrganizationDto,
  PermissionScopeDto,
  ProcessDto,
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

export const CATALOGS: Partial<Record<CatalogType, CatalogItemDto[]>> = {
  CONTRACTING_TYPE: [AQUISICAO, SERVICOS],
  MODALITY: [PREGAO],
  PROCESS_ORIGIN: [NAO_PREVISTA, PLANO_ANUAL],
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
    openedAt: '2026-10-16T13:00:00.000Z',
    createdAt: '2026-10-16T13:00:00.000Z',
    updatedAt: '2026-10-16T13:00:00.000Z',
    createdBy: { id: ID(1), name: 'Ana Souza' },
    version: 1,
    ...extra,
  };
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
    if (method === 'GET' && url === `/api/v1/processes/${PROCESS_ID}`) {
      return respond(options.process, () => jsonResponse({ data: processDto() }));
    }
    if (url.includes('/available-actions')) {
      return Promise.resolve(jsonResponse({ data: [] }));
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
