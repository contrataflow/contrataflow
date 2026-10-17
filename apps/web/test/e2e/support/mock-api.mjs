// API simulada do E2E do shell (US-086): responde às rotas internas da US-080 (`/_internal/*`) e
// a ME-03, exige o Bearer emitido pelo BFF e permite injetar falhas por `POST /__mock/fail`.
// Sem dependências: `node test/e2e/support/mock-api.mjs <porta>`.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 4010);
// Preferências de notificação (US-113 · ME-05/ME-06): registro NotificationType reduzido a
// [tipo, e-mail padrão, in-app obrigatório]; o estado salvo é por usuário.
const NOTIFICATION_TYPE_DEFAULTS = [
  ['PROCESS_RECEIVED', true, false],
  ['PROCESS_RETURNED', true, false],
  ['PROCESS_ASSIGNED', true, false],
  ['PROCESS_STATUS_CHANGED', false, false],
  ['APPROVAL_REQUESTED', true, true],
  ['APPROVAL_DECIDED', true, false],
  ['APPROVAL_REASSIGNED', true, false],
  ['MENTIONED', true, false],
  ['COMMENT_REPLY', false, false],
  ['STAGE_DUE_SOON', false, false],
  ['STAGE_OVERDUE', true, false],
  ['PARTICIPANT_ADDED', true, false],
  ['ATTACHMENT_REJECTED', false, true],
  ['DOCUMENT_RENDER_FAILED', false, false],
  ['ROLE_CHANGED', true, true],
];
const notificationPreferences = new Map();

function notificationPreferencesView(user) {
  const saved = notificationPreferences.get(user) ?? new Map();
  return NOTIFICATION_TYPE_DEFAULTS.flatMap(([notificationType, emailDefault, mandatory]) => [
    { notificationType, channel: 'IN_APP', enabled: true, editable: !mandatory },
    {
      notificationType,
      channel: 'EMAIL',
      enabled: saved.get(`${notificationType}:EMAIL`) ?? emailDefault,
      editable: true,
    },
  ]);
}

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
  // US-116: IA opt-in (desligada, sem termos aceitos) e limites padrão.
  ['ai.enabled', { value: false, version: 1 }],
  ['ai.termsAcceptedVersion', { value: null, version: 1 }],
  ['ai.monthlyTokenLimit', { value: 2000000, version: 1 }],
  ['ai.userDailyRequestLimit', { value: 40, version: 1 }],
]);
const AI_TERMS = { currentVersion: '2026-10', provider: 'fake', maxMonthlyTokens: 20000000 };
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

// Fornecedores (US-025 · SUP-01..06): CPF sempre mascarado; o cadastro é global (como o das demais
// telas simuladas) — por isso o e2e dos fornecedores roda em série.
const suppliers = [
  ['CNPJ', '11222333000181', 'Construtora ABC Ltda', 'ABC Obras', 'contato@abc.com.br'],
  ['CPF', '***.444.777-**', 'João da Silva', null, null],
  ['FOREIGN', 'DE-123456789', 'Acme GmbH', null, null],
].map(([documentType, documentNumber, legalName, tradeName, email], index) => ({
  id: `0192a000-0000-7000-8000-00000000f2${String(index).padStart(2, '0')}`,
  documentType,
  documentNumber,
  legalName,
  tradeName,
  email,
  phone: null,
  website: null,
  contactName: null,
  addressStreet: null,
  addressNumber: null,
  addressComplement: null,
  addressDistrict: null,
  addressCity: null,
  addressState: null,
  addressZipCode: null,
  isActive: index !== 2,
  notes: null,
  createdAt: '2026-10-16T12:00:00.000Z',
  updatedAt: '2026-10-16T12:00:00.000Z',
  version: 1,
}));

/** Documento sem máscara, para comparar o número digitado com o cadastrado. */
const plainDocument = (value) =>
  String(value ?? '')
    .replace(/[.\-/\s]/g, '')
    .toUpperCase();

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

// Catálogos do wizard "Novo processo" (US-001 · CAT-01): tipos de contratação e origens ativos. O
// tipo "Serviços comuns" não tem workflow aplicável (WF-06 → NO_APPLICABLE_WORKFLOW — FA-06).
for (const [type, code, label] of [
  ['CONTRACTING_TYPE', 'AQUISICAO_BENS', 'Aquisição de bens'],
  ['CONTRACTING_TYPE', 'SERVICOS', 'Serviços comuns'],
  ['PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA', 'Demanda não prevista'],
  ['PROCESS_ORIGIN', 'PLANO_ANUAL', 'Plano anual'],
]) {
  catalogItems.push({
    id: `0192a000-0000-7000-8000-00000000c5${String(catalogItems.length).padStart(2, '0')}`,
    catalogType: type,
    code,
    label,
    description: null,
    isSystem: true,
    isActive: true,
    sortOrder: catalogItems.filter((item) => item.catalogType === type).length + 1,
    parentId: null,
    metadata: {},
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
  });
}

// Timeline do processo (US-060 · PRC-12): a abertura pelo criador mais 59 eventos fixos a cada
// 2 h para trás (cruza "Hoje", "Ontem" e dias anteriores), filtros por grupo/autor/período e
// cursor opaco por posição — o suficiente para a aba "Timeline" (filtros e scroll infinito).
const TIMELINE_GROUPS = {
  PROCESS_CREATED: 'PROCESSO',
  PROCESS_FORWARDED: 'TRAMITACAO',
  APPROVAL_DECIDED: 'APROVACOES',
  COMMENT_ADDED: 'COMENTARIOS',
};
const TIMELINE_ACTORS = [
  { id: '0192e060-0000-7000-8000-00000000c001', name: 'Carlos Lima' },
  { id: '0192e060-0000-7000-8000-00000000c002', name: 'Paula Reis' },
];
const timelines = new Map();
function timelineOf(found) {
  const cached = timelines.get(found.view.id);
  if (cached) return cached;
  const base = found.createdAtMs;
  const entries = [
    {
      id: randomUUID(),
      occurredAt: new Date(base).toISOString(),
      type: 'PROCESS_CREATED',
      actorType: 'USER',
      actorId: found.view.createdBy.id,
      actorName: found.view.createdBy.name,
      actorDepartmentName: found.view.requestingDepartment?.name ?? null,
      entityType: 'Process',
      entityId: found.view.id,
      movementId: null,
      params: { code: found.view.code, title: found.view.title },
      visibility: 'STANDARD',
    },
  ];
  const kinds = [
    ['APPROVAL_DECIDED', (n) => ({ decision: 'APPROVED', title: `Aprovação ${n}` })],
    [
      'PROCESS_FORWARDED',
      () => ({ toStageName: 'Pesquisa de preços', toDepartmentName: 'Setor de Cotações' }),
    ],
    ['COMMENT_ADDED', (n) => ({ excerpt: `Comentário ${n}` })],
  ];
  for (let index = 1; index < 60; index += 1) {
    const [type, params] = kinds[index % kinds.length];
    const actor = TIMELINE_ACTORS[index % TIMELINE_ACTORS.length];
    entries.push({
      id: randomUUID(),
      occurredAt: new Date(base - index * 2 * 3_600_000).toISOString(),
      type,
      actorType: 'USER',
      actorId: actor.id,
      actorName: actor.name,
      actorDepartmentName: 'Setor de Cotações',
      entityType: 'Process',
      entityId: found.view.id,
      movementId: null,
      params: params(index),
      visibility: 'STANDARD',
    });
  }
  timelines.set(found.view.id, entries);
  return entries;
}
function listTimeline(found, query) {
  const split = (name) => (query.get(name) ?? '').split(',').filter(Boolean);
  const groups = split('group');
  const actors = split('actorId');
  const from = query.get('occurredFrom');
  const to = query.get('occurredTo');
  const limit = Math.min(Number(query.get('limit') ?? 50), 100);
  const offset = query.get('cursor') ? Number(query.get('cursor').slice(1)) : 0;
  const matching = timelineOf(found).filter(
    (entry) =>
      (groups.length === 0 || groups.includes(TIMELINE_GROUPS[entry.type])) &&
      (actors.length === 0 || actors.includes(entry.actorId)) &&
      (!from || entry.occurredAt >= new Date(from).toISOString()) &&
      (!to || entry.occurredAt <= new Date(to).toISOString()),
  );
  const data = matching.slice(offset, offset + limit);
  const hasMore = offset + limit < matching.length;
  return { data, meta: { nextCursor: hasMore ? `p${offset + limit}` : null, hasMore } };
}

// Processos (US-001 · PRC-02/03/04 e WF-06): criação numerada em sequência, aviso de duplicidade
// por título parecido (mesmo usuário, últimos 10 min) e idempotência por `Idempotency-Key`.
// US-071: comentários por processo (CMT-01..04). Cada processo nasce com um comentário da
// Cláudia (para responder e moderar); a Ana é a autora dos novos — edição até 15 min.
const comments = new Map();
const COMMENT_EDIT_MS = 15 * 60_000;
function commentsOf(processId) {
  if (!comments.has(processId)) {
    const createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
    comments.set(processId, [
      {
        id: randomUUID(),
        processId,
        targetType: 'PROCESS',
        documentId: null,
        sectionKey: null,
        parentId: null,
        authorId: 'sub-claudia',
        authorName: 'Cláudia Ramos',
        body: plainDocument('Favor anexar a planilha de quantitativos do item 2.'),
        createdAt,
        editedAt: null,
        deletedAt: null,
        deletionReason: null,
        version: 1,
      },
    ]);
  }
  return comments.get(processId);
}
function commentAllowed(node, depth = 0) {
  const nodes = ['doc', 'paragraph', 'text', 'bulletList', 'orderedList', 'listItem', 'hardBreak'];
  if (depth > 12 || typeof node !== 'object' || node === null || !nodes.includes(node.type)) {
    return false;
  }
  for (const mark of node.marks ?? []) {
    if (!['bold', 'italic', 'link'].includes(mark.type)) return false;
    if (mark.type === 'link' && !/^(https?:|mailto:)/i.test(String(mark.attrs?.href ?? ''))) {
      return false;
    }
  }
  return (node.content ?? []).every((child) => commentAllowed(child, depth + 1));
}
function commentText(node) {
  if (node?.type === 'text') return node.text ?? '';
  return (node?.content ?? []).map(commentText).join(' ');
}
function commentView(comment, sub) {
  const mine = comment.authorId === sub;
  const deleted = comment.deletedAt !== null;
  const editableUntil = new Date(Date.parse(comment.createdAt) + COMMENT_EDIT_MS);
  const canEdit = mine && !deleted && Date.now() <= editableUntil.getTime();
  return {
    id: comment.id,
    processId: comment.processId,
    targetType: comment.targetType,
    document: null,
    sectionKey: comment.sectionKey,
    parentId: comment.parentId,
    author: {
      id: comment.authorId,
      name: comment.authorName,
      departmentName: 'Setor de Manutenção',
    },
    body: deleted ? null : comment.body,
    bodyMasked: false,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    isDeleted: deleted,
    deletedByModerator: deleted && comment.deletionReason !== null,
    deletionReason: comment.deletionReason,
    canEdit,
    editableUntil: canEdit ? editableUntil.toISOString() : null,
    canDelete: mine && !deleted,
    // No mock, a Ana modera comentários de terceiros (a API real confere COMMENT_MODERATE).
    canModerate: !mine && !deleted,
    version: comment.version,
  };
}
function findComment(id) {
  for (const list of comments.values()) {
    const found = list.find((item) => item.id === id);
    if (found) return found;
  }
  return null;
}

const processes = [];
const processReplays = new Map();
let processSequence = 10;
const WORKFLOW_RESOLUTION = {
  workflowId: randomUUID(),
  workflowVersionId: randomUUID(),
  name: 'Fase preparatória — Lei 14.133/2021',
  versionNumber: 1,
  initialStage: { id: randomUUID(), key: 'ABERTURA', name: 'Formalização da demanda' },
};
const DUPLICATE_WINDOW_MS = 10 * 60_000;
function titleTokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}
/** Semelhança por palavras (Jaccard ≥ 0,6), no lugar do trigram do PostgreSQL. */
function similarTitles(a, b) {
  const x = titleTokens(a);
  const y = titleTokens(b);
  const shared = [...x].filter((token) => y.has(token)).length;
  const total = new Set([...x, ...y]).size;
  return total > 0 && shared / total >= 0.6;
}
function duplicateCandidates(subjectId, title) {
  return processes
    .filter(
      (item) =>
        item.subject === subjectId &&
        Date.now() - item.createdAtMs < DUPLICATE_WINDOW_MS &&
        similarTitles(item.view.title, title),
    )
    .map(({ view }) => ({
      id: view.id,
      code: view.code,
      title: view.title,
      status: view.status,
      createdAt: view.createdAt,
      createdBy: view.createdBy,
    }));
}
function catalogRef(id) {
  const item = catalogItems.find((entry) => entry.id === id);
  return item ? { id: item.id, code: item.code, label: item.label } : null;
}
function departmentRef(id) {
  const unit = departments.find((entry) => entry.id === id);
  return unit ? { id: unit.id, name: unit.name } : null;
}
function processBodyErrors(body) {
  const errors = [];
  const required = (field, message) => {
    if (!body[field]) errors.push({ field, code: 'REQUIRED', message });
  };
  if (String(body.title ?? '').trim().length < 5) {
    errors.push({
      field: 'title',
      code: body.title ? 'TOO_SHORT' : 'REQUIRED',
      message: 'Informe o título.',
    });
  }
  required('object', 'Informe o objeto.');
  required('contractingTypeId', 'Informe o tipo de contratação.');
  required('requestingSecretariatId', 'Informe a secretaria solicitante.');
  required('requestingDepartmentId', 'Informe o setor solicitante.');
  required('originId', 'Informe a origem.');
  required('pcaStatus', 'Informe a situação no PCA.');
  return errors;
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

// Editor de workflow (US-043 · WF-02/03/08/09/10..15): versões em memória (a publicada é só
// leitura); cada etapa/transição tem a sua `version` (If-Match) e a etapa referenciada por transição
// não é excluída (RN-WF-50). As regras de grafo e os condicionais são da API.
// SCR-035 (US-044): campos do RuleContext (WF-19) e um processo de referência para o teste.
const RULE_CONTEXT_SCHEMA = {
  version: 1,
  fields: [
    { path: 'process.estimatedValue', label: 'Processo — valor estimado', type: 'number' },
    { path: 'process.modalityCode', label: 'Processo — modalidade', type: 'string' },
    { path: 'documents.ETP.isComplete', label: 'Documento ETP — completo', type: 'boolean' },
  ],
};
const RULE_TEST_PROCESSES = [
  {
    id: '0192a000-0000-7000-8000-0000000044f1',
    code: '0012/2026',
    internalCode: null,
    title: 'Aquisição de notebooks',
  },
];
const workflowVersions = new Map();
function emptyWorkflowVersion(id, workflowId, versionNumber, status) {
  return {
    id,
    workflowId,
    versionNumber,
    status,
    changeNotes: null,
    publishedAt: null,
    publishedById: null,
    retiredAt: null,
    retiredById: null,
    definitionHash: null,
    createdAt: '2026-10-15T12:00:00.000Z',
    createdById: null,
    version: 1,
    initialStageId: null,
    stages: [],
    transitions: [],
    rules: [],
  };
}
for (const workflow of workflows) {
  if (workflow.currentPublishedVersion) {
    workflowVersions.set(
      workflow.currentPublishedVersion.id,
      emptyWorkflowVersion(workflow.currentPublishedVersion.id, workflow.id, 1, 'PUBLISHED'),
    );
  }
  if (workflow.draftVersion) {
    workflowVersions.set(
      workflow.draftVersion.id,
      emptyWorkflowVersion(workflow.draftVersion.id, workflow.id, 1, 'DRAFT'),
    );
  }
}
const STAGE_DEFAULTS = {
  instructions: null,
  groupLabel: null,
  departmentResolution: 'REQUESTING_DEPARTMENT',
  fixedDepartmentId: null,
  assignmentPolicy: 'UNASSIGNED',
  approverType: null,
  approverUserId: null,
  approverRoleId: null,
  approverDepartmentResolution: null,
  approverFixedDepartmentId: null,
  allowDeputy: true,
  approvalDocumentTypeCodes: [],
  documentTypeCodes: [],
  slaDays: null,
  slaType: 'BUSINESS',
  color: null,
};
function workflowItemOwner(kind, id) {
  for (const version of workflowVersions.values()) {
    const item = version[kind].find((entry) => entry.id === id);
    if (item) return { version, item };
  }
  return null;
}

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
// US-110: biblioteca padrão semeada no provisionamento (`POST /__mock/template-library`) — um
// template `isSystem` com a v1 publicada por tipo com template; o padrão do tipo só é definido se
// ainda não houver um. Idempotente. O conteúdo completo e as regras ficam nos testes da API.
const TEMPLATE_LIBRARY = {
  DFD: [
    'DFD — Modelo padrão',
    [
      ['JUSTIFICATION', 'Justificativa da necessidade'],
      ['EXPECTED_RESULTS', 'Resultados pretendidos'],
      ['NOTES', 'Observações'],
    ],
  ],
  ETP: [
    'ETP — Modelo padrão',
    [
      ['NEED_DESCRIPTION', 'Descrição da necessidade'],
      ['REQUIREMENTS', 'Requisitos da contratação'],
      ['CONCLUSION', 'Posicionamento conclusivo'],
    ],
  ],
  OFICIO: ['Ofício — Modelo padrão', [['CONTENT', 'Conteúdo do ofício']]],
};
function seedTemplateLibrary() {
  const now = '2026-10-17T12:00:00.000Z';
  for (const type of documentTypes) {
    const entry = TEMPLATE_LIBRARY[type.code];
    if (!entry || templates.some((item) => item.isSystem && item.documentTypeId === type.id)) {
      continue;
    }
    const [name, sections] = entry;
    const template = {
      id: mockUuid(),
      name,
      description: 'Texto-base para revisão pela Procuradoria do órgão.',
      documentTypeId: type.id,
      isActive: true,
      isSystem: true,
      currentPublishedVersionId: null,
      createdAt: now,
      updatedAt: now,
      version: 2,
    };
    const version = {
      id: mockUuid(),
      templateId: template.id,
      versionNumber: 1,
      status: 'PUBLISHED',
      sections: sections.map(([key, title], index) => ({
        key,
        title,
        order: index + 1,
        requirement: 'REQUIRED',
        helpText: `Orientação ao redator: ${title.toLowerCase()}.`,
        maxChars: 50_000,
        render: 'TEXT',
        allowNarrative: true,
      })),
      fieldConfig: {},
      importMappings: null,
      layout: TEMPLATE_LAYOUT,
      changeNotes: null,
      importSources: null,
      publishedAt: now,
      retiredAt: null,
      contentHash: 'b0'.repeat(32),
      createdAt: now,
      updatedAt: now,
      version: 2,
    };
    template.currentPublishedVersionId = version.id;
    templates.push(template);
    templateVersions.push(version);
    if (!type.defaultTemplateId) {
      Object.assign(type, { defaultTemplateId: template.id, version: type.version + 1 });
    }
  }
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
// Perfis e acessos (US-096 · ROL-10..12): Diego é o único com o ADMIN_ORGAO no tenant — revogá-lo
// responde 409 LAST_ADMIN_REQUIRED (POL-12); os demais perfis entram e saem livremente.
const roleAssignments = [
  {
    id: '0192a000-0000-7000-8000-0000000096a1',
    userId: members[0].userId,
    roleId: roles[0].id,
    scopeType: 'TENANT',
    scopeOrganizationId: null,
    scopeDepartmentId: null,
    includeSubtree: true,
    validFrom: '2026-10-02T12:00:00.000Z',
    validUntil: null,
    status: 'ACTIVE',
    grantedAt: '2026-10-02T12:00:00.000Z',
    revokedAt: null,
    version: 1,
  },
];
function assignmentDto(assignment) {
  const member = members.find((item) => item.userId === assignment.userId);
  const role = roles.find((item) => item.id === assignment.roleId);
  const { userId, ...rest } = assignment;
  return {
    ...rest,
    membershipId: member?.id ?? userId,
    userId,
    userName: member?.name ?? '',
    roleKey: role?.key ?? '',
    roleName: role?.name ?? '',
    isAdministrative: (role?.permissions ?? []).some((code) =>
      ['ROLE_ASSIGN', 'ROLE_MANAGE', 'USER_MANAGE'].includes(code),
    ),
    scopeName: null,
    grantedBy: { id: '0192a000-0000-7000-8000-0000000000a1', name: 'Ana Souza' },
  };
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
/** PATCH do `layout` (US-109): só as partes enviadas; `null` remove cabeçalho/rodapé/logo. */
function mergeLayout(current, patch) {
  const next = {
    ...current,
    ...patch,
    marginsMm: { ...current.marginsMm, ...(patch.marginsMm ?? {}) },
  };
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null));
}

const templatePreviews = new Map();

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

// Selos de integridade da auditoria (US-074 · AUD-04/AUD-05): três horas seladas (08h às 11h em São
// Paulo). Com `auditTampered`, a verificação acusa o 2º selo (digest) e o 3º (cadeia).
const AUDIT_SEAL_HOURS = [11, 12, 13];
const AUDIT_SEAL_MAX_PERIODS = 720;
const HOUR_MS = 3_600_000;
const auditSeals = AUDIT_SEAL_HOURS.map((hour, index) => {
  const start = Date.UTC(2026, 9, 15, hour);
  return {
    id: `0192a000-0000-7000-8000-00000000740${index}`,
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(start + HOUR_MS).toISOString(),
    recordCount: 12 - index * 4,
    digest: 'a'.repeat(64),
    chainHash: 'b'.repeat(64),
    sealedAt: new Date(start + HOUR_MS + 5 * 60_000).toISOString(),
  };
});
let auditTampered = false;

function verifyAuditSeals(body) {
  const start = Date.parse(body.periodStart);
  const end = Date.parse(body.periodEnd);
  const periods = Math.floor(end / HOUR_MS) - Math.floor(start / HOUR_MS) + 1;
  if (periods > AUDIT_SEAL_MAX_PERIODS) {
    return {
      status: 422,
      errors: [
        {
          field: 'periodEnd',
          code: 'OUT_OF_RANGE',
          message: `Reduza o intervalo para verificar a integridade (máximo de ${AUDIT_SEAL_MAX_PERIODS} selos).`,
        },
      ],
    };
  }
  const covered = auditSeals.filter(
    (seal) => Date.parse(seal.periodStart) <= end && Date.parse(seal.periodEnd) > start,
  );
  if (covered.length === 0) return { status: 404 };
  const results = covered.map((seal, index) => ({
    periodStart: seal.periodStart,
    periodEnd: seal.periodEnd,
    recordCount: seal.recordCount,
    status: auditTampered && index > 0 ? 'INVALID' : 'VALID',
    ...(auditTampered && index === 1 ? { brokenAt: 'digest' } : {}),
    ...(auditTampered && index > 1 ? { brokenAt: 'chain' } : {}),
  }));
  const broken = results.find((result) => result.status === 'INVALID');
  return { status: 200, data: { brokenAtPeriodStart: broken?.periodStart ?? null, results } };
}

// Trilha de auditoria (US-075 · AUD-01/02/03): três registros nas últimas horas (dentro do período
// padrão de 7 dias), um com nome que seria fórmula numa planilha. A exportação aplica os mesmos
// filtros e o escape de RN-AUD-20 (a API real o faz em `audit-export-writer.ts`).
const AUDIT_PROCESS_ID = '0192a000-0000-7000-8000-0000000075f1';
const auditLogs = [
  ['process.create', 'DATA_CHANGE', 'SUCCESS', 'Ana Souza', null],
  ['access.denied', 'ACCESS', 'DENIED', 'Ana Souza', 'PROCESS_CREATE'],
  ['supplier.update', 'DATA_CHANGE', 'SUCCESS', '=SOMA(1;2)', null],
].map(([action, category, result, actorName, reasonCode], index) => ({
  id: `0192a000-0000-7000-8000-00000000750${index}`,
  occurredAt: new Date(Date.now() - (index + 1) * HOUR_MS).toISOString(),
  actorType: 'USER',
  actorUserId: '0192a000-0000-7000-8000-0000000000a1',
  actorName,
  actorMembershipId: null,
  onBehalfOfUserId: null,
  action,
  category,
  result,
  entityType: 'Process',
  entityId: AUDIT_PROCESS_ID,
  processId: AUDIT_PROCESS_ID,
  changes:
    action === 'process.create'
      ? [
          { path: 'contactCpf', old: '***.456.789-**', new: '***.654.321-**' },
          { path: 'notes', old: null, new: { hash: 'ab12cd34ef56ab12', length: 800 } },
        ]
      : null,
  metadata: { processCode: '0075/2026' },
  reasonCode,
  ip: '10.0.0.1',
  userAgent: 'Playwright',
  correlationId: `corr-75${index}`,
  requestId: null,
  sessionIdHash: null,
  rowHash: 'f'.repeat(64),
}));

function filterAuditLogs(params) {
  const from = Date.parse(params.get('occurredFrom') ?? '');
  const to = Date.parse(params.get('occurredTo') ?? '');
  const actions = params.get('action')?.split(',') ?? null;
  return auditLogs.filter(
    (item) =>
      Date.parse(item.occurredAt) >= from &&
      Date.parse(item.occurredAt) <= to &&
      (actions === null || actions.includes(item.action)),
  );
}

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function auditCsv(items) {
  const columns = ['id', 'occurredAt', 'actorName', 'action', 'category', 'result'];
  const lines = items.map((item) => columns.map((column) => csvCell(item[column])).join(','));
  return `${String.fromCharCode(0xfeff)}${[columns.join(','), ...lines].join('\r\n')}\r\n`;
}

// Versões do documento (US-066 · DOC-03/15/16/18): um ETP em rascunho com a versão 1 já gravada;
// "Salvar versão" grava a próxima com o texto atual do OBJETO, e a comparação diferencia essa seção.
const VERSIONED_PROCESS_ID = '0192a000-0000-7000-8000-0000000d0c00';
const VERSIONED_DOCUMENT_ID = '0192a000-0000-7000-8000-0000000d0c01';
const VERSION_AUTHOR_ID = '0192a000-0000-7000-8000-0000000d0caa';
const versionedDocument = {
  id: VERSIONED_DOCUMENT_ID,
  processId: VERSIONED_PROCESS_ID,
  documentType: {
    id: '0192a000-0000-7000-8000-0000000d0c02',
    code: 'ETP',
    name: 'Estudo Técnico Preliminar',
    kind: 'FREE_TEXT',
    systemModule: null,
    requiresApproval: true,
  },
  templateVersionId: null,
  number: 3,
  year: 2026,
  code: 'ETP 0003/2026',
  title: 'Estudo técnico da aquisição de papel',
  status: 'DRAFT',
  confidentiality: 'PUBLIC',
  draftContent: { sections: {}, collections: {}, headerFields: {} },
  draftRevision: 2,
  currentVersionId: null,
  currentVersionNumber: null,
  approvedVersionId: null,
  pendingApprovalId: null,
  responsibleId: null,
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
  createdAt: '2026-03-02T12:00:00.000Z',
  updatedAt: '2026-03-02T12:00:00.000Z',
  createdById: VERSION_AUTHOR_ID,
  version: 2,
};
/** Texto do OBJETO no rascunho atual (o que a próxima versão retrata). */
const DRAFT_OBJECT_TEXT = 'Aquisição de papel A4 reciclado para as secretarias.';
const documentVersions = [];
const versionReplays = new Map();

function recordDocumentVersion({ reason, changeSummary, objectText, createdAt }) {
  const versionNumber = documentVersions.length + 1;
  const version = {
    id: randomUUID(),
    documentId: VERSIONED_DOCUMENT_ID,
    processId: VERSIONED_PROCESS_ID,
    versionNumber,
    reason,
    statusAtCreation: 'DRAFT',
    contentHash: `${String(versionNumber).repeat(8)}${'a'.repeat(56)}`.slice(0, 64),
    attachmentId: null,
    templateVersionId: null,
    changeSummary,
    createdById: VERSION_AUTHOR_ID,
    createdByName: 'Ana Souza',
    createdAt,
  };
  documentVersions.push({ summary: version, objectText });
  versionedDocument.currentVersionId = version.id;
  versionedDocument.currentVersionNumber = versionNumber;
  versionedDocument.version += 1;
  return version;
}

recordDocumentVersion({
  reason: 'MANUAL',
  changeSummary: 'Primeira redação do objeto',
  objectText: 'Aquisição de papel para as secretarias.',
  createdAt: '2026-03-02T12:30:00.000Z',
});

function sectionSide(text) {
  return { state: 'FILLED', text, justification: null };
}

/** DOC-18 reduzido: o título não muda; o OBJETO muda quando o texto difere. */
function compareDocumentVersions(from, to) {
  const changed = from.objectText !== to.objectText;
  return {
    documentId: VERSIONED_DOCUMENT_ID,
    kind: 'FREE_TEXT',
    from: from.summary,
    to: to.summary,
    header: [
      {
        field: 'document.title',
        changeType: 'UNCHANGED',
        from: versionedDocument.title,
        to: versionedDocument.title,
      },
    ],
    sections: [
      {
        sectionKey: 'OBJETO',
        changeType: changed ? 'CHANGED' : 'UNCHANGED',
        from: sectionSide(from.objectText),
        to: sectionSide(to.objectText),
      },
    ],
    collections: [],
  };
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

/** problem+json com `errors[]` e/ou membros de extensão (ex.: `candidates` do 409 de duplicidade). */
function problemWith(response, status, code, correlationId, extra = {}) {
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
      errors: extra.errors ?? [],
      violations: [],
      ...extra.members,
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
  if (url.pathname === '/__mock/template-library') {
    seedTemplateLibrary();
    return send(response, 204);
  }
  if (url.pathname === '/__mock/audit-tamper') {
    // US-074: simula dado alterado no banco — a verificação passa a devolver selos INVALID.
    const body = JSON.parse((await readBody(request)) || '{}');
    auditTampered = body.tampered === true;
    return send(response, 204);
  }
  const forced = failures.get(url.pathname);
  if (forced) return problem(response, forced.status, forced.code, String(correlationId));

  const sub = subject(request.headers.authorization);
  if (!sub) return problem(response, 401, 'UNAUTHENTICATED', String(correlationId));
  const tenantId = request.headers['x-tenant-id'] ?? null;

  if (url.pathname === '/api/v1/me/permissions') {
    // ME-03 (US-097): escopos como objetos; na Prefeitura B a Ana não tem perfil administrativo
    // (o menu muda ao trocar de instituição — e2e permissions.spec.ts).
    const TENANT_WIDE = [{ type: 'TENANT', includeSubtree: false }];
    const permissions =
      sub === 'sub-ana' && tenantId !== '0192a000-0000-7000-8000-00000000000b'
        ? [
            { code: 'PROCESS_CREATE', scopes: TENANT_WIDE },
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
            { code: 'WORKFLOW_MANAGE', scopes: [] },
            { code: 'WORKFLOW_PUBLISH', scopes: [] },
            { code: 'AUDIT_VIEW', scopes: [] },
            { code: 'AUDIT_EXPORT', scopes: [] },
            { code: 'SUPPLIER_VIEW', scopes: [] },
            { code: 'SUPPLIER_MANAGE', scopes: [] },
          ]
        : [];
    return send(response, 200, {
      data: {
        permissions: permissions.map((permission) => ({ ...permission, scopes: TENANT_WIDE })),
        // US-001: lotações do vínculo (a Ana é lotada no Gabinete) — pré-preenchimento do wizard.
        implicit: {
          headOfDepartmentIds: [],
          ownDepartmentIds: sub === 'sub-ana' ? [departments[0].id] : [],
        },
      },
    });
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
    return send(response, 200, { data: Object.fromEntries(settings), meta: { aiTerms: AI_TERMS } });
  }
  if (url.pathname === '/api/v1/ai/usage' && request.method === 'GET') {
    // AI-06 (US-116): consumo do mês com uma geração de DFD.
    return send(response, 200, {
      data: {
        month: url.searchParams.get('month') ?? '2026-10',
        limitTokens: settings.get('ai.monthlyTokenLimit')?.value ?? 2000000,
        usedTokens: 12400,
        reservedTokens: 0,
        costUsd: '0.050000',
        generations: {
          total: 1,
          byStatus: {
            QUEUED: 0,
            RUNNING: 0,
            SUCCEEDED: 1,
            FAILED: 0,
            CANCELED: 0,
            APPLIED: 0,
            DISCARDED: 0,
            EXPIRED: 0,
          },
        },
        byDocumentType: [
          { targetModule: 'DFD', generations: 1, totalTokens: 12400, costUsd: '0.050000' },
        ],
        byKind: [{ kind: 'DRAFT', action: null, generations: 1, totalTokens: 12400 }],
        byUser: [
          {
            userId: '0192a000-0000-7000-8000-0000000000a1',
            name: 'Ana Souza',
            generations: 1,
            totalTokens: 12400,
          },
        ],
      },
    });
  }
  if (url.pathname === '/api/v1/ai/availability' && request.method === 'GET') {
    // AI-05 (US-116): disponibilidade conforme a IA do órgão.
    const enabled = settings.get('ai.enabled')?.value === true;
    return send(response, 200, {
      data: {
        enabled,
        providerAvailable: true,
        canGenerate: enabled,
        reasons: enabled ? [] : ['AI_DISABLED'],
        monthly: { percentUsed: 0.6 },
        userDaily: { used: 0, limit: settings.get('ai.userDailyRequestLimit')?.value ?? 40 },
      },
    });
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
    // US-116 (RN-AI-16): ligar exige o aceite da versão vigente dos termos.
    const terms =
      body.values['ai.termsAcceptedVersion'] ?? settings.get('ai.termsAcceptedVersion')?.value;
    if (body.values['ai.enabled'] === true && terms !== AI_TERMS.currentVersion) {
      return problem(response, 422, 'AI_TERMS_NOT_ACCEPTED', String(correlationId));
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
  if (url.pathname === '/api/v1/suppliers' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const isActive = url.searchParams.get('isActive');
    const list = suppliers
      .filter((item) => isActive === null || String(item.isActive) === isActive)
      .filter(
        (item) =>
          q === '' ||
          [item.legalName, item.tradeName, item.documentNumber].some((text) =>
            String(text ?? '')
              .toLowerCase()
              .includes(q),
          ),
      )
      .sort((a, b) => a.legalName.localeCompare(b.legalName, 'pt-BR'));
    return send(response, 200, {
      data: list,
      meta: { page: 1, pageSize: 20, totalItems: list.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/suppliers/lookup' && request.method === 'GET') {
    const wanted = plainDocument(url.searchParams.get('documentNumber'));
    const found = suppliers.find((item) => plainDocument(item.documentNumber) === wanted);
    return send(response, 200, { data: found ?? null });
  }
  if (url.pathname === '/api/v1/suppliers' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const plain = plainDocument(body.documentNumber);
    if (suppliers.some((item) => plainDocument(item.documentNumber) === plain)) {
      return problem(response, 409, 'SUPPLIER_ALREADY_EXISTS', String(correlationId));
    }
    const created = {
      ...suppliers[0],
      id: mockUuid(),
      documentType: body.documentType,
      documentNumber:
        body.documentType === 'CPF' ? `***.${plain.slice(3, 6)}.${plain.slice(6, 9)}-**` : plain,
      legalName: body.legalName,
      tradeName: body.tradeName ?? null,
      email: body.email ?? null,
      isActive: true,
      version: 1,
    };
    suppliers.push(created);
    return send(
      response,
      201,
      { data: created },
      { ETag: '"1"', Location: `/api/v1/suppliers/${created.id}` },
    );
  }
  const supplierRoute = /^\/api\/v1\/suppliers\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (supplierRoute) {
    const supplier = suppliers.find((item) => item.id === supplierRoute[1]);
    if (!supplier) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (request.method === 'GET') {
      return send(response, 200, { data: supplier }, { ETag: `"${supplier.version}"` });
    }
    if (String(request.headers['if-match'] ?? '') !== `"${supplier.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    if (request.method === 'PATCH') {
      const body = JSON.parse((await readBody(request)) || '{}');
      Object.assign(supplier, body, { version: supplier.version + 1 });
      return send(response, 200, { data: supplier }, { ETag: `"${supplier.version}"` });
    }
    if (request.method === 'DELETE') {
      suppliers.splice(suppliers.indexOf(supplier), 1);
      response.writeHead(204);
      return response.end();
    }
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
  const assignmentsRoute = /^\/api\/v1\/users\/([0-9a-f-]{36})\/role-assignments$/.exec(
    url.pathname,
  );
  if (assignmentsRoute) {
    const member = members.find((item) => item.userId === assignmentsRoute[1]);
    if (!member) return problem(response, 404, 'USER_NOT_FOUND', String(correlationId));
    if (request.method === 'GET') {
      return send(response, 200, {
        data: roleAssignments
          .filter((item) => item.userId === member.userId && item.status === 'ACTIVE')
          .map(assignmentDto),
        meta: { canAssign: true, isSelf: false },
      });
    }
    if (request.method === 'POST') {
      const body = JSON.parse((await readBody(request)) || '{}');
      const duplicate = roleAssignments.some(
        (item) =>
          item.userId === member.userId &&
          item.status === 'ACTIVE' &&
          item.roleId === body.roleId &&
          item.scopeType === body.scopeType,
      );
      if (duplicate) {
        return problem(response, 409, 'ROLE_ASSIGNMENT_ALREADY_EXISTS', String(correlationId));
      }
      const now = new Date().toISOString();
      const created = {
        id: randomUUID(),
        userId: member.userId,
        roleId: body.roleId,
        scopeType: body.scopeType,
        scopeOrganizationId: body.scopeOrganizationId ?? null,
        scopeDepartmentId: body.scopeDepartmentId ?? null,
        includeSubtree: body.includeSubtree ?? true,
        validFrom: body.validFrom ?? now,
        validUntil: body.validUntil ?? null,
        status: 'ACTIVE',
        grantedAt: now,
        revokedAt: null,
        version: 1,
      };
      roleAssignments.push(created);
      return send(response, 201, { data: assignmentDto(created) }, { ETag: '"1"' });
    }
  }
  const revokeRoute = /^\/api\/v1\/role-assignments\/([0-9a-f-]{36})\/revoke$/.exec(url.pathname);
  if (revokeRoute && request.method === 'POST') {
    const assignment = roleAssignments.find((item) => item.id === revokeRoute[1]);
    if (!assignment)
      return problem(response, 404, 'ROLE_ASSIGNMENT_NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${assignment.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const admins = roleAssignments.filter(
      (item) =>
        item.status === 'ACTIVE' && item.roleId === roles[0].id && item.scopeType === 'TENANT',
    );
    if (assignment.roleId === roles[0].id && admins.length <= 1) {
      return send(
        response,
        409,
        {
          type: 'https://docs.contrataflow.com.br/errors/last-admin-required',
          title: 'Administrador obrigatório',
          status: 409,
          detail: 'É preciso manter ao menos um administrador ativo.',
          instance: url.pathname,
          code: 'LAST_ADMIN_REQUIRED',
          correlationId: String(correlationId),
          errors: [],
          violations: [],
        },
        { 'Content-Type': 'application/problem+json' },
      );
    }
    Object.assign(assignment, {
      status: 'REVOKED',
      revokedAt: new Date().toISOString(),
      version: assignment.version + 1,
    });
    return send(response, 200, { data: assignmentDto(assignment) });
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
  // US-109: prévia efêmera do template (TPL-09/12/13) — pronta já na primeira consulta.
  const templatePreviewRoute =
    /^\/api\/v1\/template-versions\/([0-9a-f-]{36})\/preview(?:\/([0-9a-f-]{36})(\/download)?)?$/.exec(
      url.pathname,
    );
  if (templatePreviewRoute) {
    const [, versionId, renditionId, download] = templatePreviewRoute;
    if (!templateVersions.some((item) => item.id === versionId)) {
      return problem(response, 404, 'NOT_FOUND', String(correlationId));
    }
    if (request.method === 'POST' && !renditionId) {
      const id = mockUuid();
      templatePreviews.set(id, versionId);
      return send(response, 202, { data: { renditionId: id } });
    }
    if (
      request.method === 'GET' &&
      renditionId &&
      templatePreviews.get(renditionId) === versionId
    ) {
      const now = new Date();
      if (download) {
        return send(response, 200, {
          data: { url: `${url.origin}/mock-s3/previa.pdf`, expiresAt: now.toISOString() },
        });
      }
      return send(response, 200, {
        data: {
          renditionId,
          templateVersionId: versionId,
          status: 'READY',
          pageCount: 2,
          sizeBytes: 2048,
          sha256: null,
          errorCode: null,
          errorMessage: null,
          requestedAt: now.toISOString(),
          readyAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 24 * HOUR_MS).toISOString(),
        },
      });
    }
    return problem(response, 404, 'NOT_FOUND', String(correlationId));
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
      const { layout: layoutPatch, ...content } = body;
      Object.assign(version, content, {
        version: version.version + 1,
        updatedAt: new Date().toISOString(),
      });
      if (layoutPatch) version.layout = mergeLayout(version.layout, layoutPatch);
      return send(
        response,
        200,
        { data: templateVersionView(version) },
        { ETag: `"${version.version}"` },
      );
    }
  }
  if (url.pathname === '/api/v1/workflows' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (workflows.some((item) => item.key === body.key)) {
      return problem(response, 409, 'CONFLICT', String(correlationId));
    }
    const draftId = mockUuid();
    const workflow = {
      id: mockUuid(),
      key: body.key,
      name: body.name,
      description: body.description ?? null,
      applicabilityRule: null,
      applicabilityPriority: 100,
      isDefault: false,
      isActive: true,
      currentPublishedVersion: null,
      draftVersion: { id: draftId, versionNumber: 1 },
      version: 1,
    };
    workflows.push(workflow);
    workflowVersions.set(draftId, emptyWorkflowVersion(draftId, workflow.id, 1, 'DRAFT'));
    return send(response, 201, { data: workflow }, { ETag: '"1"' });
  }
  const workflowRoute = /^\/api\/v1\/workflows\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (workflowRoute && request.method === 'GET') {
    const workflow = workflows.find((item) => item.id === workflowRoute[1]);
    if (!workflow) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    return send(response, 200, { data: workflow }, { ETag: `"${workflow.version}"` });
  }
  const draftRoute = /^\/api\/v1\/workflows\/([0-9a-f-]{36})\/versions$/.exec(url.pathname);
  // US-045 · WF-07: histórico por número decrescente (sem etapas/transições/regras).
  if (draftRoute && request.method === 'GET') {
    const workflow = workflows.find((item) => item.id === draftRoute[1]);
    if (!workflow) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    const data = [...workflowVersions.values()]
      .filter((version) => version.workflowId === workflow.id)
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .map(({ stages: _s, transitions: _t, rules: _r, initialStageId: _i, ...summary }) => ({
        ...summary,
        publishedByName: summary.publishedAt ? 'Ana Souza' : null,
        retiredByName: summary.retiredAt ? 'Ana Souza' : null,
      }));
    return send(response, 200, {
      data,
      meta: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 },
    });
  }
  // US-045 · WF-20/21/22: validar (só a etapa inicial bloqueia), publicar com If-Match e notas a
  // partir da v2 (supersede a publicada anterior) e aposentar (corrente única → WORKFLOW_IN_USE).
  const workflowLifecycleRoute =
    /^\/api\/v1\/workflow-versions\/([0-9a-f-]{36})\/(validate|publish|retire)$/.exec(url.pathname);
  if (workflowLifecycleRoute && request.method === 'POST') {
    const version = workflowVersions.get(workflowLifecycleRoute[1]);
    if (!version) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    const workflow = workflows.find((item) => item.id === version.workflowId);
    const issue = (code, message, stageKey = null) => ({
      code,
      message,
      stageKey,
      transitionKey: null,
      ruleId: null,
    });
    const validation = () => {
      const errors = [];
      if (version.stages.filter((stage) => stage.type === 'START').length !== 1) {
        errors.push(
          issue('WF_START_STAGE_COUNT', 'O fluxo precisa de exatamente uma etapa inicial.'),
        );
      }
      const warnings = version.stages
        .filter((stage) => stage.slaDays === null)
        .map((stage) =>
          issue('WF_STAGE_NO_SLA', `A etapa ${stage.name} não tem prazo.`, stage.key),
        );
      return { valid: errors.length === 0, errors, warnings };
    };
    if (workflowLifecycleRoute[2] === 'validate')
      return send(response, 200, { data: validation() });
    const body = JSON.parse((await readBody(request)) || '{}');
    if (String(request.headers['if-match'] ?? '') !== `"${version.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const summaryOf = ({ stages: _s, transitions: _t, rules: _r, ...summary }) => summary;
    const now = new Date().toISOString();
    if (workflowLifecycleRoute[2] === 'publish') {
      if (version.status !== 'DRAFT') {
        return problem(response, 409, 'INVALID_STATE', String(correlationId));
      }
      if (version.versionNumber >= 2 && !String(body.changeNotes ?? '').trim()) {
        return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
          errors: [
            {
              field: 'changeNotes',
              code: 'CONDITIONAL_REQUIRED',
              message: 'Descreva o que mudou nesta versão.',
            },
          ],
        });
      }
      const result = validation();
      if (!result.valid) {
        return problemWith(response, 422, 'WORKFLOW_INVALID', String(correlationId), {
          members: { validation: result },
        });
      }
      const previous = workflowVersions.get(workflow.currentPublishedVersion?.id ?? '');
      if (previous) {
        Object.assign(previous, {
          status: 'RETIRED',
          retiredAt: now,
          version: previous.version + 1,
        });
      }
      Object.assign(version, {
        status: 'PUBLISHED',
        publishedAt: now,
        changeNotes: body.changeNotes ?? null,
        definitionHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        version: version.version + 1,
      });
      Object.assign(workflow, {
        currentPublishedVersion: {
          id: version.id,
          versionNumber: version.versionNumber,
          publishedAt: now,
        },
        draftVersion: null,
        version: workflow.version + 1,
      });
      return send(response, 200, { data: summaryOf(version) }, { ETag: `"${version.version}"` });
    }
    if (version.status !== 'PUBLISHED') {
      return problem(response, 409, 'INVALID_STATE', String(correlationId));
    }
    if (workflow.currentPublishedVersion?.id === version.id && workflow.isActive) {
      return problem(response, 409, 'WORKFLOW_IN_USE', String(correlationId));
    }
    Object.assign(version, { status: 'RETIRED', retiredAt: now, version: version.version + 1 });
    return send(response, 200, { data: summaryOf(version) }, { ETag: `"${version.version}"` });
  }
  if (draftRoute && request.method === 'POST') {
    const workflow = workflows.find((item) => item.id === draftRoute[1]);
    if (!workflow) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (workflow.draftVersion) {
      return problemWith(response, 409, 'WORKFLOW_DRAFT_EXISTS', String(correlationId), {
        members: { meta: { draftVersionId: workflow.draftVersion.id } },
      });
    }
    const source = workflowVersions.get(workflow.currentPublishedVersion?.id ?? '');
    if (!source) return problem(response, 422, 'BUSINESS_RULE_VIOLATION', String(correlationId));
    const draftId = mockUuid();
    const ids = new Map(source.stages.map((stage) => [stage.id, mockUuid()]));
    const draft = {
      ...emptyWorkflowVersion(draftId, workflow.id, source.versionNumber + 1, 'DRAFT'),
      stages: source.stages.map((stage) => ({
        ...stage,
        id: ids.get(stage.id),
        workflowVersionId: draftId,
        version: 1,
      })),
      transitions: source.transitions.map((transition) => ({
        ...transition,
        id: mockUuid(),
        workflowVersionId: draftId,
        fromStageId: ids.get(transition.fromStageId),
        toStageId: ids.get(transition.toStageId),
        version: 1,
      })),
    };
    workflowVersions.set(draftId, draft);
    Object.assign(workflow, {
      draftVersion: { id: draftId, versionNumber: draft.versionNumber },
      version: workflow.version + 1,
    });
    return send(response, 201, { data: draft });
  }
  // Regras (US-044 · WF-16..19 e WF-23): schema do contexto, CRUD no rascunho e o dry-run.
  if (url.pathname === '/api/v1/rule-context/schema' && request.method === 'GET') {
    return send(response, 200, { data: RULE_CONTEXT_SCHEMA });
  }
  if (url.pathname === '/api/v1/processes' && request.method === 'GET') {
    const q = String(url.searchParams.get('q') ?? '').toLowerCase();
    const data = [...RULE_TEST_PROCESSES, ...processes.map((item) => item.view)].filter((item) =>
      `${item.code ?? ''} ${item.title}`.toLowerCase().includes(q),
    );
    return send(response, 200, {
      data,
      meta: { page: 1, pageSize: 10, totalItems: data.length, totalPages: 1 },
    });
  }
  const rulesRoute = /^\/api\/v1\/workflow-versions\/([0-9a-f-]{36})\/rules(\/test)?$/.exec(
    url.pathname,
  );
  if (rulesRoute && request.method === 'POST') {
    const version = workflowVersions.get(rulesRoute[1]);
    if (!version) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    const body = JSON.parse((await readBody(request)) || '{}');
    if (rulesRoute[2]) {
      // Sem documentos no processo de referência: REQUIRED_DOCUMENT nunca é satisfeita.
      const satisfied = body.type !== 'REQUIRED_DOCUMENT';
      return send(response, 200, {
        data: {
          satisfied,
          severity: body.severity ?? 'BLOCKING',
          message: satisfied ? 'Regra satisfeita.' : (body.message ?? 'Regra não satisfeita.'),
          contextUsed:
            body.type === 'REQUIRED_DOCUMENT'
              ? {
                  [`documents.${body.config?.documentTypeCode}`]: { exists: false, count: 0 },
                  matchingCount: 0,
                  requiredCount: 1,
                }
              : {},
          warnings: [],
        },
      });
    }
    if (version.status !== 'DRAFT') {
      return problem(response, 409, 'WORKFLOW_VERSION_NOT_DRAFT', String(correlationId));
    }
    const created = {
      description: null,
      stageId: null,
      transitionId: null,
      severity: 'BLOCKING',
      isActive: true,
      displayOrder: version.rules.length,
      ...body,
      id: mockUuid(),
      workflowVersionId: version.id,
      version: 1,
    };
    version.rules.push(created);
    version.version += 1;
    return send(response, 201, { data: created }, { ETag: '"1"' });
  }
  const ruleRoute = /^\/api\/v1\/workflow-rules\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (ruleRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const owner = workflowItemOwner('rules', ruleRoute[1]);
    if (!owner) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    const { version, item } = owner;
    if (version.status !== 'DRAFT') {
      return problem(response, 409, 'WORKFLOW_VERSION_NOT_DRAFT', String(correlationId));
    }
    if (String(request.headers['if-match'] ?? '') !== `"${item.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    if (request.method === 'DELETE') {
      version.rules = version.rules.filter((entry) => entry !== item);
      version.version += 1;
      response.writeHead(204);
      return response.end();
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    Object.assign(item, body, { version: item.version + 1 });
    version.version += 1;
    return send(response, 200, { data: item }, { ETag: `"${item.version}"` });
  }
  const versionRoute =
    /^\/api\/v1\/workflow-versions\/([0-9a-f-]{36})(\/stages|\/transitions)?$/.exec(url.pathname);
  if (versionRoute) {
    const version = workflowVersions.get(versionRoute[1]);
    if (!version) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (!versionRoute[2] && request.method === 'GET') {
      return send(response, 200, { data: version }, { ETag: `"${version.version}"` });
    }
    if (versionRoute[2] && request.method === 'POST') {
      if (version.status !== 'DRAFT') {
        return problem(response, 409, 'WORKFLOW_VERSION_NOT_DRAFT', String(correlationId));
      }
      const body = JSON.parse((await readBody(request)) || '{}');
      const kind = versionRoute[2] === '/stages' ? 'stages' : 'transitions';
      if (version[kind].some((item) => item.key === body.key)) {
        return problem(response, 409, 'CONFLICT', String(correlationId));
      }
      const created =
        kind === 'stages'
          ? {
              ...STAGE_DEFAULTS,
              ...body,
              displayOrder: body.displayOrder ?? version.stages.length,
              id: mockUuid(),
              workflowVersionId: version.id,
              version: 1,
            }
          : {
              description: null,
              ...body,
              id: mockUuid(),
              workflowVersionId: version.id,
              version: 1,
            };
      version[kind].push(created);
      version.version += 1;
      return send(response, 201, { data: created }, { ETag: '"1"' });
    }
  }
  const itemRoute = /^\/api\/v1\/workflow-(stages|transitions)\/([0-9a-f-]{36})$/.exec(
    url.pathname,
  );
  if (itemRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const kind = itemRoute[1];
    const owner = workflowItemOwner(kind, itemRoute[2]);
    if (!owner) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    const { version, item } = owner;
    if (version.status !== 'DRAFT') {
      return problem(response, 409, 'WORKFLOW_VERSION_NOT_DRAFT', String(correlationId));
    }
    if (String(request.headers['if-match'] ?? '') !== `"${item.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    if (request.method === 'DELETE') {
      const linked =
        kind === 'stages'
          ? version.transitions.filter((t) => t.fromStageId === item.id || t.toStageId === item.id)
          : [];
      if (linked.length > 0) {
        return send(
          response,
          422,
          {
            type: 'https://docs.contrataflow.com.br/errors/business-rule-violation',
            title: 'BUSINESS_RULE_VIOLATION',
            status: 422,
            detail: 'BUSINESS_RULE_VIOLATION',
            instance: '/api/v1',
            code: 'BUSINESS_RULE_VIOLATION',
            correlationId: String(correlationId),
            errors: [],
            violations: linked.map((transition) => ({
              code: 'REFERENCED_BY_TRANSITION',
              severity: 'BLOCKING',
              message: 'Remova primeiro as transições que usam esta etapa.',
              ruleId: 'RN-WF-50',
              sectionKey: null,
              field: null,
              itemId: transition.id,
              params: { kind: 'TRANSITION', key: transition.key, name: transition.name },
            })),
          },
          { 'Content-Type': 'application/problem+json' },
        );
      }
      version[kind] = version[kind].filter((entry) => entry !== item);
      version.version += 1;
      response.writeHead(204);
      return response.end();
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    Object.assign(item, body, { version: item.version + 1 });
    version.version += 1;
    return send(response, 200, { data: item }, { ETag: `"${item.version}"` });
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
  if (url.pathname === '/api/v1/me/notification-preferences') {
    const meta = { emailEnabled: settings.get('notifications.emailEnabled')?.value !== false };
    if (request.method === 'GET') {
      return send(response, 200, { data: notificationPreferencesView(sub), meta });
    }
    if (request.method === 'PUT') {
      const body = JSON.parse((await readBody(request)) || '{}');
      const saved = notificationPreferences.get(sub) ?? new Map();
      for (const item of body.preferences ?? []) {
        const known = NOTIFICATION_TYPE_DEFAULTS.find(([type]) => type === item.notificationType);
        if (!known) return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
        if (item.channel === 'IN_APP' && known[2] && item.enabled === false) {
          return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
        }
        const key = `${item.notificationType}:${item.channel}`;
        if (item.enabled === null) saved.delete(key);
        else saved.set(key, item.enabled);
      }
      notificationPreferences.set(sub, saved);
      return send(response, 200, { data: notificationPreferencesView(sub), meta });
    }
  }
  if (url.pathname === '/api/v1/me' && request.method === 'GET') {
    // ME-01 (US-098): perfil do usuário (as lotações do wizard vêm do ME-03).
    return send(
      response,
      200,
      {
        data: {
          id: sub,
          name: sub === 'sub-ana' ? 'Ana Souza' : 'Usuário',
          socialName: null,
          email: sub === 'sub-ana' ? 'ana@prefeitura-a.test' : 'usuario@prefeitura-a.test',
          phone: null,
          membership: { jobTitle: null, departments: [] },
          preferences: { density: 'comfortable', theme: 'light' },
          version: 1,
        },
      },
      { ETag: '"1"' },
    );
  }
  if (url.pathname === '/api/v1/workflows/resolve' && request.method === 'POST') {
    // WF-06 (US-042): "Serviços comuns" não tem fluxo aplicável (FA-06).
    const body = JSON.parse((await readBody(request)) || '{}');
    const type = catalogItems.find((item) => item.id === body.contractingTypeId);
    if (type?.code === 'SERVICOS') {
      return problem(response, 422, 'NO_APPLICABLE_WORKFLOW', String(correlationId));
    }
    return send(response, 200, { data: WORKFLOW_RESOLUTION });
  }
  if (url.pathname === '/api/v1/processes/check-duplicates' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    return send(response, 200, { data: { candidates: duplicateCandidates(sub, body.title) } });
  }
  if (url.pathname === '/api/v1/processes' && request.method === 'POST') {
    // PRC-02 (US-001): idempotente por chave (corpo diferente com a mesma chave → 422), 409 de
    // duplicidade até `confirmDuplicate`, numeração sequencial `{seq:4}/{year}`.
    const raw = await readBody(request);
    const body = JSON.parse(raw || '{}');
    const key = String(request.headers['idempotency-key'] ?? '');
    const replay = key ? processReplays.get(key) : undefined;
    if (replay) {
      if (replay.raw !== raw) {
        return problem(response, 422, 'IDEMPOTENCY_KEY_REUSED', String(correlationId));
      }
      return send(
        response,
        201,
        { data: replay.view },
        {
          'Idempotent-Replayed': 'true',
          Location: `/api/v1/processes/${replay.view.id}`,
          ETag: '"1"',
        },
      );
    }
    const errors = processBodyErrors(body);
    if (errors.length > 0) {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), { errors });
    }
    const candidates = duplicateCandidates(sub, body.title);
    if (candidates.length > 0 && body.confirmDuplicate !== true) {
      return problemWith(response, 409, 'POSSIBLE_DUPLICATE_PROCESS', String(correlationId), {
        members: { candidates },
      });
    }
    processSequence += 1;
    const year = new Date().getFullYear();
    const now = new Date().toISOString();
    const department = departmentRef(body.requestingDepartmentId);
    const author = { id: sub, name: sub === 'sub-ana' ? 'Ana Souza' : 'Usuário' };
    const view = {
      id: randomUUID(),
      code: `${String(processSequence).padStart(4, '0')}/${String(year)}`,
      number: processSequence,
      year,
      internalCode: body.internalCode ?? null,
      title: String(body.title).trim(),
      object: String(body.object).trim(),
      description: body.description ?? null,
      status: 'DRAFT',
      priority: body.priority ?? 'MEDIUM',
      organization: { id: body.organizationId ?? organizations[0].id, shortName: 'PMSJ' },
      requestingSecretariat: departmentRef(body.requestingSecretariatId),
      requestingDepartment: department,
      contractingType: catalogRef(body.contractingTypeId),
      modality: body.modalityId ? catalogRef(body.modalityId) : null,
      origin: catalogRef(body.originId),
      isPriceRegistration: body.isPriceRegistration === true,
      currentStage: {
        id: WORKFLOW_RESOLUTION.initialStage.id,
        key: 'ABERTURA',
        name: WORKFLOW_RESOLUTION.initialStage.name,
        dueAt: null,
        instructions: null,
        documentTypeCodes: ['DFD'],
      },
      currentDepartment: department,
      currentResponsible: author,
      workflow: {
        id: WORKFLOW_RESOLUTION.workflowId,
        name: WORKFLOW_RESOLUTION.name,
        versionNumber: 1,
      },
      targetDate: body.targetDate ?? null,
      estimatedValue: body.estimatedValue ?? null,
      estimatedValueMasked: false,
      estimatedValueSource: body.estimatedValue ? 'MANUAL' : null,
      isBudgetConfidential: false,
      pcaStatus: body.pcaStatus,
      pcaYear: body.pcaYear ?? null,
      pcaItemCode: body.pcaItemCode ?? null,
      pcaJustification: body.pcaJustification ?? null,
      notes: body.notes ?? null,
      creationChannel: 'WEB',
      openedAt: now,
      createdAt: now,
      updatedAt: now,
      createdBy: author,
      version: 1,
    };
    processes.push({ view, subject: sub, createdAtMs: Date.now() });
    if (key) processReplays.set(key, { raw, view });
    return send(
      response,
      201,
      { data: view },
      { Location: `/api/v1/processes/${view.id}`, ETag: '"1"' },
    );
  }
  if (url.pathname === '/api/v1/audit' && request.method === 'GET') {
    // AUD-01 (US-075): filtros por período e ação; uma página só (sem cursor).
    return send(response, 200, {
      data: filterAuditLogs(url.searchParams),
      meta: { nextCursor: null, hasMore: false },
    });
  }
  if (url.pathname === '/api/v1/audit/export' && request.method === 'GET') {
    // AUD-03 (US-075): arquivo com os mesmos filtros (CSV com escape de fórmulas ou NDJSON).
    const items = filterAuditLogs(url.searchParams);
    const ndjson = url.searchParams.get('format') === 'ndjson';
    response.writeHead(200, {
      'Content-Type': ndjson ? 'application/x-ndjson; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="auditoria.${ndjson ? 'ndjson' : 'csv'}"`,
    });
    return response.end(
      ndjson ? items.map((item) => `${JSON.stringify(item)}\n`).join('') : auditCsv(items),
    );
  }
  const auditLogMatch = /^\/api\/v1\/audit\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (auditLogMatch && request.method === 'GET') {
    // AUD-02 (US-075): registro como gravado (mascarado); inexistente → 404.
    const found = auditLogs.find((item) => item.id === auditLogMatch[1]);
    if (!found) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    return send(response, 200, { data: found });
  }
  if (url.pathname === '/api/v1/audit/seals' && request.method === 'GET') {
    // AUD-04 (US-074): a permissão AUDIT_VIEW é conferida pelo front via ME-03 (a API real decide).
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    const items = auditSeals.slice((page - 1) * pageSize, page * pageSize);
    return send(response, 200, {
      data: items,
      meta: {
        page,
        pageSize,
        totalItems: auditSeals.length,
        totalPages: Math.max(1, Math.ceil(auditSeals.length / pageSize)),
      },
    });
  }
  if (url.pathname === '/api/v1/audit/seals/verify' && request.method === 'POST') {
    const outcome = verifyAuditSeals(JSON.parse((await readBody(request)) || '{}'));
    if (outcome.status === 404) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (outcome.status === 422) {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
        errors: outcome.errors,
      });
    }
    return send(response, 200, { data: outcome.data });
  }
  if (url.pathname === `/api/v1/documents/${VERSIONED_DOCUMENT_ID}` && request.method === 'GET') {
    // DOC-03: o rascunho editável — "Salvar versão" aparece pela ação UPDATE (POL-02).
    return send(
      response,
      200,
      { data: versionedDocument, meta: { allowedActions: ['UPDATE'] } },
      { ETag: `"${String(versionedDocument.version)}"` },
    );
  }
  const versionsPath = `/api/v1/documents/${VERSIONED_DOCUMENT_ID}/versions`;
  if (url.pathname === versionsPath && request.method === 'GET') {
    const items = documentVersions.map((entry) => entry.summary).reverse();
    return send(response, 200, {
      data: items,
      meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 },
    });
  }
  if (url.pathname === versionsPath && request.method === 'POST') {
    const key = String(request.headers['idempotency-key'] ?? '');
    const replayed = key ? versionReplays.get(key) : undefined;
    if (replayed) return send(response, 201, replayed, { 'Idempotent-Replayed': 'true' });
    const body = JSON.parse((await readBody(request)) || '{}');
    if (typeof body.changeSummary === 'string' && body.changeSummary.length > 500) {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
        errors: [{ field: 'changeSummary', code: 'TOO_LONG', message: 'TOO_LONG' }],
      });
    }
    const version = recordDocumentVersion({
      reason: 'MANUAL',
      changeSummary: body.changeSummary ?? null,
      objectText: DRAFT_OBJECT_TEXT,
      createdAt: new Date().toISOString(),
    });
    const created = { data: { ...version, kind: 'FREE_TEXT', content: null } };
    if (key) versionReplays.set(key, created);
    return send(response, 201, created, {
      Location: `/api/v1/document-versions/${version.id}`,
    });
  }
  if (url.pathname === `${versionsPath}/compare` && request.method === 'GET') {
    const from = documentVersions.find(
      (entry) => entry.summary.id === url.searchParams.get('from'),
    );
    const to = documentVersions.find((entry) => entry.summary.id === url.searchParams.get('to'));
    if (!from || !to || from === to) {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
        errors: [{ field: 'to', code: 'REFERENCE_NOT_FOUND', message: 'REFERENCE_NOT_FOUND' }],
      });
    }
    return send(response, 200, { data: compareDocumentVersions(from, to) });
  }
  const commentsRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/comments$/.exec(url.pathname);
  if (commentsRoute) {
    // CMT-01/CMT-02 (US-071): threads (raízes mais recentes primeiro) e criação/resposta.
    const found = processes.find((item) => item.view.id === commentsRoute[1]);
    if (!found) return problem(response, 404, 'PROCESS_NOT_FOUND', String(correlationId));
    const list = commentsOf(found.view.id);
    if (request.method === 'GET') {
      const roots = list.filter((item) => item.parentId === null).reverse();
      return send(response, 200, {
        data: roots.map((root) => {
          const replies = list.filter((item) => item.parentId === root.id);
          return {
            ...commentView(root, sub),
            replies: replies.map((reply) => commentView(reply, sub)),
            replyCount: replies.length,
          };
        }),
        meta: {
          nextCursor: null,
          hasMore: false,
          canComment: true,
          readOnly: false,
          isBudgetConfidential: found.view.isBudgetConfidential === true,
        },
      });
    }
    if (request.method === 'POST') {
      const body = JSON.parse((await readBody(request)) || '{}');
      if (!commentAllowed(body.body)) {
        return problem(response, 422, 'RICH_TEXT_INVALID', String(correlationId));
      }
      if (commentText(body.body).trim() === '') {
        return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
      }
      const parent = body.parentId ? list.find((item) => item.id === body.parentId) : null;
      const comment = {
        id: randomUUID(),
        processId: found.view.id,
        targetType: parent?.targetType ?? body.targetType,
        documentId: parent?.documentId ?? body.documentId ?? null,
        sectionKey: parent?.sectionKey ?? body.sectionKey ?? null,
        parentId: parent?.id ?? null,
        authorId: sub,
        authorName: sub === 'sub-ana' ? 'Ana Souza' : 'Usuário',
        body: body.body,
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        deletionReason: null,
        version: 1,
      };
      list.push(comment);
      return send(
        response,
        201,
        { data: commentView(comment, sub) },
        { Location: `/api/v1/comments/${comment.id}`, ETag: '"1"' },
      );
    }
  }
  const commentRoute = /^\/api\/v1\/comments\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (commentRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
    // CMT-03/CMT-04 (US-071): edição do autor e exclusão/moderação, com `If-Match`.
    const comment = findComment(commentRoute[1]);
    if (!comment) return problem(response, 404, 'COMMENT_NOT_FOUND', String(correlationId));
    if (request.headers['if-match'] !== `"${String(comment.version)}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (request.method === 'PATCH') {
      if (!commentAllowed(body.body)) {
        return problem(response, 422, 'RICH_TEXT_INVALID', String(correlationId));
      }
      Object.assign(comment, {
        body: body.body,
        editedAt: new Date().toISOString(),
        version: comment.version + 1,
      });
      return send(
        response,
        200,
        { data: commentView(comment, sub) },
        { ETag: `"${String(comment.version)}"` },
      );
    }
    const moderation = comment.authorId !== sub;
    if (moderation && String(body.reason ?? '').trim().length < 10) {
      return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
    }
    Object.assign(comment, {
      deletedAt: new Date().toISOString(),
      deletionReason: moderation ? String(body.reason).trim() : null,
      version: comment.version + 1,
    });
    return send(response, 204);
  }
  const timelineRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/timeline$/.exec(url.pathname);
  if (timelineRoute && request.method === 'GET') {
    const found = processes.find((item) => item.view.id === timelineRoute[1]);
    if (!found) return problem(response, 404, 'PROCESS_NOT_FOUND', String(correlationId));
    return send(response, 200, listTimeline(found, url.searchParams));
  }
  const processRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})(\/available-actions)?$/.exec(
    url.pathname,
  );
  if (processRoute && request.method === 'GET') {
    // PRC-04 e PRC-08 (US-004/US-041): o processo criado e as ações do painel (nenhuma no mock).
    const found = processes.find((item) => item.view.id === processRoute[1]);
    if (!found) return problem(response, 404, 'PROCESS_NOT_FOUND', String(correlationId));
    return send(response, 200, { data: processRoute[2] ? [] : found.view });
  }
  return problem(response, 404, 'NOT_FOUND', String(correlationId));
}).listen(PORT, () => {
  process.stdout.write(`mock-api pronto na porta ${PORT}\n`);
});
