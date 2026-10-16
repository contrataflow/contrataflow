// API simulada do E2E do shell (US-086): responde às rotas internas da US-080 (`/_internal/*`) e
// a ME-03, exige o Bearer emitido pelo BFF e permite injetar falhas por `POST /__mock/fail`.
// Sem dependências: `node test/e2e/support/mock-api.mjs <porta>`.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 4010);
const failures = new Map();
const replays = new Map();

// Tipos de documento (US-061 · DTY-01..03): catálogo em memória, só o necessário para a jornada do SCR-108.
const EDITABLE_ALL = [
  'name',
  'description',
  'allowMultiplePerProcess',
  'numberingEnabled',
  'numberingMask',
  'requiresApproval',
  'approvalPolicy',
  'defaultConfidentiality',
  'sortOrder',
  'isActive',
];
const EDITABLE_SYSTEM = EDITABLE_ALL.filter((field) => field !== 'allowMultiplePerProcess');
const documentTypes = [
  ['DFD', 'Documento de Formalização da Demanda', 'STRUCTURED', 'DFD', 10, null],
  ['ETP', 'Estudo Técnico Preliminar', 'STRUCTURED', 'ETP', 20, null],
  ['OFICIO', 'Ofício', 'FREE_TEXT', null, 70, 'OF {seq:4}/{year}'],
  ['DOCUMENTO_EXTERNO', 'Documento externo', 'UPLOADED', null, 110, null],
].map(([code, name, kind, systemModule, sortOrder, numberingMask], index) => ({
  id: `0192a000-0000-7000-8000-00000000d0${String(index).padStart(2, '0')}`,
  code,
  name,
  description: null,
  kind,
  systemModule,
  isSystem: true,
  isActive: true,
  allowMultiplePerProcess: kind !== 'STRUCTURED',
  numberingEnabled: code !== 'DOCUMENTO_EXTERNO',
  numberingMask,
  requiresApproval: false,
  approvalPolicy: null,
  defaultConfidentiality: 'INTERNAL',
  defaultTemplate: null,
  sortOrder,
  editableFields:
    kind === 'STRUCTURED' ? EDITABLE_SYSTEM.filter((f) => f !== 'isActive') : EDITABLE_SYSTEM,
  version: 1,
}));

// Configurações do tenant (US-103 · SET-01..03): um subconjunto de chaves de grupos diferentes, com
// versão por chave e conferência de `expectedVersions` no PATCH em lote (tudo ou nada).
const settings = new Map([
  ['labels.secretariat', { value: 'Secretaria', version: 1 }],
  ['labels.department', { value: 'Setor', version: 1 }],
  ['branding.primaryColor', { value: '#1D4ED8', version: 1 }],
  ['numbering.process.mask', { value: '{seq:4}/{year}', version: 1 }],
  ['security.sessionIdleMinutes', { value: 30, version: 1 }],
]);
const PUBLIC_SETTINGS = ['labels.secretariat', 'labels.department', 'branding.primaryColor'];

// Catálogos (US-104 · CAT-01..06): modalidades de sistema + um item próprio, só o necessário para o
// SCR-109. Versão por item com `If-Match`; a reordenação recebe a lista completa de IDs.
const catalogItems = [
  ['PREGAO', 'Pregão', 'Lei 14.133/2021, art. 28, I', false],
  ['CONCORRENCIA', 'Concorrência', 'Lei 14.133/2021, art. 28, II', false],
  ['DISPENSA', 'Dispensa de licitação', 'Lei 14.133/2021, art. 75', true],
].map(([code, label, legalBasis, isDirectContracting], index) => ({
  id: `0192a000-0000-7000-8000-00000000c1${String(index).padStart(2, '0')}`,
  catalogType: 'MODALITY',
  code,
  label,
  description: null,
  isSystem: true,
  isActive: true,
  sortOrder: index + 1,
  parentId: null,
  metadata: { legalBasis, isDirectContracting },
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  version: 1,
}));

// Calendário (US-106 · CAL-01..04): feriados de 2026 (Natal de sistema, Carnaval facultativo e um
// feriado municipal próprio), só o necessário para o SCR-110. Versão por feriado com `If-Match`;
// feriado de sistema nunca é excluído nem renomeado.
const holidays = [
  ['2026-02-17', 'Carnaval (terça-feira)', 'OPTIONAL', true, 'c3'],
  ['2026-10-12', 'Aniversário da cidade', 'MUNICIPAL', false, 'c4'],
  ['2026-12-25', 'Natal', 'NATIONAL', true, 'c5'],
].map(([date, name, scope, isSystem, key]) => ({
  id: `0192a000-0000-7000-8000-00000000${key}00`,
  date,
  name,
  scope,
  isRecurring: isSystem,
  isActive: true,
  isSystem,
  version: 1,
}));

// Órgãos (US-101 · ORG-01..04): um órgão principal ativo e um fundo, só o necessário para o SCR-032.
const organizations = [
  ['PMSJ', 'Prefeitura Municipal de São José', '11222333000181', 'DIRECT_ADMINISTRATION'],
  ['FMS', 'Fundo Municipal de Saúde', '11444777000161', 'FUND'],
].map(([shortName, name, cnpj, type], index) => ({
  id: `0192a000-0000-7000-8000-00000000f1${String(index).padStart(2, '0')}`,
  name,
  shortName,
  cnpj,
  type,
  isActive: true,
  isPrimary: index === 0,
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
}));

// Secretarias e setores (US-102 · DEP-01..09): o "Gabinete" do órgão principal tem pessoas lotadas
// (em uso — DEP-09 responde 409); o resto da árvore é montado pela jornada do SCR-032.
const departments = [];
function newDepartment(organizationId, parent, body) {
  const id = randomUUID();
  return {
    id,
    organizationId,
    parentId: parent?.id ?? null,
    type: body.type,
    name: String(body.name ?? '').trim(),
    acronym: body.acronym ? String(body.acronym).trim().toUpperCase() : null,
    code: body.code ?? null,
    email: body.email ?? null,
    phone: body.phone ?? null,
    headUserId: null,
    deputyUserId: null,
    isActive: true,
    isSecretariat: parent === null || ['SECRETARIAT', 'BOARD'].includes(body.type),
    sortOrder: body.sortOrder ?? 0,
    path: `${parent?.path ?? '/'}${id}/`,
    depth: parent ? parent.depth + 1 : 0,
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
    inUse: false,
  };
}
departments.push({
  ...newDepartment(organizations[0].id, null, { type: 'SECRETARIAT', name: 'Gabinete' }),
  inUse: true,
});
// Segunda secretaria, destino da troca de lotação do SCR-029 (US-092).
departments.push(
  newDepartment(organizations[0].id, null, { type: 'SECRETARIAT', name: 'Licitações' }),
);
/** Lista plana na ordem da árvore (pais antes dos filhos; irmãos por ordem e nome). */
function departmentTree(organizationId) {
  const units = departments.filter((unit) => unit.organizationId === organizationId);
  const out = [];
  const visit = (parentId) => {
    units
      .filter((unit) => unit.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pt-BR'))
      .forEach((unit) => {
        out.push(unit);
        visit(unit.id);
      });
  };
  visit(null);
  return out;
}
function departmentView(unit) {
  const { inUse: _inUse, ...view } = unit;
  return view;
}

function previewOf(type) {
  if (!type.numberingEnabled) return null;
  const mask = type.numberingMask ?? '{type} {seq:4}/{year}';
  return mask
    .replace(/\{seq:(\d)\}/, (_m, width) => '1'.padStart(Number(width), '0'))
    .replace('{year}', String(new Date().getFullYear()))
    .replace('{type}', type.code);
}

function documentTypeView(type) {
  // US-108: o padrão do tipo com a versão publicada corrente do template.
  const template = templates.find((item) => item.id === type.defaultTemplateId);
  const published = templateVersions.find(
    (version) => version.id === template?.currentPublishedVersionId,
  );
  const { defaultTemplateId: _defaultTemplateId, ...rest } = type;
  return {
    ...rest,
    nextNumberPreview: previewOf(type),
    defaultTemplate:
      template && published
        ? { id: template.id, name: template.name, versionNumber: published.versionNumber }
        : null,
  };
}

// Perfis (US-095 · ROL-01..08): catálogo reduzido e perfis em memória, só o necessário para a
// jornada do SCR-030/031. Ana tem ROLE_VIEW/ROLE_MANAGE mas não é ADMIN_ORGAO (POL-13 vale).
const catalog = [
  ['PROCESS_VIEW', 'process', 'Visualizar processos', 'LOW'],
  ['PROCESS_CREATE', 'process', 'Criar processos', 'MEDIUM'],
  ['SUPPLIER_VIEW', 'supplier', 'Visualizar fornecedores', 'LOW'],
  ['USER_MANAGE', 'identity', 'Gerenciar usuários', 'HIGH'],
  ['ROLE_VIEW', 'access', 'Visualizar perfis', 'LOW'],
  ['ROLE_MANAGE', 'access', 'Gerenciar perfis', 'HIGH'],
  ['SETTINGS_MANAGE', 'tenancy', 'Gerenciar configurações gerais', 'HIGH'],
].map(([code, module, name, riskLevel]) => ({
  code,
  module,
  name,
  description: name,
  riskLevel,
  scopable: false,
  isDeprecated: false,
  introducedIn: 'MVP1',
}));
const ANA_PERMISSIONS = ['PROCESS_CREATE', 'SETTINGS_MANAGE', 'ROLE_VIEW', 'ROLE_MANAGE'];
const roles = [
  [
    'ADMIN_ORGAO',
    'Administrador do órgão',
    true,
    ['USER_MANAGE', 'ROLE_VIEW', 'ROLE_MANAGE', 'SETTINGS_MANAGE'],
  ],
  ['AUDITOR', 'Auditor', false, ['ROLE_VIEW']],
].map(([key, name, isProtected, permissions], index) => ({
  id: `0192a000-0000-7000-8000-0000000095${String(index).padStart(2, '0')}`,
  key,
  name,
  description: null,
  isSystem: true,
  isProtected,
  allowExternalAssignment: key === 'AUDITOR',
  isActive: true,
  activeAssignmentsCount: index === 0 ? 1 : 0,
  permissions,
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  version: 1,
}));

function roleKey(name) {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function newRole(name, description, permissions) {
  return {
    ...roles[1],
    id: randomUUID(),
    key: roleKey(name),
    name,
    description: description ?? null,
    isSystem: false,
    isProtected: false,
    allowExternalAssignment: false,
    activeAssignmentsCount: 0,
    permissions,
    version: 1,
  };
}

function roleSummary(role) {
  const { permissions: _permissions, ...summary } = role;
  return summary;
}

// Workflows (US-042 · WF-01/WF-05): os dois semeados (DEC-015) e um piloto sem versão publicada. A
// troca do padrão confere o If-Match do alvo e sobe a versão de todos (RN-WF-42).
const workflows = [
  {
    id: '0192a000-0000-7000-8000-00000000e042',
    key: 'DIRECT_CONTRACTING_ART72',
    name: 'Contratação direta — Lei 14.133/2021, art. 72',
    applicabilityRule: {
      in: [{ var: 'process.modalityCode' }, ['DISPENSA', 'INEXIGIBILIDADE']],
    },
    applicabilityPriority: 50,
    isDefault: false,
    published: true,
  },
  {
    id: '0192a000-0000-7000-8000-00000000e041',
    key: 'DEFAULT_PREPARATORY',
    name: 'Fase preparatória — Lei 14.133/2021',
    applicabilityRule: null,
    applicabilityPriority: 100,
    isDefault: true,
    published: true,
  },
  {
    id: '0192a000-0000-7000-8000-00000000e043',
    key: 'PILOTO_OBRAS',
    name: 'Piloto de obras',
    applicabilityRule: null,
    applicabilityPriority: 100,
    isDefault: false,
    published: false,
  },
].map(({ published, ...workflow }, index) => ({
  ...workflow,
  description: null,
  isActive: true,
  currentPublishedVersion: published
    ? {
        id: `0192a000-0000-7000-8000-00000000f04${index}`,
        versionNumber: 1,
        publishedAt: '2026-10-15T12:00:00.000Z',
      }
    : null,
  draftVersion: published
    ? null
    : { id: `0192a000-0000-7000-8000-00000000f05${index}`, versionNumber: 1 },
  version: 2,
}));

// Templates (US-107 · TPL-01..04/07/08): template + versão 1 em rascunho; o PATCH da versão
// recusa variável desconhecida com 422 TEMPLATE_INVALID na seção (o resto das regras é da API).
const templates = [];
const templateVersions = [];
const KNOWN_VARIABLES = new Set([
  'tenant.name',
  'organization.name',
  'organization.cnpj',
  'organization.address',
  'process.code',
  'process.title',
  'process.object',
  'process.requestingSecretariat',
  'process.requestingDepartment',
  'document.code',
  'document.title',
  'document.date',
  'today',
  'user.name',
]);
const TEMPLATE_LAYOUT = {
  pageSize: 'A4',
  orientation: 'portrait',
  marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
  fontFamily: 'Inter',
  fontSizePt: 11,
  lineHeight: 1.15,
  showPageNumbers: true,
  showDocumentHashInFooter: true,
  draftWatermark: true,
};
function mockUuid() {
  return `0192a000-0000-7000-8000-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
// Usuários e convites (US-091 · USR-01/03..06/14): convites pendentes em memória; o token de
// `/convite/<token>` válido e o expirado são fixos (43 caracteres base64url).
const INVITE_TOKEN = 'A'.repeat(43);
const INVITE_TOKEN_EXPIRED = 'E'.repeat(43);
const invitations = [];
function newInvitation(email, body) {
  return {
    id: mockUuid(),
    userId: mockUuid(),
    name: String(body.name ?? '').trim(),
    socialName: null,
    email,
    type: body.type ?? 'INTERNAL',
    status: 'INVITED',
    jobTitle: body.jobTitle ?? null,
    registrationNumber: null,
    expiresAt: body.expiresAt ?? null,
    departmentIds: body.departmentIds ?? [],
    primaryDepartmentId: body.departmentIds?.[0] ?? null,
    invitedAt: '2026-10-15T12:00:00.000Z',
    inviteExpiresAt: '2026-10-22T12:00:00.000Z',
    activatedAt: null,
    version: 1,
  };
}
// Vínculos já ativados do tenant (US-092 · USR-01/07..12): Diego, lotado no Gabinete.
const members = [
  {
    ...newInvitation('diego@exemplo.gov.br', {
      name: 'Diego Ramos',
      type: 'INTERNAL',
      jobTitle: 'Analista de Compras',
      departmentIds: [departments[0].id],
    }),
    status: 'ACTIVE',
    registrationNumber: '12345',
    inviteExpiresAt: null,
    activatedAt: '2026-10-02T12:00:00.000Z',
    suspendedAt: null,
    suspensionReason: null,
    revokedAt: null,
    revocationReason: null,
  },
];
const MEMBER_ACTIONS = {
  ACTIVE: ['UPDATE', 'UPDATE_DEPARTMENTS', 'SUSPEND', 'REVOKE'],
  SUSPENDED: ['UPDATE', 'UPDATE_DEPARTMENTS', 'REACTIVATE', 'REVOKE'],
  REVOKED: [],
};
function memberDetail(member) {
  const unit = (id) => departments.find((item) => item.id === id);
  return {
    ...member,
    departments: member.departmentIds
      .map((id) => ({
        id,
        name: unit(id)?.name ?? id,
        isActive: unit(id)?.isActive ?? false,
        isPrimary: id === member.primaryDepartmentId,
      }))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
  };
}
function sendMember(response, member) {
  return send(
    response,
    200,
    {
      data: memberDetail(member),
      meta: { allowedActions: MEMBER_ACTIONS[member.status] ?? [], isSelf: false },
    },
    { ETag: `"${member.version}"` },
  );
}
function templateTypeOf(template) {
  const type = documentTypes.find((item) => item.id === template.documentTypeId);
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    kind: type.kind,
    systemModule: type.systemModule,
    defaultConfidentiality: type.defaultConfidentiality,
  };
}
function versionSummary(version) {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    sectionCount: version.sections.length,
    updatedAt: version.updatedAt,
    publishedAt: version.publishedAt,
  };
}
function templateView(template) {
  const draft = templateVersions.find(
    (version) => version.templateId === template.id && version.status === 'DRAFT',
  );
  const published = templateVersions.find(
    (version) => version.id === template.currentPublishedVersionId,
  );
  return {
    ...template,
    documentType: templateTypeOf(template),
    isDefault: documentTypes.some(
      (type) => type.isActive && type.defaultTemplateId === template.id,
    ),
    draftVersion: draft
      ? {
          id: draft.id,
          versionNumber: draft.versionNumber,
          status: draft.status,
          sectionCount: draft.sections.length,
          updatedAt: draft.updatedAt,
          publishedAt: null,
        }
      : null,
    currentPublishedVersion: published ? versionSummary(published) : null,
  };
}
// US-108 (TPL-05): histórico sem o conteúdo.
function versionHistoryItem(version) {
  const template = templates.find((item) => item.id === version.templateId);
  return {
    id: version.id,
    templateId: version.templateId,
    versionNumber: version.versionNumber,
    status: version.status,
    sectionCount: version.sections.length,
    changeNotes: version.changeNotes,
    isCurrent: template.currentPublishedVersionId === version.id,
    publishedAt: version.publishedAt,
    retiredAt: version.retiredAt,
    contentHash: version.contentHash,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    version: version.version,
  };
}
function templateVersionView(version) {
  const template = templates.find((item) => item.id === version.templateId);
  return { ...version, templateName: template.name, documentType: templateTypeOf(template) };
}
function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textOf).join('\n');
}
function unknownVariables(section) {
  const text = `${section.helpText ?? ''} ${textOf(section.defaultContent)}`;
  return [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((name) => !KNOWN_VARIABLES.has(name));
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

function problem(response, status, code, correlationId) {
  send(
    response,
    status,
    {
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase().replaceAll('_', '-')}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1',
      code,
      correlationId,
      errors: [],
      violations: [],
    },
    { 'Content-Type': 'application/problem+json', 'X-Correlation-Id': correlationId },
  );
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      resolve(raw);
    });
  });
}

/** O token traz segundo fator (`amr` com `otp`)? — RN-IAM-83 no PATCH de perfil. */
function hasMfa(authorization) {
  const token = (authorization ?? '').replace(/^Bearer /, '');
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return Array.isArray(claims.amr) && claims.amr.includes('otp');
  } catch {
    return false;
  }
}

function subject(authorization) {
  const token = (authorization ?? '').replace(/^Bearer /, '');
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).sub ?? null;
  } catch {
    return null;
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  const correlationId = request.headers['x-correlation-id'] ?? randomUUID();

  if (url.pathname === '/__mock/health') return send(response, 200, { status: 'ok' });
  if (url.pathname === '/__mock/fail') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (body.status) failures.set(body.path, body);
    else failures.delete(body.path);
    return send(response, 204);
  }
  const forced = failures.get(url.pathname);
  if (forced) return problem(response, forced.status, forced.code, String(correlationId));

  const sub = subject(request.headers.authorization);
  if (!sub) return problem(response, 401, 'UNAUTHENTICATED', String(correlationId));
  const tenantId = request.headers['x-tenant-id'] ?? null;

  if (url.pathname === '/api/v1/me/permissions') {
    const permissions =
      sub === 'sub-ana'
        ? [
            { code: 'PROCESS_CREATE', scopes: ['TENANT'] },
            { code: 'DOCUMENT_TYPE_MANAGE', scopes: [] },
            { code: 'ORGANIZATION_MANAGE', scopes: [] },
            { code: 'SETTINGS_MANAGE', scopes: [] },
            { code: 'CATALOG_MANAGE', scopes: [] },
            { code: 'CALENDAR_MANAGE', scopes: [] },
            { code: 'ROLE_VIEW', scopes: [] },
            { code: 'ROLE_MANAGE', scopes: [] },
            { code: 'USER_VIEW', scopes: [] },
            { code: 'USER_INVITE', scopes: [] },
            { code: 'USER_MANAGE', scopes: [] },
            { code: 'DEPARTMENT_MANAGE', scopes: [] },
            { code: 'TEMPLATE_VIEW', scopes: [] },
            { code: 'TEMPLATE_MANAGE', scopes: [] },
            { code: 'TEMPLATE_PUBLISH', scopes: [] },
            { code: 'WORKFLOW_VIEW', scopes: [] },
            { code: 'WORKFLOW_PUBLISH', scopes: [] },
          ]
        : [];
    return send(response, 200, { data: { permissions, implicit: {} } });
  }
  if (url.pathname === '/api/v1/_internal/ping') {
    return send(
      response,
      200,
      { data: { status: 'ok', correlationId, tenantId, userId: sub, membershipId: null } },
      { 'X-Correlation-Id': String(correlationId) },
    );
  }
  if (url.pathname === '/api/v1/_internal/items') {
    const page = Number(url.searchParams.get('page') ?? 1);
    const items = Array.from({ length: 10 }, (_, index) => {
      const position = (page - 1) * 10 + index + 1;
      return { id: `item-${String(position).padStart(2, '0')}`, position };
    }).filter((item) => item.position <= 45);
    return send(response, 200, {
      data: items,
      meta: { page, pageSize: 10, totalItems: 45, totalPages: 5 },
    });
  }
  if (url.pathname === '/api/v1/_internal/echo' && request.method === 'POST') {
    const key = String(request.headers['idempotency-key'] ?? '');
    const body = JSON.parse((await readBody(request)) || '{}');
    const replayed = replays.get(key);
    if (replayed) return send(response, 201, replayed, { 'Idempotent-Replayed': 'true' });
    const created = {
      data: { id: randomUUID(), name: body.name, quantity: body.quantity ?? null },
    };
    if (key) replays.set(key, created);
    return send(response, 201, created);
  }
  if (url.pathname === '/api/v1/document-types' && request.method === 'GET') {
    const all = url.searchParams.get('includeInactive') === 'true';
    const list = documentTypes
      .filter((type) => all || type.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pt-BR'));
    return send(response, 200, { data: list.map(documentTypeView) });
  }
  if (url.pathname === '/api/v1/document-types' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (documentTypes.some((type) => type.code === body.code)) {
      return problem(response, 409, 'CONFLICT', String(correlationId));
    }
    const created = {
      id: randomUUID(),
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      kind: body.kind,
      systemModule: null,
      isSystem: false,
      isActive: true,
      allowMultiplePerProcess: body.allowMultiplePerProcess,
      numberingEnabled: body.numberingEnabled,
      numberingMask: body.numberingMask ?? null,
      requiresApproval: body.requiresApproval,
      approvalPolicy: body.approvalPolicy ?? null,
      defaultConfidentiality: body.defaultConfidentiality,
      defaultTemplate: null,
      sortOrder: body.sortOrder ?? 0,
      editableFields: EDITABLE_ALL,
      version: 1,
    };
    documentTypes.push(created);
    return send(
      response,
      201,
      { data: documentTypeView(created) },
      {
        ETag: '"1"',
        Location: `/api/v1/document-types/${created.id}`,
      },
    );
  }
  if (url.pathname === '/api/v1/settings' && request.method === 'GET') {
    return send(response, 200, { data: Object.fromEntries(settings) });
  }
  if (url.pathname === '/api/v1/settings/public' && request.method === 'GET') {
    return send(response, 200, {
      data: Object.fromEntries(PUBLIC_SETTINGS.map((key) => [key, settings.get(key)?.value])),
    });
  }
  if (url.pathname === '/api/v1/numbering/preview' && request.method === 'POST') {
    // SET-04 (US-105): exemplo com o próximo número hipotético 12 (processo) ou 5 (documento).
    const body = JSON.parse((await readBody(request)) || '{}');
    const next = body.documentTypeCode === undefined ? 12 : 5;
    const example = String(body.mask ?? '').replace(/\{([^{}]*)\}/g, (_token, name) => {
      if (name === 'year') return '2026';
      if (name === 'org') return 'PMSJ';
      if (name === 'type') return body.documentTypeCode ?? '';
      const width = Number(/^seq:(\d)$/.exec(name)?.[1] ?? 4);
      return String(next).padStart(width, '0');
    });
    return send(response, 200, { data: { example, nextValue: String(next) } });
  }
  if (url.pathname === '/api/v1/settings' && request.method === 'PATCH') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const keys = Object.keys(body.values ?? {});
    if (keys.some((key) => !settings.has(key))) {
      return problem(response, 422, 'SETTING_KEY_UNKNOWN', String(correlationId));
    }
    if (keys.some((key) => body.expectedVersions?.[key] === undefined)) {
      return problem(response, 428, 'PRECONDITION_REQUIRED', String(correlationId));
    }
    if (keys.some((key) => body.expectedVersions[key] !== settings.get(key).version)) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const updated = {};
    for (const key of keys) {
      const next = { value: body.values[key], version: settings.get(key).version + 1 };
      settings.set(key, next);
      updated[key] = next;
    }
    return send(response, 200, { data: updated });
  }
  if (url.pathname === '/api/v1/organizations' && request.method === 'GET') {
    const list = [...organizations].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return send(response, 200, {
      data: list,
      meta: { page: 1, pageSize: 100, totalItems: list.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/organizations' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const shortName = String(body.shortName ?? '').toUpperCase();
    const cnpj = String(body.cnpj ?? '').replace(/[./-]/g, '');
    if (organizations.some((org) => org.shortName === shortName || org.cnpj === cnpj)) {
      return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
    }
    const created = {
      ...organizations[1],
      id: randomUUID(),
      name: body.name,
      shortName,
      cnpj,
      type: body.type,
      isPrimary: false,
      isActive: true,
      version: 1,
    };
    organizations.push(created);
    return send(
      response,
      201,
      { data: created },
      { ETag: '"1"', Location: `/api/v1/organizations/${created.id}` },
    );
  }
  const catalogList = /^\/api\/v1\/catalogs\/([A-Z_]+)\/items$/.exec(url.pathname);
  if (catalogList && request.method === 'GET') {
    const items = catalogItems
      .filter((item) => item.catalogType === catalogList[1])
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return send(response, 200, {
      data: items,
      meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 },
    });
  }
  if (catalogList && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const type = catalogList[1];
    if (catalogItems.some((item) => item.catalogType === type && item.code === body.code)) {
      return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
    }
    const created = {
      id: `0192a000-0000-7000-8000-00000000c2${String(catalogItems.length).padStart(2, '0')}`,
      catalogType: type,
      code: body.code,
      label: body.label,
      description: body.description ?? null,
      isSystem: false,
      isActive: true,
      sortOrder:
        Math.max(0, ...catalogItems.filter((i) => i.catalogType === type).map((i) => i.sortOrder)) +
        1,
      parentId: null,
      metadata: body.metadata ?? {},
      createdAt: '2026-10-15T12:00:00.000Z',
      updatedAt: '2026-10-15T12:00:00.000Z',
      version: 1,
    };
    catalogItems.push(created);
    return send(response, 201, { data: created }, { ETag: '"1"' });
  }
  const catalogOrder = /^\/api\/v1\/catalogs\/([A-Z_]+)\/order$/.exec(url.pathname);
  if (catalogOrder && request.method === 'PUT') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const items = catalogItems.filter((item) => item.catalogType === catalogOrder[1]);
    const known = new Set(items.map((item) => item.id));
    if (body.orderedIds.length !== items.length || body.orderedIds.some((id) => !known.has(id))) {
      return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
    }
    body.orderedIds.forEach((id, index) => {
      const item = items.find((entry) => entry.id === id);
      if (item.sortOrder !== index + 1)
        Object.assign(item, { sortOrder: index + 1, version: item.version + 1 });
    });
    return send(response, 200, { data: [...items].sort((a, b) => a.sortOrder - b.sortOrder) });
  }
  const catalogItem =
    /^\/api\/v1\/catalog-items\/([0-9a-f-]{36})(?:\/(activate|deactivate))?$/.exec(url.pathname);
  if (catalogItem && (request.method === 'PATCH' || request.method === 'POST')) {
    const item = catalogItems.find((entry) => entry.id === catalogItem[1]);
    if (!item) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${item.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    if (catalogItem[2]) {
      Object.assign(item, { isActive: catalogItem[2] === 'activate', version: item.version + 1 });
    } else {
      const body = JSON.parse((await readBody(request)) || '{}');
      if (body.code !== undefined && body.code !== item.code) {
        return problem(response, 409, 'CATALOG_ITEM_SYSTEM', String(correlationId));
      }
      Object.assign(item, body, { version: item.version + 1 });
    }
    return send(response, 200, { data: item }, { ETag: `"${item.version}"` });
  }
  if (url.pathname === '/api/v1/holidays' && request.method === 'GET') {
    const year = url.searchParams.get('year') ?? '2026';
    const items = holidays
      .filter((holiday) => holiday.date.startsWith(`${year}-`))
      .sort((a, b) => a.date.localeCompare(b.date));
    return send(response, 200, {
      data: items,
      meta: { page: 1, pageSize: 200, totalItems: items.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/holidays' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (
      holidays.some(
        (holiday) =>
          holiday.date === body.date && holiday.name.toLowerCase() === body.name.toLowerCase(),
      )
    ) {
      return problem(response, 409, 'CONFLICT', String(correlationId));
    }
    const created = {
      id: `0192a000-0000-7000-8000-0000000c6${String(holidays.length).padStart(3, '0')}`,
      date: body.date,
      name: body.name,
      scope: body.scope,
      isRecurring: body.isRecurring ?? false,
      isActive: true,
      isSystem: false,
      version: 1,
    };
    holidays.push(created);
    return send(response, 201, { data: created }, { ETag: '"1"' });
  }
  const holidayRoute = /^\/api\/v1\/holidays\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (holidayRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const holiday = holidays.find((entry) => entry.id === holidayRoute[1]);
    if (!holiday) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${holiday.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    if (request.method === 'DELETE') {
      if (holiday.isSystem)
        return problem(response, 409, 'CATALOG_ITEM_SYSTEM', String(correlationId));
      holidays.splice(holidays.indexOf(holiday), 1);
      response.writeHead(204);
      return response.end();
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (body.name !== undefined && body.name !== holiday.name && holiday.isSystem) {
      return problem(response, 409, 'CATALOG_ITEM_SYSTEM', String(correlationId));
    }
    Object.assign(holiday, body, { version: holiday.version + 1 });
    return send(response, 200, { data: holiday }, { ETag: `"${holiday.version}"` });
  }
  if (url.pathname === '/api/v1/permissions' && request.method === 'GET') {
    return send(response, 200, { data: catalog });
  }
  if (url.pathname === '/api/v1/departments/lookup' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const found = departments
      .filter((unit) => unit.isActive && unit.name.toLowerCase().includes(q))
      .slice(0, 50)
      .map((unit) => ({ id: unit.id, name: unit.name, type: unit.type, path: unit.name }));
    return send(response, 200, { data: found });
  }
  if (url.pathname === '/api/v1/users' && request.method === 'GET') {
    const statuses = (url.searchParams.get('status') ?? '').split(',').filter(Boolean);
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const type = url.searchParams.get('type');
    const departmentId = url.searchParams.get('departmentId');
    const found = [...members, ...invitations]
      .filter((item) => statuses.length === 0 || statuses.includes(item.status))
      .filter((item) => !type || item.type === type)
      .filter((item) => !departmentId || item.departmentIds.includes(departmentId))
      .filter((item) => !q || `${item.name} ${item.email}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return send(response, 200, {
      data: found,
      meta: { page: 1, pageSize: 20, totalItems: found.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/users/invitations' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const email = String(body.email ?? '')
      .trim()
      .toLowerCase();
    if (email === 'existente@exemplo.gov.br' || invitations.some((item) => item.email === email)) {
      return problem(response, 409, 'MEMBERSHIP_ALREADY_EXISTS', String(correlationId));
    }
    const created = newInvitation(email, body);
    invitations.push(created);
    return send(response, 201, { data: created }, { ETag: '"1"' });
  }
  const invitationRoute = /^\/api\/v1\/users\/invitations\/([0-9a-f-]{36})(\/resend)?$/.exec(
    url.pathname,
  );
  if (invitationRoute) {
    const invited = invitations.find((item) => item.userId === invitationRoute[1]);
    if (!invited) return problem(response, 404, 'USER_NOT_FOUND', String(correlationId));
    if (invitationRoute[2] === '/resend' && request.method === 'POST') {
      invited.inviteExpiresAt = '2026-10-29T12:00:00.000Z';
      return send(response, 200, { data: { inviteExpiresAt: invited.inviteExpiresAt } });
    }
    if (!invitationRoute[2] && request.method === 'DELETE') {
      invitations.splice(invitations.indexOf(invited), 1);
      return send(response, 204);
    }
  }
  const memberRoute =
    /^\/api\/v1\/users\/([0-9a-f-]{36})(\/(departments|suspend|reactivate|revoke))?$/.exec(
      url.pathname,
    );
  if (memberRoute) {
    const member = members.find((item) => item.userId === memberRoute[1]);
    if (!member) return problem(response, 404, 'USER_NOT_FOUND', String(correlationId));
    const action = memberRoute[3];
    if (request.method === 'GET' && !action) return sendMember(response, member);
    if (String(request.headers['if-match'] ?? '') !== `"${member.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    const allowed = MEMBER_ACTIONS[member.status] ?? [];
    if (request.method === 'PATCH' && !action) {
      for (const field of ['jobTitle', 'registrationNumber']) {
        if (field in body) member[field] = body[field];
      }
    } else if (request.method === 'PUT' && action === 'departments') {
      if (!Array.isArray(body.departmentIds) || body.departmentIds.length === 0) {
        return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
      }
      member.departmentIds = body.departmentIds;
      member.primaryDepartmentId = body.primaryDepartmentId;
    } else if (request.method === 'POST' && action) {
      const required = { suspend: 'SUSPEND', reactivate: 'REACTIVATE', revoke: 'REVOKE' }[action];
      if (!required || !allowed.includes(required)) {
        return problem(response, 409, 'INVALID_STATE', String(correlationId));
      }
      const now = new Date().toISOString();
      if (action === 'suspend') {
        Object.assign(member, {
          status: 'SUSPENDED',
          suspendedAt: now,
          suspensionReason: body.reason ?? null,
        });
      } else if (action === 'reactivate') {
        Object.assign(member, { status: 'ACTIVE', suspendedAt: null, suspensionReason: null });
      } else {
        Object.assign(member, {
          status: 'REVOKED',
          revokedAt: now,
          revocationReason: body.reason ?? null,
        });
      }
    } else {
      return problem(response, 404, 'NOT_FOUND', String(correlationId));
    }
    member.version += 1;
    return sendMember(response, member);
  }
  if (url.pathname === '/api/v1/invitations/preview' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (body.token === INVITE_TOKEN_EXPIRED) {
      return problem(response, 410, 'INVITATION_EXPIRED', String(correlationId));
    }
    if (body.token !== INVITE_TOKEN) {
      return problem(response, 404, 'INVITATION_INVALID', String(correlationId));
    }
    return send(response, 200, {
      data: {
        tenant: { id: '0192a000-0000-7000-8000-00000000000b', name: 'Prefeitura B' },
        type: 'INTERNAL',
        jobTitle: 'Analista de compras',
        departments: [{ id: '0192a000-0000-7000-8000-0000000000d1', name: 'Gabinete' }],
        expiresAt: null,
        inviteExpiresAt: '2026-10-22T12:00:00.000Z',
      },
    });
  }
  if (url.pathname === '/api/v1/invitations/accept' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (body.token !== INVITE_TOKEN) {
      return problem(response, 404, 'INVITATION_INVALID', String(correlationId));
    }
    // O vínculo ativado é o de Ana na Prefeitura B (o BFF simulado o conhece para a troca).
    return send(response, 200, {
      data: {
        ...newInvitation('ana@exemplo.gov.br', { name: 'Ana Souza', type: 'INTERNAL' }),
        id: '0192a000-0000-7000-8000-0000000002a1',
        status: 'ACTIVE',
        tenant: { id: '0192a000-0000-7000-8000-00000000000b', name: 'Prefeitura B' },
      },
    });
  }
  if (url.pathname === '/api/v1/roles' && request.method === 'GET') {
    return send(response, 200, { data: roles.map(roleSummary) });
  }
  if (url.pathname === '/api/v1/roles' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const name = String(body.name ?? '').trim();
    if (roles.some((role) => role.name.toLowerCase() === name.toLowerCase())) {
      return problem(response, 409, 'ROLE_ALREADY_EXISTS', String(correlationId));
    }
    const created = newRole(name, body.description, []);
    roles.push(created);
    return send(
      response,
      201,
      { data: roleSummary(created) },
      {
        ETag: '"1"',
        Location: `/api/v1/roles/${created.id}`,
      },
    );
  }
  const roleRoute = /^\/api\/v1\/roles\/([0-9a-f-]{36})(\/[a-z]+)?$/.exec(url.pathname);
  const role = roleRoute ? roles.find((item) => item.id === roleRoute[1]) : undefined;
  if (roleRoute && !role) return problem(response, 404, 'ROLE_NOT_FOUND', String(correlationId));
  if (role && !roleRoute[2] && request.method === 'GET') {
    return send(response, 200, { data: role }, { ETag: `"${role.version}"` });
  }
  if (role && roleRoute[2] === '/duplicate' && request.method === 'POST') {
    let name = `${role.name} (cópia)`;
    for (let n = 2; roles.some((item) => item.name === name); n += 1) {
      name = `${role.name} (cópia ${n})`;
    }
    const copy = newRole(name, role.description, [...role.permissions]);
    roles.push(copy);
    return send(response, 201, { data: roleSummary(copy) }, { ETag: '"1"' });
  }
  if (role && String(request.headers['if-match'] ?? '') !== `"${role.version}"`) {
    return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
  }
  if (role && roleRoute[2] === '/permissions' && request.method === 'PUT') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const added = body.permissions.filter((code) => !role.permissions.includes(code));
    if (added.some((code) => !ANA_PERMISSIONS.includes(code))) {
      return problem(response, 403, 'PRIVILEGE_ESCALATION_FORBIDDEN', String(correlationId));
    }
    Object.assign(role, { permissions: body.permissions, version: role.version + 1 });
    return send(response, 200, { data: role }, { ETag: `"${role.version}"` });
  }
  if (role && !roleRoute[2] && request.method === 'PATCH') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const highRisk = role.permissions.some(
      (code) => catalog.find((item) => item.code === code)?.riskLevel === 'HIGH',
    );
    if (
      body.allowExternalAssignment === true &&
      !role.allowExternalAssignment &&
      highRisk &&
      !hasMfa(request.headers.authorization)
    ) {
      return problem(response, 403, 'MFA_REQUIRED', String(correlationId));
    }
    Object.assign(role, body, { version: role.version + 1 });
    return send(response, 200, { data: roleSummary(role) }, { ETag: `"${role.version}"` });
  }
  if (role && roleRoute[2] === '/deactivate' && request.method === 'POST') {
    if (role.isProtected)
      return problem(response, 409, 'LAST_ADMIN_REQUIRED', String(correlationId));
    Object.assign(role, { isActive: false, version: role.version + 1 });
    return send(response, 200, { data: roleSummary(role) }, { ETag: `"${role.version}"` });
  }
  if (url.pathname === '/api/v1/departments' && request.method === 'GET') {
    const tree = departmentTree(url.searchParams.get('organizationId') ?? '');
    return send(response, 200, {
      data: tree.map(departmentView),
      meta: { page: 1, pageSize: 100, totalItems: tree.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/departments' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const parent = body.parentId ? departments.find((unit) => unit.id === body.parentId) : null;
    if (body.parentId && !parent) {
      return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
    }
    const created = newDepartment(body.organizationId, parent, body);
    departments.push(created);
    return send(
      response,
      201,
      { data: departmentView(created) },
      { ETag: '"1"', Location: `/api/v1/departments/${created.id}` },
    );
  }
  const departmentRoute =
    /^\/api\/v1\/departments\/([0-9a-f-]{36})(\/(move|activate|deactivate))?$/.exec(url.pathname);
  if (departmentRoute) {
    const unit = departments.find((item) => item.id === departmentRoute[1]);
    if (!unit) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (request.method === 'GET') {
      return send(response, 200, { data: departmentView(unit) }, { ETag: `"${unit.version}"` });
    }
    if (String(request.headers['if-match'] ?? '') !== `"${unit.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const action = departmentRoute[3];
    if (request.method === 'DELETE') {
      if (unit.inUse || departments.some((item) => item.parentId === unit.id)) {
        return problem(response, 409, 'DEPARTMENT_HAS_REFERENCES', String(correlationId));
      }
      departments.splice(departments.indexOf(unit), 1);
      response.writeHead(204);
      return response.end();
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (action === 'move') {
      const target = body.parentId ? departments.find((item) => item.id === body.parentId) : null;
      if (target && target.path.startsWith(unit.path)) {
        return problem(response, 422, 'DEPARTMENT_CYCLE', String(correlationId));
      }
      const from = { path: unit.path, depth: unit.depth };
      const path = `${target?.path ?? '/'}${unit.id}/`;
      const depth = target ? target.depth + 1 : 0;
      for (const item of departments) {
        if (item !== unit && item.path.startsWith(from.path)) {
          item.path = `${path}${item.path.slice(from.path.length)}`;
          item.depth += depth - from.depth;
        }
      }
      Object.assign(unit, { parentId: target?.id ?? null, path, depth });
    } else if (action === 'activate' || action === 'deactivate') {
      unit.isActive = action === 'activate';
    } else if (request.method === 'PATCH') {
      Object.assign(unit, body);
    }
    unit.version += 1;
    return send(response, 200, { data: departmentView(unit) }, { ETag: `"${unit.version}"` });
  }
  const organizationRoute = /^\/api\/v1\/organizations\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (organizationRoute && request.method === 'GET') {
    const organization = organizations.find((item) => item.id === organizationRoute[1]);
    if (!organization) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    return send(response, 200, { data: organization }, { ETag: `"${organization.version}"` });
  }
  if (organizationRoute && request.method === 'PATCH') {
    const organization = organizations.find((item) => item.id === organizationRoute[1]);
    if (!organization) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${organization.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    const others = organizations.filter((item) => item !== organization && item.isActive);
    if (body.isActive === false && (organization.isPrimary || others.length === 0)) {
      return problem(response, 409, 'PRIMARY_ORGANIZATION_REQUIRED', String(correlationId));
    }
    Object.assign(organization, body, { version: organization.version + 1 });
    return send(response, 200, { data: organization }, { ETag: `"${organization.version}"` });
  }
  if (url.pathname === '/api/v1/templates' && request.method === 'GET') {
    const data = [...templates]
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .map(templateView);
    return send(response, 200, {
      data,
      meta: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/templates' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const lower = String(body.name ?? '')
      .trim()
      .toLowerCase();
    const taken = templates.some(
      (item) => item.documentTypeId === body.documentTypeId && item.name.toLowerCase() === lower,
    );
    if (taken) return problem(response, 409, 'TEMPLATE_NAME_TAKEN', String(correlationId));
    const now = new Date().toISOString();
    const template = {
      id: mockUuid(),
      name: String(body.name).trim(),
      description: body.description ?? null,
      documentTypeId: body.documentTypeId,
      isActive: true,
      isSystem: false,
      currentPublishedVersionId: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    templates.push(template);
    templateVersions.push({
      id: mockUuid(),
      templateId: template.id,
      versionNumber: 1,
      status: 'DRAFT',
      sections: [],
      fieldConfig: {},
      importMappings: null,
      layout: TEMPLATE_LAYOUT,
      changeNotes: null,
      importSources: null,
      publishedAt: null,
      retiredAt: null,
      contentHash: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    return send(
      response,
      201,
      { data: templateView(template) },
      { Location: `/api/v1/templates/${template.id}`, ETag: '"1"' },
    );
  }
  // US-108: publicar (TPL-10) e aposentar (TPL-11) com If-Match; nova versão (TPL-06) e histórico
  // (TPL-05); padrão do tipo (DTY-04). O conteúdo é conferido pela API real, não aqui.
  const lifecycleRoute = /^\/api\/v1\/template-versions\/([0-9a-f-]{36})\/(publish|retire)$/.exec(
    url.pathname,
  );
  if (lifecycleRoute && request.method === 'POST') {
    const version = templateVersions.find((item) => item.id === lifecycleRoute[1]);
    if (!version) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    const template = templates.find((item) => item.id === version.templateId);
    if (String(request.headers['if-match'] ?? '') !== `"${version.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const now = new Date().toISOString();
    if (lifecycleRoute[2] === 'publish') {
      if (version.status !== 'DRAFT') {
        return problem(response, 409, 'TEMPLATE_VERSION_NOT_DRAFT', String(correlationId));
      }
      Object.assign(version, {
        status: 'PUBLISHED',
        publishedAt: now,
        contentHash: randomUUID().replaceAll('-', '').repeat(2),
      });
      template.currentPublishedVersionId = version.id;
    } else {
      if (version.status !== 'PUBLISHED') {
        return problem(response, 409, 'INVALID_STATE', String(correlationId));
      }
      const others = templateVersions
        .filter((item) => item.templateId === template.id && item.status === 'PUBLISHED')
        .filter((item) => item.id !== version.id)
        .sort((a, b) => b.versionNumber - a.versionNumber);
      const isDefault = documentTypes.some(
        (type) => type.isActive && type.defaultTemplateId === template.id,
      );
      if (template.currentPublishedVersionId === version.id) {
        if (others.length === 0 && isDefault) {
          return problem(response, 409, 'TEMPLATE_IN_USE', String(correlationId));
        }
        template.currentPublishedVersionId = others[0]?.id ?? null;
      }
      Object.assign(version, { status: 'RETIRED', retiredAt: now });
    }
    Object.assign(version, { version: version.version + 1, updatedAt: now });
    return send(
      response,
      200,
      { data: templateVersionView(version) },
      { ETag: `"${version.version}"` },
    );
  }
  const versionsRoute = /^\/api\/v1\/templates\/([0-9a-f-]{36})\/versions$/.exec(url.pathname);
  if (versionsRoute) {
    const template = templates.find((item) => item.id === versionsRoute[1]);
    if (!template) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    const own = templateVersions
      .filter((item) => item.templateId === template.id)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    if (request.method === 'GET') {
      return send(response, 200, {
        data: own.map(versionHistoryItem),
        meta: { page: 1, pageSize: 100, totalItems: own.length, totalPages: 1 },
      });
    }
    if (request.method === 'POST') {
      const draft = own.find((item) => item.status === 'DRAFT');
      if (draft) return problem(response, 409, 'TEMPLATE_DRAFT_EXISTS', String(correlationId));
      const latest = own[0];
      const now = new Date().toISOString();
      const created = {
        ...structuredClone(latest),
        id: mockUuid(),
        versionNumber: latest.versionNumber + 1,
        status: 'DRAFT',
        changeNotes: null,
        publishedAt: null,
        retiredAt: null,
        contentHash: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      templateVersions.push(created);
      return send(
        response,
        201,
        { data: templateVersionView(created) },
        { Location: `/api/v1/template-versions/${created.id}`, ETag: '"1"' },
      );
    }
  }
  const defaultTemplateRoute =
    /^\/api\/v1\/document-types\/([0-9a-f-]{36})\/default-template$/.exec(url.pathname);
  if (defaultTemplateRoute && request.method === 'PUT') {
    const type = documentTypes.find((item) => item.id === defaultTemplateRoute[1]);
    if (!type) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${type.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    const template = templates.find((item) => item.id === body.templateId);
    if (!template) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (!template.currentPublishedVersionId) {
      return problem(response, 422, 'BUSINESS_RULE_VIOLATION', String(correlationId));
    }
    if (type.defaultTemplateId !== template.id) {
      Object.assign(type, { defaultTemplateId: template.id, version: type.version + 1 });
    }
    return send(response, 200, { data: documentTypeView(type) }, { ETag: `"${type.version}"` });
  }
  const templateVersionRoute = /^\/api\/v1\/template-versions\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (templateVersionRoute) {
    const version = templateVersions.find((item) => item.id === templateVersionRoute[1]);
    if (!version) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (request.method === 'GET') {
      return send(
        response,
        200,
        { data: templateVersionView(version) },
        { ETag: `"${version.version}"` },
      );
    }
    if (request.method === 'PATCH') {
      if (String(request.headers['if-match'] ?? '') !== `"${version.version}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      const body = JSON.parse((await readBody(request)) || '{}');
      const violations = (body.sections ?? []).flatMap((section) =>
        unknownVariables(section).map((name) => ({
          code: 'TEMPLATE_VARIABLE_UNKNOWN',
          severity: 'BLOCKING',
          message: `A variável {{${name}}} não é reconhecida.`,
          ruleId: null,
          sectionKey: section.key,
          field: 'defaultContent',
          itemId: null,
          params: { variable: name },
        })),
      );
      if (violations.length > 0) {
        return send(
          response,
          422,
          {
            type: 'https://docs.contrataflow.com.br/errors/template-invalid',
            title: 'Template inválido',
            status: 422,
            detail: violations[0].message,
            instance: url.pathname,
            code: 'TEMPLATE_INVALID',
            correlationId: String(correlationId),
            errors: [],
            violations,
          },
          { 'Content-Type': 'application/problem+json' },
        );
      }
      Object.assign(version, body, {
        version: version.version + 1,
        updatedAt: new Date().toISOString(),
      });
      return send(
        response,
        200,
        { data: templateVersionView(version) },
        { ETag: `"${version.version}"` },
      );
    }
  }
  if (url.pathname === '/api/v1/workflows' && request.method === 'GET') {
    return send(response, 200, {
      data: workflows,
      meta: { page: 1, pageSize: 100, totalItems: workflows.length, totalPages: 1 },
    });
  }
  const setDefaultRoute = /^\/api\/v1\/workflows\/([0-9a-f-]{36})\/set-default$/.exec(url.pathname);
  if (setDefaultRoute && request.method === 'POST') {
    const workflow = workflows.find((item) => item.id === setDefaultRoute[1]);
    if (!workflow) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${workflow.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    if (!workflow.isActive || workflow.currentPublishedVersion === null) {
      return problem(response, 422, 'BUSINESS_RULE_VIOLATION', String(correlationId));
    }
    for (const item of workflows) {
      Object.assign(item, { isDefault: item.id === workflow.id, version: item.version + 1 });
    }
    return send(response, 200, { data: workflow }, { ETag: `"${workflow.version}"` });
  }
  const templateRoute = /^\/api\/v1\/templates\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (templateRoute) {
    const template = templates.find((item) => item.id === templateRoute[1]);
    if (!template) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (request.method === 'GET') return send(response, 200, { data: templateView(template) });
    if (request.method === 'PATCH') {
      if (String(request.headers['if-match'] ?? '') !== `"${template.version}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      const body = JSON.parse((await readBody(request)) || '{}');
      Object.assign(template, body, { version: template.version + 1 });
      return send(
        response,
        200,
        { data: templateView(template) },
        { ETag: `"${template.version}"` },
      );
    }
  }
  const documentTypeRoute = /^\/api\/v1\/document-types\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (documentTypeRoute && request.method === 'PATCH') {
    const type = documentTypes.find((item) => item.id === documentTypeRoute[1]);
    if (!type) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${type.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    Object.assign(type, body, { version: type.version + 1 });
    return send(response, 200, { data: documentTypeView(type) }, { ETag: `"${type.version}"` });
  }
  return problem(response, 404, 'NOT_FOUND', String(correlationId));
}).listen(PORT, () => {
  process.stdout.write(`mock-api pronto na porta ${PORT}\n`);
});
