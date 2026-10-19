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
  ['PRICE_RESEARCH', 'Pesquisa de preços', 'STRUCTURED', 'PRICE_RESEARCH', 30, 'PP {seq:4}/{year}'],
  ['DOCUMENTO_EXTERNO', 'Documento externo', 'UPLOADED', null, 110, null],
  // US-036: no fim, para não deslocar os ids (derivados do índice) dos tipos anteriores.
  ['TR', 'Termo de Referência', 'STRUCTURED', 'TERM_OF_REFERENCE', 40, 'TR {seq:4}/{year}'],
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
// Tipos de fonte de pesquisa (US-026 · PRICE_SOURCE_TYPE): os campos exigidos como os semeados.
catalogItems.push(
  ...[
    [
      'SITIO_ELETRONICO',
      'Sítio eletrônico especializado (art. 23, § 1º, III)',
      ['url', 'accessedAt'],
    ],
    [
      'PESQUISA_DIRETA_FORNECEDOR',
      'Pesquisa direta com fornecedor (art. 23, § 1º, IV)',
      ['supplierId', 'quoteDate', 'attachment', 'supplierChoiceJustification'],
    ],
  ].map(([code, label, requiredFields], index) => ({
    id: `0192a000-0000-7000-8000-00000000c3${String(index).padStart(2, '0')}`,
    catalogType: 'PRICE_SOURCE_TYPE',
    code,
    label,
    description: null,
    isSystem: true,
    isActive: true,
    sortOrder: index + 1,
    parentId: null,
    metadata: { legalBasis: 'Lei 14.133/2021, art. 23', requiredFields },
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 1,
  })),
);

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

// Histórico de tramitações (US-054 · PRC-11): 60 tramitações por processo (CREATE + idas e voltas
// entre a Manutenção e as Cotações e uma decisão de aprovação a cada 10), filtros por ação (OU),
// unidade, ator e período, cursor `p{offset}`. Sem AUDIT_VIEW para a Ana (`canViewIp = false`).
const MOVEMENT_UNITS = [
  { id: '0192e054-0000-7000-8000-0000000000a2', name: 'Setor de Manutenção', isActive: true },
  { id: '0192e054-0000-7000-8000-0000000000a6', name: 'Setor de Cotações', isActive: true },
];
const MOVEMENT_STAGES = [
  { id: '0192e054-0000-7000-8000-0000000005a1', name: 'Abertura' },
  { id: '0192e054-0000-7000-8000-0000000005a2', name: 'Pesquisa de preços' },
];
const movementHistories = new Map();
function movementsOf(found) {
  const cached = movementHistories.get(found.view.id);
  if (cached) return cached;
  const base = found.createdAtMs;
  const items = [];
  for (let sequence = 1; sequence <= 60; sequence += 1) {
    const forward = sequence % 2 === 0;
    const approval = sequence % 10 === 0;
    const [from, to] = forward ? [0, 1] : [1, 0];
    const actor = TIMELINE_ACTORS[sequence % TIMELINE_ACTORS.length];
    const action =
      sequence === 1 ? 'CREATE' : approval ? 'APPROVE' : forward ? 'FORWARD' : 'RETURN';
    items.push({
      id: randomUUID(),
      sequence,
      action,
      fromStage: sequence === 1 ? null : MOVEMENT_STAGES[from],
      toStage: MOVEMENT_STAGES[to],
      fromDepartment: sequence === 1 ? null : MOVEMENT_UNITS[from],
      toDepartment: MOVEMENT_UNITS[to],
      fromUser: null,
      toUser: null,
      statusFrom: sequence === 1 ? null : 'IN_PROGRESS',
      statusTo: sequence === 1 ? 'DRAFT' : action === 'RETURN' ? 'RETURNED' : 'IN_PROGRESS',
      actor:
        sequence === 1
          ? {
              type: 'USER',
              id: found.view.createdBy.id,
              name: found.view.createdBy.name,
              departmentName: null,
            }
          : {
              type: 'USER',
              id: actor.id,
              name: actor.name,
              departmentName: MOVEMENT_UNITS[from].name,
            },
      comment: action === 'RETURN' ? `Devolução ${sequence}: revisar o item.` : null,
      dueAt: null,
      documents: [],
      approvalId: approval ? randomUUID() : null,
      approvalSummary: approval
        ? { title: `Aprovação ${sequence}`, status: 'APPROVED', decision: 'APPROVE' }
        : null,
      occurredAt: new Date(base - (60 - sequence) * 3_600_000).toISOString(),
      ip: null,
      userAgent: 'Mozilla/5.0',
      correlationId: `e2e-${sequence}`,
    });
  }
  items.reverse();
  movementHistories.set(found.view.id, items);
  return items;
}
function listMovements(found, query) {
  const actions = (query.get('action') ?? '').split(',').filter(Boolean);
  const from = query.get('occurredFrom');
  const to = query.get('occurredTo');
  const limit = Math.min(Number(query.get('limit') ?? 50), 100);
  const offset = query.get('cursor') ? Number(query.get('cursor').slice(1)) : 0;
  const matching = movementsOf(found).filter(
    (item) =>
      (actions.length === 0 || actions.includes(item.action)) &&
      (!query.get('fromDepartmentId') ||
        item.fromDepartment?.id === query.get('fromDepartmentId')) &&
      (!query.get('toDepartmentId') || item.toDepartment?.id === query.get('toDepartmentId')) &&
      (!query.get('actorId') || item.actor.id === query.get('actorId')) &&
      (!from || item.occurredAt >= new Date(from).toISOString()) &&
      (!to || item.occurredAt <= new Date(to).toISOString()),
  );
  const data = matching.slice(offset, offset + limit);
  const hasMore = offset + limit < matching.length;
  return {
    data,
    meta: { nextCursor: hasMore ? `p${offset + limit}` : null, hasMore, canViewIp: false },
  };
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
// US-072: quem pode ser mencionado no mock (CMT-05 filtra por nome; a API real aplica DEC-024).
const MENTIONABLE = [
  {
    kind: 'USER',
    id: '0192e072-0000-7000-8000-0000000000c1',
    label: 'Cláudia Ramos',
    secondaryLabel: 'Secretaria de Saúde',
  },
  { kind: 'DEPARTMENT', id: '0192e072-0000-7000-8000-0000000000d1', label: 'Setor de Manutenção' },
];
const foldText = (text) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
function mentionNodes(node) {
  if (node?.type === 'mention') return [node.attrs ?? {}];
  return (node?.content ?? []).flatMap(mentionNodes);
}
function commentAllowed(node, depth = 0) {
  const nodes = [
    'doc',
    'paragraph',
    'text',
    'bulletList',
    'orderedList',
    'listItem',
    'hardBreak',
    'mention',
  ];
  if (depth > 12 || typeof node !== 'object' || node === null || !nodes.includes(node.type)) {
    return false;
  }
  if (
    node.type === 'mention' &&
    (!['USER', 'DEPARTMENT'].includes(node.attrs?.kind) || typeof node.attrs?.id !== 'string')
  ) {
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
  if (node?.type === 'mention') return `@${node.attrs?.label ?? ''}`;
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
    // US-072: só alvos "visíveis" (os de MENTIONABLE) viram menção válida (RN-CMT-22).
    mentions: deleted
      ? []
      : mentionNodes(comment.body)
          .filter((attrs) =>
            MENTIONABLE.some((item) => item.kind === attrs.kind && item.id === attrs.id),
          )
          .filter(
            (attrs, index, all) =>
              all.findIndex((other) => other.kind === attrs.kind && other.id === attrs.id) ===
              index,
          )
          .map((attrs) => ({
            id: comment.mentionIds?.[`${attrs.kind}:${attrs.id}`] ?? randomUUID(),
            kind: attrs.kind,
            targetId: attrs.id,
          })),
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
// Lista de processos, visões salvas e exportação CSV (US-002/US-003 · SCR-004): três processos
// fixos (um atrasado, um devolvido) bastam para a jornada de salvar, aplicar e exportar; a
// ordenação, a paginação e as regras de visibilidade/mascaramento são cobertas nos testes da API.
const LIST_FIXTURES = [
  {
    n: 12,
    code: '0012/2026',
    title: 'Aquisição de cimento para manutenção de vias',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    overdue: false,
    unit: 0,
  },
  {
    n: 31,
    code: '0031/2026',
    title: 'Contratação de limpeza hospitalar',
    status: 'RETURNED',
    priority: 'MEDIUM',
    overdue: false,
    unit: 0,
  },
  {
    n: 45,
    code: '0045/2026',
    title: 'Aquisição de medicamentos da farmácia básica',
    status: 'AWAITING_APPROVAL',
    priority: 'URGENT',
    overdue: true,
    unit: 0,
  },
];
const LIST_STATUS_LABELS = {
  DRAFT: 'Rascunho',
  IN_PROGRESS: 'Em andamento',
  AWAITING_APPROVAL: 'Aguardando aprovação',
  RETURNED: 'Devolvido',
  SUSPENDED: 'Suspenso',
};
const LIST_PRIORITY_LABELS = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', URGENT: 'Urgente' };
/** Unidade que existia quando a visão compartilhada foi salva e hoje não existe mais (FA-05). */
const REMOVED_UNIT_ID = '0192a000-0000-7000-8000-00000000dead';
const listProcessId = (n) => `0192a000-0000-7000-8000-${String(100000 + n).padStart(12, '0')}`;

// Etiquetas (US-007 · SCR-109/SCR-006/SCR-004): cadastro e vínculos globais da API simulada. A
// unicidade `lower(name)`, o limite de 10, a paleta e as regras de custódia/status são cobertos nos
// testes da API; aqui valem a jornada (cadastrar, aplicar, filtrar, desativar) e o 412 por versão.
const TAG_PALETTE = [
  '#64748B',
  '#B45309',
  '#B91C1C',
  '#C2410C',
  '#4D7C0F',
  '#15803D',
  '#0F766E',
  '#0369A1',
  '#1D4ED8',
  '#4338CA',
  '#7E22CE',
  '#BE185D',
];
const tags = [];
/** processId → ids de etiqueta; versão do processo (If-Match de PRC-18) começa em 9. */
const processTagLinks = new Map();
const processVersions = new Map();
const tagDto = (tag) => ({
  id: tag.id,
  name: tag.name,
  color: tag.color,
  isActive: tag.isActive,
  version: tag.version,
});
const tagsOfProcess = (processId) =>
  [...(processTagLinks.get(processId) ?? [])]
    .map((id) => tags.find((tag) => tag.id === id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
const processVersionOf = (processId) => processVersions.get(processId) ?? 9;

// Suspensão (US-008 · SCR-116): processId → { statusBefore, suspendedAt, reason }. Extensão do
// prazo, congelamento, permissões e concorrência são cobertos nos testes da API; aqui vale a
// jornada J-06 (suspender, ver o painel, retomar e conferir o novo prazo).
const suspensions = new Map();
// Cancelamento e descarte (US-009 · SCR-116 — jornada J-07): processos próprios, fora da lista
// padrão (cancelar é definitivo e o servidor simulado é compartilhado pelas jornadas). O 0093/2026
// é um rascunho já numerado que ainda oferece "Descartar rascunho" (ações lidas antes da numeração)
// para exercitar o 409 `CANNOT_DISCARD_NUMBERED_PROCESS` (FA-01). Efeitos sobre aprovações,
// documentos, auditoria, permissões e concorrência são cobertos nos testes da API.
const CANCELLATION_FIXTURES = [
  {
    n: 91,
    code: '0091/2026',
    title: 'Aquisição de mobiliário escolar',
    status: 'AWAITING_APPROVAL',
    priority: 'MEDIUM',
    overdue: false,
    unit: 0,
  },
  {
    n: 92,
    code: null,
    title: 'Rascunho de compra de uniformes',
    status: 'DRAFT',
    priority: 'LOW',
    overdue: false,
    unit: 0,
  },
  {
    n: 93,
    code: '0093/2026',
    title: 'Rascunho numerado de compra de toners',
    status: 'DRAFT',
    priority: 'LOW',
    overdue: false,
    unit: 0,
  },
];
// Atribuir responsável (US-050 · SCR-115): o 0094/2026 começa na fila da unidade. Elegibilidade,
// POL-05, concorrência e outro tenant são cobertos nos testes da API; aqui vale a jornada (atribuir
// da fila, reatribuir com motivo e devolver à fila). processId → { id, name } | null.
const ASSIGN_FIXTURES = [
  {
    n: 94,
    code: '0094/2026',
    title: 'Aquisição de material de expediente',
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    overdue: false,
    unit: 0,
  },
];
const ASSIGN_MEMBERS = [
  { id: '0192a000-0000-7000-8000-00000000a0a1', name: 'Ana Souza' },
  { id: '0192a000-0000-7000-8000-00000000a0b2', name: 'Juliana Prado' },
  { id: '0192a000-0000-7000-8000-00000000a0c3', name: 'Tiago Reis' },
].map((member) => ({
  ...member,
  email: `${member.name.split(' ')[0].toLowerCase()}@saojose.sc.gov.br`,
  membershipType: 'INTERNAL',
  membershipExpiresAt: null,
}));
const assignedResponsibles = new Map();
const isAssignFixture = (fixture) => ASSIGN_FIXTURES.includes(fixture);
const cancellations = new Map();
const discardedDrafts = new Set();
const isCancellationFixture = (fixture) => CANCELLATION_FIXTURES.includes(fixture);
const statusOfListed = (processId, fixture) => {
  if (cancellations.has(processId)) return 'CANCELED';
  return suspensions.has(processId) ? 'SUSPENDED' : fixture.status;
};
const WEEKDAY = (date) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
};
const plusDays = (date, days) => {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
};
/** Fim do dia `YYYY-MM-DD` em Brasília (UTC−3, sem horário de verão). */
const endOfDayBrt = (date) => `${plusDays(date, 1)}T02:59:59.999Z`;
const brtDate = (iso) =>
  new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
function businessDaysBetween(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = plusDays(date, 1)) if (WEEKDAY(date)) dates.push(date);
  return dates;
}
function addBusinessDaysBrt(fromIso, days) {
  let date = brtDate(fromIso);
  for (let counted = 0; counted < days;) {
    date = plusDays(date, 1);
    if (WEEKDAY(date)) counted += 1;
  }
  return endOfDayBrt(date);
}

function listProcessItem(fixture) {
  const unit = departments[fixture.unit];
  const ref = (item) => ({ id: item.id, name: item.name });
  return {
    id: listProcessId(fixture.n),
    code: fixture.code,
    number: fixture.code === null ? null : fixture.n,
    year: 2026,
    internalCode: null,
    title: fixture.title,
    status: fixture.status,
    priority: fixture.priority,
    organization: { id: organizations[0].id, shortName: 'PMSJ' },
    requestingSecretariat: ref(departments[0]),
    requestingDepartment: ref(departments[0]),
    currentStage: { key: 'PESQUISA_PRECOS', name: 'Pesquisa de preços' },
    currentDepartment: ref(unit),
    currentResponsible: null,
    deadline: {
      dueAt: fixture.overdue ? '2026-10-01T02:59:59Z' : '2026-10-08T02:59:59Z',
      slaType: 'BUSINESS',
      daysLeft: fixture.overdue ? null : 2,
      overdueDays: fixture.overdue ? 3 : null,
      isDueSoon: !fixture.overdue,
      isOverdue: fixture.overdue,
      isPaused: false,
    },
    contractingType: { id: randomUUID(), code: 'AQUISICAO_BENS', label: 'Aquisição de bens' },
    modality: null,
    origin: { id: randomUUID(), code: 'DEMANDA_NAO_PREVISTA', label: 'Demanda não prevista' },
    isBudgetConfidential: false,
    estimatedValue: '85000.00',
    estimatedValueMasked: false,
    targetDate: '2026-11-30',
    overdueSince: null,
    tags: tagsOfProcess(listProcessId(fixture.n)).map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      isActive: tag.isActive,
    })),
    openedAt: null,
    createdAt: '2026-09-14T13:02:11Z',
    updatedAt: '2026-10-02T18:40:00Z',
  };
}

/** Filtros mínimos da lista: status, "somente atrasados" e unidade atual. */
function listFixtures(params) {
  const statuses = (params.get('status') ?? '').split(',').filter(Boolean);
  const units = (params.get('currentDepartmentId') ?? '').split(',').filter(Boolean);
  const tagIds = (params.get('tagId') ?? '').split(',').filter(Boolean);
  return LIST_FIXTURES.filter(
    (fixture) =>
      (tagIds.length === 0 ||
        tagIds.some((id) => processTagLinks.get(listProcessId(fixture.n))?.has(id))) &&
      (statuses.length === 0 || statuses.includes(fixture.status)) &&
      (params.get('overdue') !== 'true' || fixture.overdue) &&
      (units.length === 0 || units.includes(departments[fixture.unit].id)),
  );
}

const EXPORT_COLUMNS = {
  code: [['Código', (f) => f.code]],
  title: [['Título', (f) => f.title]],
  status: [['Situação', (f) => LIST_STATUS_LABELS[f.status]]],
  stage: [['Etapa', () => 'Pesquisa de preços']],
  currentDepartment: [['Unidade atual', (f) => departments[f.unit].name]],
  currentResponsible: [['Responsável', () => '']],
  deadline: [
    ['Prazo da etapa', (f) => (f.overdue ? '01/10/2026' : '08/10/2026')],
    ['Situação do prazo', (f) => (f.overdue ? 'Atrasado' : 'No prazo')],
  ],
  priority: [['Prioridade', (f) => LIST_PRIORITY_LABELS[f.priority]]],
};

/** Célula do CSV (RN-PROC-43): fórmula neutralizada com apóstrofo e aspas quando preciso. */
function processCsvCell(value) {
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const BOM = String.fromCharCode(0xfeff);

function processesCsv(fixtures, columns) {
  const defs = columns.flatMap((column) => EXPORT_COLUMNS[column] ?? []);
  const lines = [
    defs.map(([header]) => processCsvCell(header)).join(';'),
    ...fixtures.map((fixture) => defs.map(([, cell]) => processCsvCell(cell(fixture))).join(';')),
  ];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

// Visões salvas (US-003 · PRC-35..38): em memória, por dono. A Beatriz compartilhou uma visão cujo
// filtro de unidade referencia uma unidade removida (aviso FA-05 no E2E).
const savedViews = [
  {
    id: '0192a000-0000-7000-8000-00000000b001',
    ownerSub: 'sub-beatriz',
    ownerId: '0192a000-0000-7000-8000-00000000be01',
    ownerName: 'Beatriz Lima',
    scope: 'PROCESS_LIST',
    name: 'Devolvidos da Saúde',
    filters: {
      v: 1,
      status: ['RETURNED'],
      currentDepartmentId: [departments[0].id, REMOVED_UNIT_ID],
    },
    sort: null,
    columns: ['code', 'title', 'status', 'currentDepartment'],
    isShared: true,
    isDefault: false,
    version: 1,
  },
];
const savedViewReplays = new Map();

function savedViewDto(view, sub) {
  const { ownerSub, ownerId, ownerName, ...rest } = view;
  return {
    ...rest,
    owner: { id: ownerId, name: ownerName },
    isOwner: ownerSub === sub,
  };
}

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

// Pesquisa de preços (US-024 · PRS-01/02/03/05 + itens do processo PRC-13 e DOC-01): três processos
// dedicados, fora da lista (SCR-004) — um para criar a pesquisa, um que já a tem (FA-01) e um sem
// itens (FA-02). Os itens seguem o Background da story: 1 "Cimento CP II 50 kg" (100 SC), 2 "Areia
// média" (12 M3) e 3 "Brita 1" sem quantidade de referência. A resolução de quantidade, o snapshot e
// as regras (V-01..V-11, POL-02/09) são cobertas nos testes da API; aqui valem a jornada e as telas.
const PRICE_TYPE_ID = documentTypes.find((type) => type.code === 'PRICE_RESEARCH').id;
const PRICE_UNITS = {
  SC: { id: '0192a000-0000-7000-8000-00000000e501', label: 'SC' },
  M3: { id: '0192a000-0000-7000-8000-00000000e502', label: 'M3' },
};
const PRICE_FIXTURES = [
  { n: 24, code: '0024/2026', title: 'Aquisição de cimento e agregados para vias' },
  { n: 25, code: '0025/2026', title: 'Aquisição de agregados para a obra da escola' },
  { n: 26, code: '0026/2026', title: 'Contratação de serviços de jardinagem' },
  // US-028: pesquisa só da jornada "Importar planilha" (não disputa estado com as outras).
  { n: 29, code: '0029/2026', title: 'Aquisição de material de pintura para as escolas' },
].map((fixture) => ({
  ...fixture,
  status: 'IN_PROGRESS',
  priority: 'MEDIUM',
  overdue: false,
  unit: 0,
}));
const PRICE_ITEM_ROWS = [
  [1, 'Cimento CP II 50 kg', 'SC', '100.0000'],
  [2, 'Areia média', 'M3', '12.0000'],
  [3, 'Brita 1', 'M3', null],
];
const priceParameters = {
  defaultMethod: 'AUTO_CV',
  cvThresholdPercent: '25.0000',
  minQuotations: 3,
  directQuoteMaxAgeDays: 180,
  similarContractMaxAgeDays: 365,
  outlierLowerPercent: '70.0000',
  outlierUpperPercent: '130.0000',
  unitPriceDecimals: 2,
  roundingMode: 'HALF_UP',
};
const priceItemId = (fixture, sequence) =>
  `0192a000-0000-7000-8000-00000e${String(fixture.n).padStart(4, '0')}${String(sequence).padStart(2, '0')}`;

function priceProcessItems(fixture, withItems) {
  if (!withItems) return [];
  return PRICE_ITEM_ROWS.map(([sequence, description, unit, referenceQuantity]) => ({
    id: priceItemId(fixture, sequence),
    processId: listProcessId(fixture.n),
    sequence,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description,
    unitOfMeasure: PRICE_UNITS[unit],
    catalogSystem: null,
    catalogCode: null,
    notes: null,
    referenceQuantity,
    referenceQuantitySourceDocumentId: null,
    referenceUnitPrice: null,
    referenceUnitPriceMasked: false,
    referenceUnitPriceSourceDocumentId: null,
    references: [],
    version: 1,
  }));
}

/** processId → { fixture, items (do processo), research (ou null), replays }. */
const priceStates = new Map(
  PRICE_FIXTURES.map((fixture) => [
    listProcessId(fixture.n),
    {
      fixture,
      items: priceProcessItems(fixture, fixture.n !== 26),
      research: null,
      replays: new Map(),
    },
  ]),
);

function buildPriceResearch(state, { id, code, title, referenceDate, quantities }) {
  const rows = state.items
    .filter((item) => quantities.has(item.id))
    .map((item, index) => ({
      id: mockUuid(),
      priceResearchId: id,
      processItemId: item.id,
      sequence: item.sequence,
      lotNumber: item.lotNumber,
      lotName: item.lotName,
      description: item.description,
      unit: { ...item.unitOfMeasure, allowsDecimal: true },
      quantity: quantities.get(item.id),
      methodOverride: null,
      effectiveMethod: null,
      validQuotationsCount: 0,
      quotationsCount: 0,
      meanPrice: null,
      medianPrice: null,
      lowestPrice: null,
      highestPrice: null,
      stdDeviation: null,
      coefficientOfVariation: null,
      manualUnitPrice: null,
      manualJustification: null,
      recommendedUnitPrice: null,
      recommendedUnitPriceMasked: false,
      totalPrice: null,
      valuesMasked: false,
      belowMinimumJustification: null,
      alerts: [{ code: 'NO_VALID_QUOTES' }, { code: 'BELOW_MINIMUM_QUOTES' }],
      calculatedAt: null,
      sortOrder: index + 1,
      version: 1,
    }));
  const now = new Date().toISOString();
  return {
    header: {
      id,
      documentId: id,
      processId: listProcessId(state.fixture.n),
      code,
      title,
      status: 'DRAFT',
      confidentiality: 'INTERNAL',
      templateVersionId: null,
      documentVersion: 1,
      draftRevision: 1,
      referenceDate,
      parameters: priceParameters,
      itemsCount: rows.length,
      itemsWithAlertsCount: rows.length,
      totalEstimatedValue: null,
      totalEstimatedValueMasked: false,
      lastCalculatedAt: null,
      completedAt: null,
      pendingApprovalId: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    items: rows,
  };
}

const priceMeta = () => ({
  allowedActions: ['UPDATE', 'ADD_ITEMS', 'REMOVE_ITEMS', 'EXCLUDE_QUOTATION'],
  documentActions: [],
  lockReason: null,
  template: null,
});

// A pesquisa já existente do processo 0025/2026 (FA-01): os 3 itens, com as quantidades de referência.
{
  const state = priceStates.get(listProcessId(25));
  state.research = buildPriceResearch(state, {
    id: '0192a000-0000-7000-8000-0000000e0025',
    code: 'PP 0004/2026',
    title: 'Pesquisa de preços — 0025/2026',
    referenceDate: '2026-10-06',
    quantities: new Map(
      state.items.map((item) => [item.id, (item.referenceQuantity ?? '6.0000').toString()]),
    ),
  });
}

// A pesquisa do processo 0029/2026 (US-028), com a fonte "Painel de Preços" já cadastrada: a
// importação por planilha não cria fontes.
{
  const state = priceStates.get(listProcessId(29));
  state.research = buildPriceResearch(state, {
    id: '0192a000-0000-7000-8000-0000000e0029',
    code: 'PP 0005/2026',
    title: 'Pesquisa de preços — 0029/2026',
    referenceDate: '2026-10-06',
    quantities: new Map(state.items.map((item) => [item.id, '10.0000'])),
  });
  state.research.sources = [
    {
      id: '0192a000-0000-7000-8000-0000000e0291',
      priceResearchId: state.research.header.id,
      sourceTypeId: '0192a000-0000-7000-8000-00000000c300',
      description: 'Painel de Preços',
      supplierId: null,
      quoteDate: null,
      accessedAt: '2026-09-12T14:32:00.000Z',
      url: 'https://paineldeprecos.planejamento.gov.br',
      referenceOrganization: null,
      referenceDocument: null,
      supplierChoiceJustification: null,
      notes: null,
      sortOrder: 0,
      createdAt: '2026-10-06T15:00:00.000Z',
      updatedAt: '2026-10-06T15:00:00.000Z',
      version: 1,
    },
  ];
  state.research.quotations = [];
}

// ETP (US-019 · ETP-01/02 + DOC-01/DOC-03): dois processos dedicados, fora da lista (SCR-004) —
// 0027/2026 com o DFD 0005/2026 finalizado (o cartão "Importar dados do DFD") e 0028/2026 que já tem
// o ETP 0002/2026 (FA-03). A importação (seções, itens, PCA), a atomicidade, POL-02 e o isolamento
// por tenant são cobertos nos testes da API; aqui valem a jornada e as telas.
const ETP_TYPE_ID = documentTypes.find((type) => type.code === 'ETP').id;
const ETP_FIXTURES = [
  { n: 27, code: '0027/2026', title: 'Manutenção predial preventiva das escolas' },
  { n: 28, code: '0028/2026', title: 'Reforma da quadra poliesportiva' },
].map((fixture) => ({
  ...fixture,
  status: 'IN_PROGRESS',
  priority: 'MEDIUM',
  overdue: false,
  unit: 0,
}));

function buildEtp(fixture, { id, code, imported }) {
  const now = new Date().toISOString();
  const processId = listProcessId(fixture.n);
  return {
    summary: { id, documentId: id, code, status: 'DRAFT', conclusion: 'PENDING', version: 1 },
    dto: {
      id,
      documentId: id,
      processId,
      code,
      title: `Estudo Técnico Preliminar — ${fixture.code}`,
      status: 'DRAFT',
      conclusion: 'PENDING',
      importedFromDfdVersionId: imported ? '0192a000-0000-7000-8000-0000000e1906' : null,
      responsibleId: '0192a000-0000-7000-8000-00000000a0a1',
      templateVersionId: null,
      documentVersion: 1,
      itemsCount: imported ? 2 : 0,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    document: {
      ...versionedDocument,
      id,
      processId,
      documentType: {
        id: ETP_TYPE_ID,
        code: 'ETP',
        name: 'Estudo Técnico Preliminar',
        kind: 'STRUCTURED',
        systemModule: 'ETP',
        requiresApproval: false,
      },
      number: Number(code.slice(4, 8)),
      code,
      title: `Estudo Técnico Preliminar — ${fixture.code}`,
      confidentiality: 'INTERNAL',
      draftRevision: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
  };
}

/** processId → { fixture, importableDfd, etp (ou null), replays }. */
const etpStates = new Map(
  ETP_FIXTURES.map((fixture) => [
    listProcessId(fixture.n),
    {
      fixture,
      importableDfd:
        fixture.n === 27
          ? {
              documentId: '0192a000-0000-7000-8000-0000000e1905',
              code: 'DFD 0005/2026',
              status: 'FINALIZED',
              versionId: '0192a000-0000-7000-8000-0000000e1906',
              versionNumber: 1,
              objectSummary: 'Manutenção predial preventiva das escolas municipais',
              itemsCount: 2,
              pcaStatus: 'PLANNED',
            }
          : null,
      etp: null,
      replays: new Map(),
    },
  ]),
);
etpStates.get(listProcessId(28)).etp = buildEtp(ETP_FIXTURES[1], {
  id: '0192a000-0000-7000-8000-0000000e1928',
  code: 'ETP 0002/2026',
  imported: false,
});
const etpOf = (etpId) => [...etpStates.values()].find((state) => state.etp?.dto.id === etpId)?.etp;

// Termo de Referência (US-036 · TRM-01..04 + DOC-03/05): dois processos dedicados, fora da lista
// (SCR-004) — 0033/2026 sem TR (criar pelo painel, redigir seções, "não se aplica" em DELIVERY,
// completude), 0034/2026 que já tem o TR 0002/2026 (FA-02) e 0035/2026 só para o diálogo em 360 px. A numeração, a atomicidade, POL-02/09,
// a vinculação automática da pesquisa e o isolamento por tenant são cobertos nos testes da API.
const TERM_TYPE_ID = documentTypes.find((type) => type.code === 'TR').id;
const TERM_TEMPLATE = {
  id: '0192a000-0000-7000-8000-0000000e2901',
  name: 'TR — Modelo padrão',
  versionId: '0192a000-0000-7000-8000-0000000e2902',
};
const TERM_RESEARCH = {
  id: '0192a000-0000-7000-8000-0000000e2903',
  code: 'PP 0002/2026',
  status: 'FINALIZED',
  totalEstimatedValue: '98000.00',
  completed: true,
};
const TERM_SECTIONS = [
  ['OBJECT', 'Definição do objeto', 'REQUIRED', 'TEXT', 'Lei 14.133/2021, art. 6º, XXIII, a'],
  ['JUSTIFICATION', 'Fundamentação da contratação', 'REQUIRED', 'TEXT', 'Art. 6º, XXIII, b'],
  [
    'DELIVERY',
    'Local e condições de entrega ou de execução',
    'REQUIRED_OR_JUSTIFY',
    'TEXT',
    'Art. 6º, XXIII, e',
  ],
  ['PAYMENT', 'Critérios de medição e de pagamento', 'REQUIRED', 'TEXT', 'Art. 92, V e VI'],
  [
    'ESTIMATED_VALUE',
    'Estimativa do valor da contratação',
    'REQUIRED',
    'ESTIMATED_VALUE',
    'Art. 6º, XXIII, i',
  ],
].map(([key, title, requirement, render, legalBasis], index) => ({
  key,
  title,
  order: index + 1,
  requirement,
  helpText: `Oriente-se pela base legal para redigir a seção "${title}".`,
  legalBasis,
  minChars: null,
  maxChars: 50000,
  render,
  allowNarrative: true,
}));
const TERM_AUTHOR_ID = '0192a000-0000-7000-8000-00000000a0a1';
const TERM_FIXTURES = [
  { n: 33, code: '0033/2026', title: 'Contratação de manutenção predial das escolas' },
  { n: 34, code: '0034/2026', title: 'Aquisição de mobiliário para a biblioteca' },
  // Só o diálogo em 360 px (as jornadas acima mudam o estado do servidor simulado compartilhado).
  { n: 35, code: '0035/2026', title: 'Contratação de vigilância patrimonial' },
].map((fixture) => ({
  ...fixture,
  status: 'IN_PROGRESS',
  priority: 'MEDIUM',
  overdue: false,
  unit: 0,
}));

function buildTerm(fixture, { id, code, title }) {
  const now = new Date().toISOString();
  const processId = listProcessId(fixture.n);
  return {
    id,
    processId,
    code,
    title,
    status: 'DRAFT',
    version: 1,
    objectDefinition: fixture.title,
    estimatedTotalValue: TERM_RESEARCH.totalEstimatedValue,
    estimatedValueSource: 'PRICE_RESEARCH',
    priceResearchId: TERM_RESEARCH.id,
    createdAt: now,
    updatedAt: now,
    sections: Object.fromEntries(
      TERM_SECTIONS.map(({ key }) => [
        key,
        {
          state: 'EMPTY',
          content: null,
          justification: null,
          revision: 1,
          updatedAt: now,
          updatedById: TERM_AUTHOR_ID,
        },
      ]),
    ),
    document: {
      ...versionedDocument,
      id,
      processId,
      documentType: {
        id: TERM_TYPE_ID,
        code: 'TR',
        name: 'Termo de Referência',
        kind: 'STRUCTURED',
        systemModule: 'TERM_OF_REFERENCE',
        requiresApproval: false,
      },
      number: Number(code.slice(3, 7)),
      code,
      title,
      confidentiality: 'INTERNAL',
      draftRevision: 1,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
  };
}

/** processId → { fixture, term (ou null), replays }. */
const termStates = new Map(
  TERM_FIXTURES.map((fixture) => [
    listProcessId(fixture.n),
    { fixture, term: null, replays: new Map() },
  ]),
);
termStates.get(listProcessId(34)).term = buildTerm(TERM_FIXTURES[1], {
  id: '0192a000-0000-7000-8000-0000000e2934',
  code: 'TR 0002/2026',
  title: 'Termo de Referência — 0034/2026',
});
const termOf = (termId) =>
  [...termStates.values()].find((state) => state.term?.id === termId)?.term;

// Documento livre (US-063 · DOC-01/02/03/05): o processo 0036/2026, fora da lista (SCR-004), com o
// Ofício no menu "Criar documento"; o DOC-02 cria o ofício do modelo padrão (duas seções, uma que
// admite "não se aplica") e a SCR-105 o redige com o autosave. A numeração, a atomicidade, POL-02,
// o template publicado e o isolamento por tenant são cobertos nos testes da API.
const FREE_TEXT_TYPE = documentTypes.find((type) => type.code === 'OFICIO');
const FREE_TEXT_TEMPLATE = {
  versionId: '0192a000-0000-7000-8000-0000000e3601',
  versionNumber: 1,
  sections: [
    {
      key: 'CONTENT',
      title: 'Conteúdo do ofício',
      order: 1,
      requirement: 'REQUIRED',
      helpText: 'Identifique o destinatário, o assunto e o pedido ou a informação.',
      legalBasis: 'Lei 14.133/2021, art. 12',
      minChars: null,
      maxChars: 50000,
    },
    {
      key: 'ATTACHMENTS_NOTE',
      title: 'Anexos referidos',
      order: 2,
      requirement: 'REQUIRED_OR_JUSTIFY',
      helpText: 'Liste os documentos que acompanham o ofício.',
      legalBasis: null,
      minChars: null,
      maxChars: 2000,
    },
  ],
};
const FREE_TEXT_FIXTURES = [
  { n: 36, code: '0036/2026', title: 'Manutenção das praças do centro' },
].map((fixture) => ({
  ...fixture,
  status: 'IN_PROGRESS',
  priority: 'MEDIUM',
  overdue: false,
  unit: 0,
}));
/** processId → { fixture, documents, replays }. */
const freeTextStates = new Map(
  FREE_TEXT_FIXTURES.map((fixture) => [
    listProcessId(fixture.n),
    { fixture, documents: [], replays: new Map() },
  ]),
);
let freeTextSequence = 0;

// US-070: presença de edição por documento (DOC-24/25) — `sub` → seção, desde e último heartbeat.
const PRESENCE_TTL_MS = 60_000;
const presenceStates = new Map();
const PRESENCE_USERS = {
  'sub-ana': { id: '0192a000-0000-7000-8000-0000000000a1', name: 'Ana Souza' },
  'sub-lucia': { id: '0192a000-0000-7000-8000-0000000000a6', name: 'Lúcia Matos' },
};
const freeTextDocumentOf = (documentId) =>
  [...freeTextStates.values()]
    .flatMap((state) => state.documents)
    .find((document) => document.id === documentId);

function buildFreeTextDocument(state, title, responsibleId) {
  const now = new Date().toISOString();
  freeTextSequence += 1;
  const number = freeTextSequence;
  const paragraph = (text) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const section = (extra) => ({
    state: 'EMPTY',
    content: null,
    justification: null,
    revision: 1,
    updatedAt: now,
    updatedById: TERM_AUTHOR_ID,
    ...extra,
  });
  return {
    ...versionedDocument,
    id: mockUuid(),
    processId: listProcessId(state.fixture.n),
    documentType: {
      id: FREE_TEXT_TYPE.id,
      code: 'OFICIO',
      name: 'Ofício',
      kind: 'FREE_TEXT',
      systemModule: null,
      requiresApproval: false,
    },
    templateVersionId: FREE_TEXT_TEMPLATE.versionId,
    number,
    year: 2026,
    code: `OF ${String(number).padStart(4, '0')}/2026`,
    title,
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: {
      sections: {
        CONTENT: section({
          state: 'FILLED',
          content: paragraph(
            `Processo ${state.fixture.code} — encaminhamos para as providências cabíveis.`,
          ),
        }),
        ATTACHMENTS_NOTE: section({}),
      },
    },
    draftRevision: 1,
    currentVersionId: null,
    currentVersionNumber: null,
    responsibleId: responsibleId ?? TERM_AUTHOR_ID,
    createdById: TERM_AUTHOR_ID,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

function termSummaryOf(term) {
  return {
    id: term.id,
    documentId: term.id,
    code: term.code,
    status: term.status,
    title: term.title,
    version: term.version,
  };
}

function termDtoOf(term) {
  return {
    id: term.id,
    documentId: term.id,
    processId: term.processId,
    code: term.code,
    title: term.title,
    status: term.status,
    inApproval: false,
    templateVersion: { id: TERM_TEMPLATE.versionId, versionNumber: 1 },
    responsibleId: TERM_AUTHOR_ID,
    objectDefinition: term.objectDefinition,
    contractDurationMonths: null,
    executionDeadline: null,
    executionDeadlineType: null,
    deliveryLocation: null,
    paymentTermDays: null,
    productWarrantyMonths: null,
    contractGuaranteePercent: null,
    allowsSubcontracting: null,
    selectionCriterionId: null,
    awardType: null,
    estimatedTotalValue: term.estimatedTotalValue,
    estimatedTotalValueMasked: false,
    estimatedValueSource: term.estimatedValueSource,
    priceResearchId: term.priceResearchId,
    importedFromEtpId: null,
    importedFromEtpVersionId: null,
    importedAt: null,
    importedById: null,
    documentVersion: 1,
    createdAt: term.createdAt,
    updatedAt: term.updatedAt,
    version: term.version,
  };
}

/** RN-TR-13: `REQUIRED` preenchida; `REQUIRED_OR_JUSTIFY` preenchida ou "não se aplica". */
function termCompletenessOf(term) {
  const sections = TERM_SECTIONS.filter((section) => section.requirement !== 'OPTIONAL').map(
    (section) => {
      const state = term.sections[section.key].state;
      return {
        key: section.key,
        complete:
          state === 'FILLED' || (state === 'NOT_APPLICABLE' && section.requirement !== 'REQUIRED'),
      };
    },
  );
  const satisfied = sections.filter((section) => section.complete).length;
  return {
    required: sections.length,
    satisfied,
    percent: Math.floor((satisfied * 100) / sections.length),
    sections,
  };
}

function termDetailOf(term) {
  return {
    ...termDtoOf(term),
    draftRevision: 1,
    draftContent: { sections: term.sections },
    completeness: termCompletenessOf(term),
    priceResearch: term.priceResearchId === null ? null : TERM_RESEARCH,
    completedPriceResearch: TERM_RESEARCH,
    etpChangedSinceImport: false,
  };
}

const priceResearchOf = (researchId) =>
  [...priceStates.values()].find((state) => state.research?.header.id === researchId)?.research;

const sourceOwnerOf = (sourceId) =>
  [...priceStates.values()]
    .map((state) => state.research)
    .find((research) => research?.sources?.some((source) => source.id === sourceId));

function sourceDto(research, source) {
  const type = catalogItems.find((item) => item.id === source.sourceTypeId);
  return {
    ...source,
    sourceType: {
      id: source.sourceTypeId,
      code: type?.code ?? '',
      label: type?.label ?? '',
      isActive: true,
      requiredFields: type?.metadata.requiredFields ?? [],
      maxAgeDays: null,
    },
    supplier: null,
    quotations: research.quotations.filter((quotation) => quotation.priceSourceId === source.id),
  };
}

const unitPriceOf = (value) => {
  const [integer, fraction = ''] = String(value).split('.');
  return `${integer}.${fraction.padEnd(4, '0')}`;
};

/** Corpo bruto (bytes) — o upload multipart da planilha (PRS-18). */
function readRawBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Importação por planilha (US-028 · PRS-18/19/24): o modelo é um arquivo qualquer; a prévia não lê
 * o XLSX — um arquivo cujo nome contém "erro" traz um preço inválido no item 1 da primeira fonte, os
 * demais preenchem todas as células (10,00 + linha). Leitura da planilha, token de 15 minutos,
 * atomicidade e as 8 categorias são cobertos nos testes da API.
 */
async function handleQuotationImport(request, response, url, correlationId) {
  const match =
    /^\/api\/v1\/price-research\/([0-9a-f-]{36})\/(import-template|import-preview|import)$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const research = priceResearchOf(match[1]);
  if (!research) {
    problem(response, 404, 'NOT_FOUND', String(correlationId));
    return true;
  }
  research.sources ??= [];
  research.quotations ??= [];
  research.importPreviews ??= new Map();
  if (match[2] === 'import-template' && request.method === 'GET') {
    response.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="cotacoes-${research.header.code.replaceAll(/[^0-9A-Za-z]+/g, '-').toLowerCase()}.xlsx"`,
    });
    response.end(Buffer.from('PK'));
    return true;
  }
  if (match[2] === 'import-preview' && request.method === 'POST') {
    const raw = (await readRawBody(request)).toString('latin1');
    const fileName = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'planilha.xlsx';
    const withError = fileName.includes('erro');
    const cells = [];
    const rows = research.items.map((item, index) => {
      const issues = [];
      let valid = 0;
      research.sources.forEach((source, column) => {
        if (withError && index === 0 && column === 0) {
          issues.push({
            severity: 'ERROR',
            code: 'INVALID_DECIMAL',
            row: index + 2,
            column: String.fromCharCode(68 + column),
            header: source.description,
            priceSourceId: source.id,
            message: `Linha ${String(index + 2)}, fonte '${source.description}': preço inválido.`,
          });
          return;
        }
        valid += 1;
        cells.push({
          priceItemId: item.id,
          priceSourceId: source.id,
          unitPrice: `${String(10 + index)}.00`,
        });
      });
      return {
        row: index + 2,
        sequence: item.sequence,
        priceItemId: issues.length > 0 ? null : item.id,
        valid,
        errors: issues.length,
        empty: 0,
        warnings: 0,
        issues,
      };
    });
    const token = mockUuid();
    research.importPreviews.set(token, cells);
    const errors = rows.reduce((total, row) => total + row.errors, 0);
    send(response, 200, {
      data: {
        previewToken: token,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        fileName,
        columns: research.sources.map((source, column) => ({
          column: String.fromCharCode(68 + column),
          header: source.description,
          priceSourceId: source.id,
        })),
        rows,
        columnIssues: [],
        summary: {
          total: rows.length * research.sources.length,
          valid: cells.length,
          errors,
          empty: 0,
          warnings: 0,
          rows: rows.length,
        },
      },
    });
    return true;
  }
  if (match[2] === 'import' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const cells = research.importPreviews.get(body.previewToken);
    if (!cells) {
      problem(response, 410, 'IMPORT_PREVIEW_EXPIRED', String(correlationId));
      return true;
    }
    research.importPreviews.delete(body.previewToken);
    const now = new Date().toISOString();
    for (const cell of cells) {
      const current = research.quotations.find(
        (quotation) =>
          quotation.priceSourceId === cell.priceSourceId &&
          quotation.priceItemId === cell.priceItemId,
      );
      if (current) {
        Object.assign(current, {
          unitPrice: unitPriceOf(cell.unitPrice),
          updatedAt: now,
          version: current.version + 1,
        });
        continue;
      }
      research.quotations.push({
        id: mockUuid(),
        priceResearchId: research.header.id,
        priceItemId: cell.priceItemId,
        priceSourceId: cell.priceSourceId,
        unitPrice: unitPriceOf(cell.unitPrice),
        unitPriceMasked: false,
        brandModel: null,
        status: 'VALID',
        exclusionReason: null,
        exclusionJustification: null,
        outlierFlag: 'NONE',
        isExpired: false,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }
    for (const source of research.sources) source.version += 1;
    send(response, 200, { data: { appliedCount: cells.length, skippedCount: 0 } });
    return true;
  }
  return false;
}

/** PRS-09..15 sobre a pesquisa simulada; `true` quando respondeu. */
async function handlePriceSources(request, response, url, correlationId) {
  if (await handleQuotationImport(request, response, url, correlationId)) return true;
  const list = /^\/api\/v1\/price-research\/([0-9a-f-]{36})\/sources$/.exec(url.pathname);
  if (list) {
    const research = priceResearchOf(list[1]);
    if (!research) {
      problem(response, 404, 'NOT_FOUND', String(correlationId));
      return true;
    }
    research.sources ??= [];
    research.quotations ??= [];
    if (request.method === 'GET') {
      const data = research.sources.map((source) => sourceDto(research, source));
      send(response, 200, {
        data,
        meta: { page: 1, pageSize: 100, totalItems: data.length, totalPages: 1 },
      });
      return true;
    }
    if (request.method === 'POST') {
      const body = JSON.parse((await readBody(request)) || '{}');
      const now = new Date().toISOString();
      const source = {
        id: mockUuid(),
        priceResearchId: research.header.id,
        sourceTypeId: body.sourceTypeId,
        description: body.description,
        supplierId: body.supplierId ?? null,
        quoteDate: body.quoteDate ?? null,
        accessedAt: body.accessedAt ?? null,
        url: body.url ?? null,
        referenceOrganization: body.referenceOrganization ?? null,
        referenceDocument: body.referenceDocument ?? null,
        supplierChoiceJustification: body.supplierChoiceJustification ?? null,
        notes: body.notes ?? null,
        sortOrder: research.sources.length,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      research.sources.push(source);
      send(response, 201, { data: sourceDto(research, source) }, { ETag: '"1"' });
      return true;
    }
  }
  // Desconsiderar e restaurar cotação (US-027 · PRS-16/17): estado, motivo e versões; o recálculo, a
  // POL-02/POL-09 e as 8 categorias são cobertos nos testes da API.
  const transition = /^\/api\/v1\/quotations\/([0-9a-f-]{36})\/(exclude|restore)$/.exec(
    url.pathname,
  );
  if (transition && request.method === 'POST') {
    const owner = [...priceStates.values()]
      .map((state) => state.research)
      .find((candidate) =>
        candidate?.quotations?.some((quotation) => quotation.id === transition[1]),
      );
    const quotation = owner?.quotations.find((candidate) => candidate.id === transition[1]);
    if (!owner || !quotation) {
      problem(response, 404, 'NOT_FOUND', String(correlationId));
      return true;
    }
    const expected = Number(String(request.headers['if-match'] ?? '').replaceAll('"', ''));
    if (expected !== quotation.version) {
      problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      return true;
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (transition[2] === 'exclude') {
      if (quotation.status === 'EXCLUDED') {
        problem(response, 409, 'INVALID_STATE', String(correlationId));
        return true;
      }
      Object.assign(quotation, {
        status: 'EXCLUDED',
        exclusionReason: body.exclusionReason,
        exclusionJustification: body.exclusionJustification,
      });
    } else {
      if (quotation.status === 'VALID') {
        problem(response, 409, 'INVALID_STATE', String(correlationId));
        return true;
      }
      Object.assign(quotation, {
        status: 'VALID',
        exclusionReason: null,
        exclusionJustification: null,
      });
    }
    quotation.version += 1;
    quotation.updatedAt = new Date().toISOString();
    const source = owner.sources.find((candidate) => candidate.id === quotation.priceSourceId);
    if (source) source.version += 1;
    send(response, 200, { data: quotation }, { ETag: `"${String(quotation.version)}"` });
    return true;
  }
  const one = /^\/api\/v1\/price-sources\/([0-9a-f-]{36})(\/quotations)?$/.exec(url.pathname);
  if (!one) return false;
  const research = sourceOwnerOf(one[1]);
  const source = research?.sources.find((candidate) => candidate.id === one[1]);
  if (!research || !source) {
    problem(response, 404, 'NOT_FOUND', String(correlationId));
    return true;
  }
  const ifMatch = Number(String(request.headers['if-match'] ?? '').replaceAll('"', ''));
  if (ifMatch !== source.version) {
    problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    return true;
  }
  const now = new Date().toISOString();
  if (one[2] && request.method === 'PUT') {
    const body = JSON.parse((await readBody(request)) || '{}');
    for (const line of body.items ?? []) {
      if (!line.unitPrice) continue;
      const current = research.quotations.find(
        (quotation) =>
          quotation.priceSourceId === source.id && quotation.priceItemId === line.priceItemId,
      );
      if (current) {
        Object.assign(current, {
          unitPrice: unitPriceOf(line.unitPrice),
          brandModel: line.brandModel ?? null,
          updatedAt: now,
          version: current.version + 1,
        });
        continue;
      }
      research.quotations.push({
        id: mockUuid(),
        priceResearchId: research.header.id,
        priceItemId: line.priceItemId,
        priceSourceId: source.id,
        unitPrice: unitPriceOf(line.unitPrice),
        unitPriceMasked: false,
        brandModel: line.brandModel ?? null,
        status: 'VALID',
        exclusionReason: null,
        exclusionJustification: null,
        outlierFlag: 'NONE',
        isExpired: false,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }
    source.version += 1;
    send(
      response,
      200,
      { data: research.quotations.filter((quotation) => quotation.priceSourceId === source.id) },
      { ETag: `"${String(source.version)}"` },
    );
    return true;
  }
  if (!one[2] && request.method === 'PATCH') {
    const body = JSON.parse((await readBody(request)) || '{}');
    Object.assign(source, body, { version: source.version + 1, updatedAt: now });
    send(
      response,
      200,
      { data: sourceDto(research, source) },
      { ETag: `"${String(source.version)}"` },
    );
    return true;
  }
  if (!one[2] && request.method === 'DELETE') {
    research.sources.splice(research.sources.indexOf(source), 1);
    research.quotations = research.quotations.filter(
      (quotation) => quotation.priceSourceId !== source.id,
    );
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
}

// Caixa de tarefas (US-056 · TSK-01/TSK-02): dois processos com a Ana, um na fila da unidade
// (0012/2026, que o "Assumir" — PRC-21 — move para "Comigo") e uma aprovação pendente.
/** APV-01 (US-057): aprovações da cobertura da Ana (SCR-014). */
const APPROVAL_LIST = [
  [
    '0192e057-0000-7000-8000-000000000001',
    '0007/2026',
    'Reforma da praça central',
    'PENDING',
    '2026-10-12T12:00:00.000Z',
    '2026-10-15T02:59:59.000Z',
    true,
  ],
  [
    '0192e057-0000-7000-8000-000000000002',
    '0003/2026',
    'Aquisição de cadeiras',
    'PENDING',
    '2026-10-14T12:00:00.000Z',
    null,
    false,
  ],
  [
    '0192e057-0000-7000-8000-000000000003',
    '0005/2026',
    'Pavimentação da avenida',
    'APPROVED',
    '2026-10-01T12:00:00.000Z',
    null,
    false,
  ],
].map(([id, code, title, status, requestedAt, dueAt, isOverdue], index) => ({
  id,
  subjectType: 'PROCESS_STAGE',
  title: 'Aprovação do DFD',
  status,
  process: { id: `0192e057-0000-7000-8000-00000000100${String(index + 1)}`, code, title },
  document: null,
  requestingDepartment: { id: '0192e057-0000-7000-8000-0000000000a1', name: 'Secretaria de Obras' },
  requestedBy: { id: '0192e057-0000-7000-8000-0000000000b1', name: 'Bruno Lima' },
  requestedAt,
  dueAt,
  isOverdue,
  approver: { type: 'DEPARTMENT_HEAD', label: 'Ana Souza (titular da Secretaria de Obras)' },
  isBudgetConfidential: false,
}));

const INBOX_QUEUE_PROCESS_ID = '0192a000-0000-7000-8000-000000560012';
const inboxState = { claimed: false };

function inboxItem(n, overrides = {}) {
  const id = `0192a000-0000-7000-8000-0000005600${String(n).padStart(2, '0')}`;
  return {
    id,
    processId: id,
    code: `${String(n).padStart(4, '0')}/2026`,
    title: `Aquisição para a caixa de tarefas ${String(n)}`,
    status: 'IN_PROGRESS',
    version: 3,
    currentStage: { key: 'ESTUDOS_PRELIMINARES', name: 'Estudos preliminares' },
    currentDepartment: { id: '0192a000-0000-7000-8000-0000000000d1', name: 'Gabinete' },
    currentResponsible: { id: '0192a000-0000-7000-8000-0000000000a1', name: 'Ana Souza' },
    enteredAt: '2026-10-01T12:00:00.000Z',
    dueAt: '2026-10-30T02:59:59.000Z',
    isOverdue: false,
    overdueSince: null,
    deadline: {
      dueAt: '2026-10-30T02:59:59.000Z',
      slaType: 'BUSINESS',
      daysLeft: 8,
      overdueDays: null,
      isDueSoon: false,
      isOverdue: false,
      isPaused: false,
    },
    isBudgetConfidential: false,
    canClaim: false,
    ...overrides,
  };
}

function inboxViews() {
  const queued = inboxItem(12, { currentResponsible: null, canClaim: true });
  const mine = [inboxItem(1), inboxItem(2)];
  const claimed = {
    ...queued,
    currentResponsible: inboxItem(1).currentResponsible,
    canClaim: false,
  };
  return {
    MINE: inboxState.claimed ? [...mine, claimed] : mine,
    UNIT_QUEUE: inboxState.claimed ? [] : [queued],
    PENDING_APPROVALS: [
      inboxItem(3, {
        id: '0192a000-0000-7000-8000-000000562003',
        approval: {
          id: '0192a000-0000-7000-8000-000000562003',
          title: 'Aprovação do DFD',
          subjectType: 'PROCESS_STAGE',
          requestedBy: { id: '0192a000-0000-7000-8000-0000000000b1', name: 'Bruno Lima' },
          requestedAt: '2026-10-12T12:00:00.000Z',
          dueAt: null,
        },
      }),
    ],
    RETURNED: [],
    OVERDUE: [],
    FOLLOWING: [],
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
            { code: 'PROCESS_EXPORT', scopes: [] },
            { code: 'SUPPLIER_VIEW', scopes: [] },
            { code: 'SUPPLIER_MANAGE', scopes: [] },
            { code: 'PROCESS_UPDATE', scopes: [] },
            { code: 'TAG_MANAGE', scopes: [] },
            { code: 'INBOX_VIEW', scopes: [] },
            { code: 'PROCESS_CLAIM', scopes: [] },
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
  if (url.pathname === '/api/v1/users/lookup' && request.method === 'GET') {
    // USR-02: com `departmentId`, os lotados da unidade (US-050); senão a busca por nome.
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const found = ASSIGN_MEMBERS.filter((item) => !q || item.name.toLowerCase().includes(q));
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
  // SCR-004 (US-002/US-003): a lista da tela traz sempre `status`, `sort`, `page` ou
  // `includeStageOptions`; a busca por código/título das regras (`q` + `pageSize`) continua abaixo.
  if (
    url.pathname === '/api/v1/processes' &&
    request.method === 'GET' &&
    ['includeStageOptions', 'status', 'overdue', 'sort', 'currentDepartmentId', 'page'].some(
      (key) => url.searchParams.has(key),
    )
  ) {
    const found = listFixtures(url.searchParams);
    return send(response, 200, {
      data: found.map(listProcessItem),
      meta: {
        page: 1,
        pageSize: 20,
        totalItems: found.length,
        totalPages: 1,
        ...(url.searchParams.get('includeStageOptions') === 'true'
          ? { stageOptions: [{ key: 'PESQUISA_PRECOS', name: 'Pesquisa de preços' }] }
          : {}),
      },
    });
  }
  if (url.pathname === '/api/v1/processes/export' && request.method === 'GET') {
    // PRC-34 (US-003): CSV com BOM, separador `;` e CRLF; só as colunas pedidas, na ordem pedida.
    const columns = (url.searchParams.get('columns') ?? 'code,title').split(',');
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="processos-20261005-1432.csv"',
    });
    return response.end(processesCsv(listFixtures(url.searchParams), columns));
  }
  if (url.pathname === '/api/v1/saved-views' && request.method === 'GET') {
    // PRC-35: as minhas e as compartilhadas por outros.
    const visible = savedViews.filter(
      (view) =>
        view.scope === (url.searchParams.get('scope') ?? 'PROCESS_LIST') &&
        (view.ownerSub === sub || view.isShared),
    );
    return send(response, 200, { data: visible.map((view) => savedViewDto(view, sub)) });
  }
  if (url.pathname === '/api/v1/saved-views' && request.method === 'POST') {
    // PRC-36: idempotente por chave, nome único por dono sem diferenciar maiúsculas (409).
    const raw = await readBody(request);
    const body = JSON.parse(raw || '{}');
    const key = String(request.headers['idempotency-key'] ?? '');
    const replay = key ? savedViewReplays.get(`${sub}:${key}`) : undefined;
    if (replay) {
      return send(response, 201, { data: replay }, { 'Idempotent-Replayed': 'true', ETag: '"1"' });
    }
    const name = String(body.name ?? '').trim();
    if (name.length < 1 || name.length > 80) {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
        errors: [
          { field: 'name', code: 'TOO_LONG', message: 'Informe um nome de até 80 caracteres.' },
        ],
      });
    }
    const mine = savedViews.filter((view) => view.ownerSub === sub);
    if (mine.some((view) => view.name.toLowerCase() === name.toLowerCase())) {
      return problem(response, 409, 'CONFLICT', String(correlationId));
    }
    if (body.isDefault === true) {
      for (const view of mine) view.isDefault = false;
    }
    const created = {
      id: mockUuid(),
      ownerSub: sub,
      ownerId: sub === 'sub-ana' ? '0192a000-0000-7000-8000-00000000a0a1' : mockUuid(),
      ownerName: sub === 'sub-ana' ? 'Ana Souza' : 'Usuário',
      scope: body.scope ?? 'PROCESS_LIST',
      name,
      filters: body.filters ?? { v: 1 },
      sort: body.sort ?? null,
      columns: body.columns ?? ['code', 'title'],
      isShared: body.isShared === true,
      isDefault: body.isDefault === true,
      version: 1,
    };
    savedViews.push(created);
    const dto = savedViewDto(created, sub);
    if (key) savedViewReplays.set(`${sub}:${key}`, dto);
    return send(response, 201, { data: dto }, { ETag: '"1"' });
  }
  const savedViewRoute = /^\/api\/v1\/saved-views\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (savedViewRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
    // PRC-37/38: só o dono altera (compartilhada de outro = 403; privada de outro = 404) e a
    // versão vai em `If-Match` (412).
    const found = savedViews.find((view) => view.id === savedViewRoute[1]);
    if (!found || (found.ownerSub !== sub && !found.isShared)) {
      return problem(response, 404, 'NOT_FOUND', String(correlationId));
    }
    if (found.ownerSub !== sub) {
      return problem(response, 403, 'PERMISSION_DENIED', String(correlationId));
    }
    const ifMatch = request.headers['if-match'];
    if (ifMatch === undefined) {
      return problem(response, 428, 'PRECONDITION_REQUIRED', String(correlationId));
    }
    if (String(ifMatch) !== `"${found.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    if (request.method === 'DELETE') {
      savedViews.splice(savedViews.indexOf(found), 1);
      response.writeHead(204);
      return response.end();
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (
        savedViews.some(
          (view) =>
            view !== found &&
            view.ownerSub === sub &&
            view.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return problem(response, 409, 'CONFLICT', String(correlationId));
      }
      body.name = name;
    }
    if (body.isDefault === true) {
      for (const view of savedViews) if (view.ownerSub === sub) view.isDefault = false;
    }
    Object.assign(found, body, { version: found.version + 1 });
    return send(response, 200, { data: savedViewDto(found, sub) }, { ETag: `"${found.version}"` });
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
  if (url.pathname === '/api/v1/approvals' && request.method === 'GET') {
    // APV-01 (US-057): a cobertura vem pronta da API; aqui só status, tipo, busca e ordenação.
    const statuses = (url.searchParams.get('status') ?? 'PENDING').split(',');
    const subjectType = url.searchParams.get('subjectType');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const sort = url.searchParams.get('sort') ?? '-requestedAt';
    const field = sort.replace(/^-/, '');
    const items = APPROVAL_LIST.filter(
      (item) =>
        statuses.includes(item.status) &&
        (subjectType === null || item.subjectType === subjectType) &&
        (q === '' ||
          `${item.process.code} ${item.process.title} ${item.title}`.toLowerCase().includes(q)),
    ).sort((a, b) => {
      const key = (item) => (field === 'code' ? item.process.code : (item[field] ?? '~'));
      return sort.startsWith('-') ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b));
    });
    return send(response, 200, {
      data: items,
      meta: { page: 1, pageSize: 20, totalItems: items.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/tasks/counters' && request.method === 'GET') {
    const views = inboxViews();
    return send(response, 200, {
      data: {
        mine: views.MINE.length,
        unitQueue: views.UNIT_QUEUE.length,
        pendingApprovals: views.PENDING_APPROVALS.length,
        returned: 0,
        overdue: 0,
        following: 0,
      },
    });
  }
  if (url.pathname === '/api/v1/tasks' && request.method === 'GET') {
    const items = inboxViews()[url.searchParams.get('view') ?? 'MINE'] ?? [];
    const descending = (url.searchParams.get('sort') ?? '-dueAt').startsWith('-');
    const sorted = [...items].sort((a, b) =>
      descending ? b.code.localeCompare(a.code) : a.code.localeCompare(b.code),
    );
    return send(response, 200, {
      data: sorted,
      meta: { page: 1, pageSize: 20, totalItems: sorted.length, totalPages: 1 },
    });
  }
  if (
    url.pathname === `/api/v1/processes/${INBOX_QUEUE_PROCESS_ID}/claim` &&
    request.method === 'POST'
  ) {
    if (inboxState.claimed)
      return problem(response, 409, 'PROCESS_ALREADY_ASSIGNED', correlationId);
    inboxState.claimed = true;
    return send(
      response,
      200,
      { data: { id: INBOX_QUEUE_PROCESS_ID, version: 4 } },
      { ETag: '"4"' },
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
  const mentionRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/mention-candidates$/.exec(
    url.pathname,
  );
  if (mentionRoute && request.method === 'GET') {
    // CMT-05 (US-072): candidatos por nome/sigla, sem acento, até 10.
    if (!processes.some((item) => item.view.id === mentionRoute[1])) {
      return problem(response, 404, 'PROCESS_NOT_FOUND', String(correlationId));
    }
    const q = foldText((url.searchParams.get('q') ?? '').trim());
    if (q === '') return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
    return send(response, 200, {
      data: MENTIONABLE.filter((item) => foldText(item.label).includes(q)).slice(0, 10),
    });
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
  const movementsRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/movements$/.exec(url.pathname);
  if (movementsRoute && request.method === 'GET') {
    const found = processes.find((item) => item.view.id === movementsRoute[1]);
    if (!found) return problem(response, 404, 'PROCESS_NOT_FOUND', String(correlationId));
    return send(response, 200, listMovements(found, url.searchParams));
  }
  const timelineRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/timeline$/.exec(url.pathname);
  if (timelineRoute && request.method === 'GET') {
    const found = processes.find((item) => item.view.id === timelineRoute[1]);
    if (!found) return problem(response, 404, 'PROCESS_NOT_FOUND', String(correlationId));
    return send(response, 200, listTimeline(found, url.searchParams));
  }
  // Etiquetas (US-007): TAG-01..03.
  if (url.pathname === '/api/v1/tags' && request.method === 'GET') {
    const withInactive = url.searchParams.get('includeInactive') === 'true';
    const list = tags
      .filter((tag) => withInactive || tag.isActive)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return send(response, 200, { data: list.map(tagDto) });
  }
  const nameTaken = (name, except) =>
    tags.some((tag) => tag !== except && tag.name.toLowerCase() === name.toLowerCase());
  const nameInvalid = (name) => name.length < 2 || name.length > 40;
  if (url.pathname === '/api/v1/tags' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const name = String(body.name ?? '').trim();
    const color = String(body.color ?? '#64748B').toUpperCase();
    if (nameInvalid(name) || !TAG_PALETTE.includes(color)) {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
        errors: [
          nameInvalid(name)
            ? { field: 'name', code: 'TOO_SHORT', message: 'Nome inválido.' }
            : { field: 'color', code: 'INVALID_ENUM', message: 'Cor inválida.' },
        ],
      });
    }
    if (nameTaken(name)) return problem(response, 409, 'CONFLICT', String(correlationId));
    const created = { id: mockUuid(), name, color, isActive: true, version: 1 };
    tags.push(created);
    return send(response, 201, { data: tagDto(created) }, { ETag: '"1"' });
  }
  const tagRoute = /^\/api\/v1\/tags\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (tagRoute && request.method === 'PATCH') {
    const found = tags.find((tag) => tag.id === tagRoute[1]);
    if (!found) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${found.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (nameTaken(name, found)) return problem(response, 409, 'CONFLICT', String(correlationId));
      found.name = name;
    }
    if (typeof body.color === 'string') found.color = body.color.toUpperCase();
    if (typeof body.isActive === 'boolean') found.isActive = body.isActive;
    found.version += 1;
    return send(response, 200, { data: tagDto(found) }, { ETag: `"${found.version}"` });
  }
  // ETP (US-019): documentos do processo (DOC-01), ETP-01/02 e o documento do ETP (DOC-03).
  const etpProcessRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/(documents|etps)$/.exec(
    url.pathname,
  );
  const etpState = etpProcessRoute ? etpStates.get(etpProcessRoute[1]) : undefined;
  if (etpProcessRoute && etpState) {
    const resource = etpProcessRoute[2];
    if (resource === 'documents' && request.method === 'GET') {
      return send(response, 200, {
        data: [],
        meta: {
          currentStage: {
            key: 'ESTUDOS_PRELIMINARES',
            name: 'ETP e mapa de riscos',
            documentTypeCodes: ['ETP', 'RISK_MAP'],
          },
          creatableTypeIds: etpState.etp === null ? [ETP_TYPE_ID] : [],
          pendingTypeIds: [],
        },
      });
    }
    if (resource === 'etps' && request.method === 'GET') {
      return send(response, 200, {
        data: etpState.etp === null ? [] : [etpState.etp.summary],
        meta: { importableDfd: etpState.etp === null ? etpState.importableDfd : null },
      });
    }
    if (resource === 'etps' && request.method === 'POST') {
      // ETP-02: idempotente por chave; 409 com `existingEtpId`; 422 `NOT_ALLOWED` sem DFD elegível.
      const body = JSON.parse((await readBody(request)) || '{}');
      const key = String(request.headers['idempotency-key'] ?? '');
      const replay = key ? etpState.replays.get(key) : undefined;
      if (replay) {
        return send(response, 201, replay, { 'Idempotent-Replayed': 'true', ETag: '"1"' });
      }
      if (etpState.etp !== null) {
        return problemWith(response, 409, 'DOCUMENT_ALREADY_EXISTS', String(correlationId), {
          members: { meta: { existingEtpId: etpState.etp.dto.id } },
        });
      }
      if (body.importFromDfd === true && etpState.importableDfd === null) {
        return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
          errors: [
            {
              field: 'importFromDfd',
              code: 'NOT_ALLOWED',
              message: 'Não há um DFD finalizado neste processo para importar.',
            },
          ],
        });
      }
      etpState.etp = buildEtp(etpState.fixture, {
        id: mockUuid(),
        code: 'ETP 0001/2026',
        imported: body.importFromDfd === true,
      });
      const result = { data: etpState.etp.dto, meta: { allowedActions: ['UPDATE'] } };
      if (key) etpState.replays.set(key, result);
      return send(response, 201, result, {
        Location: `/api/v1/etps/${etpState.etp.dto.id}`,
        ETag: '"1"',
      });
    }
  }
  const etpDocumentRoute = /^\/api\/v1\/documents\/([0-9a-f-]{36})$/.exec(url.pathname);
  const etpDocument = etpDocumentRoute ? etpOf(etpDocumentRoute[1]) : undefined;
  if (etpDocument && request.method === 'GET') {
    return send(
      response,
      200,
      { data: etpDocument.document, meta: { allowedActions: ['UPDATE'] } },
      { ETag: '"1"' },
    );
  }
  // TR (US-036): documentos do processo (DOC-01), TRM-01/02, TRM-03/04, DOC-03 e DOC-05.
  const termProcessRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/(documents|terms)$/.exec(
    url.pathname,
  );
  const termState = termProcessRoute ? termStates.get(termProcessRoute[1]) : undefined;
  if (termProcessRoute && termState) {
    const resource = termProcessRoute[2];
    if (resource === 'documents' && request.method === 'GET') {
      return send(response, 200, {
        data: [],
        meta: {
          currentStage: {
            key: 'TERMO_REFERENCIA',
            name: 'Termo de Referência',
            documentTypeCodes: ['TR'],
          },
          creatableTypeIds: termState.term === null ? [TERM_TYPE_ID] : [],
          pendingTypeIds: [],
        },
      });
    }
    if (resource === 'terms' && request.method === 'GET') {
      return send(response, 200, {
        data: termState.term === null ? [] : [termSummaryOf(termState.term)],
        meta: {
          templates: [
            {
              id: TERM_TEMPLATE.id,
              name: TERM_TEMPLATE.name,
              isDefault: true,
              versionId: TERM_TEMPLATE.versionId,
              versionNumber: 1,
            },
          ],
          defaultTitle: `Termo de Referência — ${termState.fixture.title}`,
        },
      });
    }
    if (resource === 'terms' && request.method === 'POST') {
      // TRM-02: idempotente por chave; 409 com `existingTermId`.
      const body = JSON.parse((await readBody(request)) || '{}');
      const key = String(request.headers['idempotency-key'] ?? '');
      const replay = key ? termState.replays.get(key) : undefined;
      if (replay) {
        return send(response, 201, replay, { 'Idempotent-Replayed': 'true', ETag: '"1"' });
      }
      if (termState.term !== null) {
        return problemWith(response, 409, 'DOCUMENT_ALREADY_EXISTS', String(correlationId), {
          members: { meta: { existingTermId: termState.term.id } },
        });
      }
      termState.term = buildTerm(termState.fixture, {
        id: mockUuid(),
        code: 'TR 0001/2026',
        title:
          typeof body.title === 'string' && body.title.trim() !== ''
            ? body.title.trim()
            : `Termo de Referência — ${termState.fixture.title}`,
      });
      const result = { data: termDtoOf(termState.term), meta: { allowedActions: ['UPDATE'] } };
      if (key) termState.replays.set(key, result);
      return send(response, 201, result, {
        Location: `/api/v1/terms/${termState.term.id}`,
        ETag: '"1"',
      });
    }
  }
  const termRoute = /^\/api\/v1\/terms\/([0-9a-f-]{36})$/.exec(url.pathname);
  const termFound = termRoute ? termOf(termRoute[1]) : undefined;
  if (termFound && request.method === 'GET') {
    return send(
      response,
      200,
      {
        data: termDetailOf(termFound),
        meta: {
          allowedActions: ['UPDATE'],
          template: {
            versionId: TERM_TEMPLATE.versionId,
            versionNumber: 1,
            sections: TERM_SECTIONS,
          },
        },
      },
      { ETag: `"${String(termFound.version)}"` },
    );
  }
  if (termFound && request.method === 'PATCH') {
    // TRM-04: `If-Match` da versão do TR; objeto de 10 a 2.000 caracteres (RN-TR-14).
    if (String(request.headers['if-match'] ?? '') !== `"${String(termFound.version)}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (typeof body.objectDefinition === 'string') {
      const length = body.objectDefinition.trim().length;
      if (length < 10 || length > 2000) {
        return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
          errors: [
            {
              field: 'objectDefinition',
              code: length < 10 ? 'TOO_SHORT' : 'TOO_LONG',
              message: 'O objeto deve ter entre 10 e 2.000 caracteres.',
            },
          ],
        });
      }
      termFound.objectDefinition = body.objectDefinition.trim();
    }
    if (body.estimatedValueSource === 'MANUAL') {
      termFound.estimatedValueSource = 'MANUAL';
      termFound.estimatedTotalValue = String(body.estimatedTotalValue);
      termFound.priceResearchId = null;
    } else if (typeof body.priceResearchId === 'string') {
      termFound.estimatedValueSource = 'PRICE_RESEARCH';
      termFound.estimatedTotalValue = TERM_RESEARCH.totalEstimatedValue;
      termFound.priceResearchId = TERM_RESEARCH.id;
    }
    termFound.version += 1;
    termFound.updatedAt = new Date().toISOString();
    return send(
      response,
      200,
      { data: termDtoOf(termFound), meta: { allowedActions: ['UPDATE'] } },
      { ETag: `"${String(termFound.version)}"` },
    );
  }
  const termDocumentRoute = /^\/api\/v1\/documents\/([0-9a-f-]{36})(\/sections\/([A-Z_]+))?$/.exec(
    url.pathname,
  );
  const termDocument = termDocumentRoute ? termOf(termDocumentRoute[1]) : undefined;
  if (termDocument && termDocumentRoute?.[3] === undefined && request.method === 'GET') {
    return send(
      response,
      200,
      { data: termDocument.document, meta: { allowedActions: ['UPDATE'] } },
      { ETag: '"1"' },
    );
  }
  if (termDocument && termDocumentRoute?.[3] !== undefined && request.method === 'PUT') {
    // DOC-05: revisão por seção (`If-Match: "s<revision>"`); "não se aplica" só fora das REQUIRED.
    const sectionKey = termDocumentRoute[3];
    const rule = TERM_SECTIONS.find((section) => section.key === sectionKey);
    const current = termDocument.sections[sectionKey];
    if (!rule || !current) {
      return problem(response, 422, 'SECTION_NOT_IN_TEMPLATE', String(correlationId));
    }
    if (String(request.headers['if-match'] ?? '') !== `"s${String(current.revision)}"`) {
      return problem(response, 412, 'SECTION_REVISION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    if (body.notApplicable === true && rule.requirement === 'REQUIRED') {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
        errors: [{ field: 'state', code: 'NOT_ALLOWED', message: 'Seção obrigatória.' }],
      });
    }
    const filled = body.content !== null && body.content !== undefined;
    current.state = body.notApplicable === true ? 'NOT_APPLICABLE' : filled ? 'FILLED' : 'EMPTY';
    current.content = body.notApplicable === true ? null : (body.content ?? null);
    current.justification = body.notApplicable === true ? (body.justification ?? null) : null;
    current.revision += 1;
    current.updatedAt = new Date().toISOString();
    return send(
      response,
      200,
      {
        data: {
          sectionKey,
          state: current.state,
          revision: current.revision,
          updatedAt: current.updatedAt,
          updatedBy: { id: TERM_AUTHOR_ID, name: 'Ana Souza' },
          draftRevision: current.revision,
        },
      },
      { ETag: `"s${String(current.revision)}"` },
    );
  }
  // Documento livre (US-063): DOC-01 (menu com o Ofício), DOC-02, DOC-03 e DOC-05.
  const freeTextProcessRoute = /^\/api\/v1\/processes\/([0-9a-f-]{36})\/documents$/.exec(
    url.pathname,
  );
  const freeTextState = freeTextProcessRoute
    ? freeTextStates.get(freeTextProcessRoute[1])
    : undefined;
  if (freeTextProcessRoute && freeTextState && request.method === 'GET') {
    return send(response, 200, {
      data: freeTextState.documents.map(({ draftContent: _content, ...document }) => ({
        ...document,
        responsibleName: 'Ana Souza',
        summary: null,
        meta: { allowedActions: ['UPDATE', 'FINALIZE'] },
      })),
      meta: {
        currentStage: { key: 'ESTUDOS', name: 'Estudos preliminares', documentTypeCodes: [] },
        creatableTypeIds: [FREE_TEXT_TYPE.id],
        pendingTypeIds: [],
      },
    });
  }
  if (freeTextProcessRoute && freeTextState && request.method === 'POST') {
    // DOC-02: idempotente por chave; título de 5 a 250 caracteres (V-01).
    const body = JSON.parse((await readBody(request)) || '{}');
    const key = String(request.headers['idempotency-key'] ?? '');
    const replay = key ? freeTextState.replays.get(key) : undefined;
    if (replay) {
      return send(response, 201, replay, { 'Idempotent-Replayed': 'true', ETag: '"1"' });
    }
    const title = String(body.title ?? '').trim();
    if (title.length < 5 || title.length > 250) {
      return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), {
        errors: [
          {
            field: 'title',
            code: title.length < 5 ? 'TOO_SHORT' : 'TOO_LONG',
            message: 'O título deve ter entre 5 e 250 caracteres.',
          },
        ],
      });
    }
    const document = buildFreeTextDocument(
      freeTextState,
      title,
      typeof body.responsibleId === 'string' ? body.responsibleId : null,
    );
    freeTextState.documents.push(document);
    const result = {
      data: document,
      meta: { allowedActions: ['UPDATE', 'FINALIZE'], template: FREE_TEXT_TEMPLATE },
    };
    if (key) freeTextState.replays.set(key, result);
    return send(response, 201, result, {
      Location: `/api/v1/documents/${document.id}`,
      ETag: '"1"',
    });
  }
  // DOC-24/25 (US-070): heartbeat com TTL de 60 s, sem o próprio chamador; seção fora do modelo →
  // 422 mantendo a anterior; saída idempotente.
  const presenceRoute = /^\/api\/v1\/documents\/([0-9a-f-]{36})\/presence$/.exec(url.pathname);
  const presenceDocument = presenceRoute ? freeTextDocumentOf(presenceRoute[1]) : undefined;
  if (presenceDocument && (request.method === 'PUT' || request.method === 'DELETE')) {
    const users = presenceStates.get(presenceDocument.id) ?? new Map();
    presenceStates.set(presenceDocument.id, users);
    const now = Date.now();
    for (const [key, entry] of users) {
      if (entry.lastSeenAt <= now - PRESENCE_TTL_MS) users.delete(key);
    }
    if (request.method === 'DELETE') {
      users.delete(sub);
      return send(response, 204);
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    const previous = users.get(sub);
    const valid =
      body.sectionKey === undefined ||
      presenceDocument.draftContent.sections[body.sectionKey] !== undefined;
    const sectionKey = (valid ? body.sectionKey : undefined) ?? previous?.sectionKey ?? null;
    const since =
      previous && previous.sectionKey === sectionKey ? previous.since : new Date(now).toISOString();
    users.set(sub, { sectionKey, since, lastSeenAt: now });
    if (!valid) return problem(response, 422, 'SECTION_NOT_IN_TEMPLATE', String(correlationId));
    const editors = [...users]
      .filter(([key]) => key !== sub)
      .map(([key, entry]) => ({
        userId: PRESENCE_USERS[key]?.id ?? '0192a000-0000-7000-8000-0000000000ff',
        name: PRESENCE_USERS[key]?.name ?? null,
        sectionKey: entry.sectionKey,
        since: entry.since,
      }));
    return send(response, 200, { data: { editors } }, { 'Cache-Control': 'no-store' });
  }
  const freeTextDocumentRoute =
    /^\/api\/v1\/documents\/([0-9a-f-]{36})(\/sections\/([A-Z_]+))?$/.exec(url.pathname);
  const freeTextDocument = freeTextDocumentRoute
    ? freeTextDocumentOf(freeTextDocumentRoute[1])
    : undefined;
  if (freeTextDocument && freeTextDocumentRoute?.[3] === undefined && request.method === 'GET') {
    return send(
      response,
      200,
      {
        data: freeTextDocument,
        meta: { allowedActions: ['UPDATE', 'FINALIZE'], template: FREE_TEXT_TEMPLATE },
      },
      { ETag: `"${String(freeTextDocument.version)}"` },
    );
  }
  if (freeTextDocument && freeTextDocumentRoute?.[3] !== undefined && request.method === 'PUT') {
    // DOC-05: revisão por seção (`If-Match: "s<revision>"`), sem versão nova (RN-DOC-27).
    const sectionKey = freeTextDocumentRoute[3];
    const current = freeTextDocument.draftContent.sections[sectionKey];
    if (!current) {
      return problem(response, 422, 'SECTION_NOT_IN_TEMPLATE', String(correlationId));
    }
    if (String(request.headers['if-match'] ?? '') !== `"s${String(current.revision)}"`) {
      return problem(response, 412, 'SECTION_REVISION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    const filled = body.content !== null && body.content !== undefined;
    current.state = body.notApplicable === true ? 'NOT_APPLICABLE' : filled ? 'FILLED' : 'EMPTY';
    current.content = body.notApplicable === true ? null : (body.content ?? null);
    current.justification = body.notApplicable === true ? (body.justification ?? null) : null;
    current.revision += 1;
    current.updatedAt = new Date().toISOString();
    freeTextDocument.draftRevision += 1;
    return send(
      response,
      200,
      {
        data: {
          sectionKey,
          state: current.state,
          revision: current.revision,
          updatedAt: current.updatedAt,
          updatedBy: { id: TERM_AUTHOR_ID, name: 'Ana Souza' },
          draftRevision: freeTextDocument.draftRevision,
        },
      },
      { ETag: `"s${String(current.revision)}"` },
    );
  }
  // Pesquisa de preços (US-024): itens e documentos do processo, PRS-01/02 e PRS-03/05.
  const priceProcessRoute =
    /^\/api\/v1\/processes\/([0-9a-f-]{36})\/(items|documents|price-research)$/.exec(url.pathname);
  const priceState = priceProcessRoute ? priceStates.get(priceProcessRoute[1]) : undefined;
  if (priceProcessRoute && priceState) {
    const resource = priceProcessRoute[2];
    if (resource === 'items' && request.method === 'GET') {
      return send(response, 200, { data: priceState.items }, { ETag: '"9"' });
    }
    if (resource === 'documents' && request.method === 'GET') {
      return send(response, 200, {
        data: [],
        meta: {
          currentStage: {
            key: 'PESQUISA_PRECOS',
            name: 'Pesquisa de preços',
            documentTypeCodes: ['PRICE_RESEARCH'],
          },
          creatableTypeIds: priceState.research === null ? [PRICE_TYPE_ID] : [],
          pendingTypeIds: [],
        },
      });
    }
    if (resource === 'price-research' && request.method === 'GET') {
      const research = priceState.research;
      return send(response, 200, {
        data:
          research === null
            ? []
            : [
                {
                  id: research.header.id,
                  documentId: research.header.documentId,
                  code: research.header.code,
                  title: research.header.title,
                  status: research.header.status,
                  referenceDate: research.header.referenceDate,
                  itemsCount: research.header.itemsCount,
                  itemsWithAlertsCount: research.header.itemsWithAlertsCount,
                  version: research.header.version,
                },
              ],
      });
    }
    if (resource === 'price-research' && request.method === 'POST') {
      // PRS-02: idempotente por chave; 409 com `existingId`, 422 sem itens (FA-02) e por linha
      // (quantidade ausente — FA-03) com `errors[].field = items.<i>.quantity`.
      const raw = await readBody(request);
      const body = JSON.parse(raw || '{}');
      const key = String(request.headers['idempotency-key'] ?? '');
      const replay = key ? priceState.replays.get(key) : undefined;
      if (replay) {
        return send(response, 201, replay, { 'Idempotent-Replayed': 'true', ETag: '"1"' });
      }
      if (priceState.research !== null) {
        return problemWith(response, 409, 'DOCUMENT_ALREADY_EXISTS', String(correlationId), {
          members: { meta: { existingId: priceState.research.header.id } },
        });
      }
      if (priceState.items.length === 0) {
        return problemWith(response, 422, 'BUSINESS_RULE_VIOLATION', String(correlationId), {
          members: {
            violations: [
              {
                code: 'PRICE_ITEMS_REQUIRED',
                severity: 'BLOCKING',
                message: 'Cadastre os itens da contratação antes de criar a pesquisa.',
                ruleId: null,
                sectionKey: null,
                field: null,
                itemId: null,
                params: {},
              },
            ],
          },
        });
      }
      const requested = Array.isArray(body.items)
        ? body.items
        : priceState.items.map((item) => ({ processItemId: item.id }));
      const quantities = new Map();
      const errors = [];
      requested.forEach((entry, index) => {
        const item = priceState.items.find((candidate) => candidate.id === entry.processItemId);
        const given = typeof entry.quantity === 'string' ? entry.quantity.trim() : '';
        const quantity = given !== '' ? given : (item?.referenceQuantity ?? '');
        if (!item || !(Number(quantity) > 0)) {
          errors.push({
            field: `items.${String(index)}.quantity`,
            code: 'REQUIRED',
            message: 'Informe a quantidade',
          });
          return;
        }
        quantities.set(item.id, Number(quantity).toFixed(4));
      });
      if (errors.length > 0) {
        return problemWith(response, 422, 'VALIDATION_ERROR', String(correlationId), { errors });
      }
      const created = buildPriceResearch(priceState, {
        id: mockUuid(),
        code: 'PP 0003/2026',
        title: body.title ?? `Pesquisa de preços — ${priceState.fixture.code}`,
        referenceDate: body.referenceDate ?? new Date().toISOString().slice(0, 10),
        quantities,
      });
      priceState.research = created;
      const result = { data: created.header, meta: priceMeta() };
      if (key) priceState.replays.set(key, result);
      return send(response, 201, result, {
        Location: `/api/v1/price-research/${created.header.id}`,
        ETag: '"1"',
      });
    }
  }
  // Fontes e cotações (US-026 · PRS-09..15): só o necessário para a jornada da aba "Fontes"; regras
  // por tipo, POL-02/POL-09 e isolamento são cobertos nos testes da API.
  if (await handlePriceSources(request, response, url, correlationId)) return;
  const priceResearchRoute = /^\/api\/v1\/price-research\/([0-9a-f-]{36})(\/items)?$/.exec(
    url.pathname,
  );
  if (priceResearchRoute && request.method === 'GET') {
    const research = priceResearchOf(priceResearchRoute[1]);
    if (!research) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (priceResearchRoute[2]) {
      return send(response, 200, {
        data: research.items,
        meta: { page: 1, pageSize: 100, totalItems: research.items.length, totalPages: 1 },
      });
    }
    return send(
      response,
      200,
      { data: research.header, meta: priceMeta() },
      { ETag: `"${String(research.header.version)}"` },
    );
  }
  // Detalhe, painel e etiquetas dos processos da lista (US-004/US-007): PRC-04/07/08/10 e PRC-18.
  const listedRoute =
    /^\/api\/v1\/processes\/([0-9a-f-]{36})(\/summary|\/stages|\/available-actions|\/tags|\/suspend|\/resume|\/cancel|\/assign)?$/.exec(
      url.pathname,
    );
  const listedFixture = listedRoute
    ? [
        ...LIST_FIXTURES,
        ...PRICE_FIXTURES,
        ...ETP_FIXTURES,
        ...TERM_FIXTURES,
        ...FREE_TEXT_FIXTURES,
        ...CANCELLATION_FIXTURES,
        ...ASSIGN_FIXTURES,
      ].find((fixture) => listProcessId(fixture.n) === listedRoute[1])
    : undefined;
  if (listedRoute && listedFixture) {
    const processId = listedRoute[1];
    // RN-PROC-108: o rascunho descartado deixa de existir para efeitos práticos.
    if (discardedDrafts.has(processId)) {
      return problem(response, 404, 'PROCESS_NOT_FOUND', String(correlationId));
    }
    if (request.method === 'POST' && listedRoute[2] === '/cancel') {
      if (String(request.headers['if-match'] ?? '') !== `"${processVersionOf(processId)}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      if (cancellations.has(processId)) {
        return problem(response, 409, 'INVALID_PROCESS_STATUS', String(correlationId));
      }
      const body = JSON.parse((await readBody(request)) || '{}');
      const reason = String(body.cancellationReason ?? '').trim();
      if (reason.length < 20) {
        return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
      }
      const canceledAt = new Date().toISOString();
      cancellations.set(processId, { canceledAt, reason });
      processVersions.set(processId, processVersionOf(processId) + 1);
      return send(
        response,
        200,
        {
          data: {
            id: processId,
            status: 'CANCELED',
            canceledAt,
            cancellationReason: reason,
            version: processVersionOf(processId),
          },
        },
        { ETag: `"${processVersionOf(processId)}"` },
      );
    }
    if (request.method === 'DELETE' && listedRoute[2] === undefined) {
      if (String(request.headers['if-match'] ?? '') !== `"${processVersionOf(processId)}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      if (statusOfListed(processId, listedFixture) !== 'DRAFT') {
        return problem(response, 409, 'INVALID_PROCESS_STATUS', String(correlationId));
      }
      if (listedFixture.code !== null) {
        return problem(response, 409, 'CANNOT_DISCARD_NUMBERED_PROCESS', String(correlationId));
      }
      discardedDrafts.add(processId);
      response.writeHead(204);
      return response.end();
    }
    const tagsDto = tagsOfProcess(processId).map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      isActive: tag.isActive,
    }));
    if (listedRoute[2] === '/tags' && request.method === 'PUT') {
      if (String(request.headers['if-match'] ?? '') !== `"${processVersionOf(processId)}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      const body = JSON.parse((await readBody(request)) || '{}');
      const ids = Array.isArray(body.tagIds) ? body.tagIds : [];
      const current = processTagLinks.get(processId) ?? new Set();
      const unchanged = ids.length === current.size && ids.every((id) => current.has(id));
      if (!unchanged) {
        processTagLinks.set(processId, new Set(ids));
        processVersions.set(processId, processVersionOf(processId) + 1);
      }
      return send(
        response,
        200,
        { data: { tags: tagsOfProcess(processId).map(tagDto) } },
        { ETag: `"${processVersionOf(processId)}"` },
      );
    }
    if (request.method === 'POST' && listedRoute[2] === '/suspend') {
      if (String(request.headers['if-match'] ?? '') !== `"${processVersionOf(processId)}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      if (suspensions.has(processId)) {
        return problem(response, 409, 'INVALID_PROCESS_STATUS', String(correlationId));
      }
      const body = JSON.parse((await readBody(request)) || '{}');
      const reason = String(body.reason ?? '').trim();
      if (reason.length < 20) {
        return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
      }
      const suspendedAt = new Date().toISOString();
      suspensions.set(processId, { statusBefore: listedFixture.status, suspendedAt, reason });
      processVersions.set(processId, processVersionOf(processId) + 1);
      return send(
        response,
        200,
        {
          data: {
            id: processId,
            status: 'SUSPENDED',
            statusBeforeSuspension: listedFixture.status,
            suspendedAt,
            suspensionReason: reason,
            version: processVersionOf(processId),
          },
        },
        { ETag: `"${processVersionOf(processId)}"` },
      );
    }
    if (request.method === 'POST' && listedRoute[2] === '/resume') {
      if (String(request.headers['if-match'] ?? '') !== `"${processVersionOf(processId)}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      const suspension = suspensions.get(processId);
      if (!suspension)
        return problem(response, 409, 'INVALID_PROCESS_STATUS', String(correlationId));
      const from = brtDate(suspension.suspendedAt);
      const today = brtDate(new Date().toISOString());
      const days = from < today ? businessDaysBetween(from, plusDays(today, -1)).length : 0;
      const item = listProcessItem(listedFixture);
      const newDueAt =
        days === 0 ? item.deadline.dueAt : addBusinessDaysBrt(item.deadline.dueAt, days);
      suspensions.delete(processId);
      processVersions.set(processId, processVersionOf(processId) + 1);
      return send(
        response,
        200,
        {
          data: {
            id: processId,
            status: suspension.statusBefore,
            statusBeforeSuspension: null,
            suspendedAt: null,
            suspensionReason: null,
            version: processVersionOf(processId),
          },
          meta: { extendedBy: { days, slaType: 'BUSINESS' }, newDueAt },
        },
        { ETag: `"${processVersionOf(processId)}"` },
      );
    }
    if (
      request.method === 'GET' &&
      listedRoute[2] === '/available-actions' &&
      isCancellationFixture(listedFixture)
    ) {
      const canceled = cancellations.has(processId);
      const finalReason = { code: 'INVALID_PROCESS_STATUS', message: 'O processo está cancelado.' };
      return send(response, 200, {
        data: [
          {
            action: 'CANCEL',
            label: 'Cancelar processo',
            enabled: !canceled,
            reasons: canceled ? [finalReason] : [],
          },
          ...(listedFixture.status === 'DRAFT' && !canceled
            ? [{ action: 'DISCARD', label: 'Descartar rascunho', enabled: true, reasons: [] }]
            : []),
        ],
      });
    }
    if (request.method === 'POST' && listedRoute[2] === '/assign') {
      if (String(request.headers['if-match'] ?? '') !== `"${processVersionOf(processId)}"`) {
        return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
      }
      const body = JSON.parse((await readBody(request)) || '{}');
      const current = assignedResponsibles.get(processId) ?? null;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (current !== null && reason.length < 10) {
        return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
      }
      const next =
        body.assigneeId === null
          ? null
          : (ASSIGN_MEMBERS.find((member) => member.id === body.assigneeId) ?? undefined);
      if (next === undefined) {
        return problem(response, 422, 'ASSIGNEE_NOT_ELIGIBLE', String(correlationId));
      }
      assignedResponsibles.set(processId, next === null ? null : { id: next.id, name: next.name });
      processVersions.set(processId, processVersionOf(processId) + 1);
      const item = listProcessItem(listedFixture);
      return send(
        response,
        200,
        {
          data: {
            ...item,
            currentStage: null,
            currentResponsible: assignedResponsibles.get(processId),
            version: processVersionOf(processId),
          },
        },
        { ETag: `"${processVersionOf(processId)}"` },
      );
    }
    if (
      request.method === 'GET' &&
      listedRoute[2] === '/available-actions' &&
      isAssignFixture(listedFixture)
    ) {
      return send(response, 200, {
        data: [{ action: 'ASSIGN', label: 'Atribuir responsável', enabled: true, reasons: [] }],
      });
    }
    if (request.method === 'GET' && listedRoute[2] === '/available-actions') {
      const suspended = suspensions.has(processId);
      return send(response, 200, {
        data: [
          { action: 'MANAGE_TAGS', label: 'Etiquetas', enabled: true, reasons: [] },
          suspended
            ? { action: 'RESUME', label: 'Retomar processo', enabled: true, reasons: [] }
            : { action: 'SUSPEND', label: 'Suspender processo', enabled: true, reasons: [] },
        ],
      });
    }
    if (request.method === 'GET' && listedRoute[2] === '/stages') {
      return send(response, 200, { data: [] });
    }
    if (request.method === 'GET' && listedRoute[2] === '/summary') {
      const item = listProcessItem(listedFixture);
      const suspension = suspensions.get(processId);
      const cancellation = cancellations.get(processId);
      const status = statusOfListed(processId, listedFixture);
      // FA-02: o 0091/2026 aguarda 1 aprovação até ser cancelado.
      const pendingApprovals =
        listedFixture.n === 91 && !cancellation
          ? [
              {
                id: '0192a000-0000-7000-8000-0000000a0091',
                title: 'Aprovação da autoridade',
                approverLabel: 'Roberto Lima',
                requestedAt: '2026-10-04T12:00:00.000Z',
                dueAt: null,
                isOverdue: false,
                isMine: false,
              },
            ]
          : [];
      return send(response, 200, {
        data: {
          header: {
            code: item.code,
            title: item.title,
            status,
            priority: item.priority,
            tags: tagsDto,
            isBudgetConfidential: false,
            estimatedValue: '85000.00',
            estimatedValueMasked: false,
            estimatedValueSource: 'DFD',
            organization: item.organization,
            showOrganization: false,
          },
          where: {
            stage: {
              key: 'PESQUISA_PRECOS',
              name: 'Pesquisa de preços',
              type: 'TASK',
              groupLabel: 'Planejamento',
            },
            department: item.currentDepartment,
            status,
            statusBeforeSuspension: suspension?.statusBefore ?? null,
            suspensionReason: suspension?.reason ?? null,
            suspendedAt: suspension?.suspendedAt ?? null,
            completedAt: null,
            canceledAt: cancellation?.canceledAt ?? null,
            cancellationReason: cancellation?.reason ?? null,
          },
          responsible: isAssignFixture(listedFixture)
            ? {
                user: assignedResponsibles.get(processId)
                  ? { ...assignedResponsibles.get(processId), jobTitle: null }
                  : null,
                queueDepartment: assignedResponsibles.get(processId)
                  ? null
                  : item.currentDepartment,
                since: '2026-10-01T12:10:00.000Z',
                approver: null,
              }
            : {
                user: {
                  id: '0192a000-0000-7000-8000-00000000a0a1',
                  name: 'Ana Souza',
                  jobTitle: null,
                },
                queueDepartment: null,
                since: '2026-10-01T12:10:00.000Z',
                approver: null,
              },
          pending: { blockingCount: 0, warningCount: 0, items: [] },
          nextStep: {
            action: suspension
              ? { action: 'RESUME', label: 'Retomar processo', enabled: true, reasons: [] }
              : null,
            instructions: null,
          },
          deadline: { ...item.deadline, isPaused: suspension !== undefined },
          target: { targetDate: '2026-11-30', isOverdue: false, overdueDays: null },
          documents: [],
          approvals: pendingApprovals,
          counts: { documents: 0, items: 0, comments: 0, participants: 0 },
          version: processVersionOf(processId),
        },
      });
    }
    if (request.method === 'GET' && listedRoute[2] === undefined) {
      const item = listProcessItem(listedFixture);
      return send(
        response,
        200,
        {
          data: {
            id: item.id,
            code: item.code,
            number: item.number,
            year: item.year,
            internalCode: null,
            title: item.title,
            object: 'Aquisição de cimento Portland para a manutenção das vias do município.',
            description: null,
            status: statusOfListed(processId, listedFixture),
            priority: item.priority,
            organization: item.organization,
            requestingSecretariat: item.requestingSecretariat,
            requestingDepartment: item.requestingDepartment,
            contractingType: item.contractingType,
            modality: null,
            origin: item.origin,
            isPriceRegistration: false,
            currentStage: null,
            currentDepartment: item.currentDepartment,
            currentResponsible: assignedResponsibles.get(processId) ?? null,
            workflow: { id: mockUuid(), name: 'Fluxo padrão', versionNumber: 1 },
            targetDate: item.targetDate,
            estimatedValue: item.estimatedValue,
            estimatedValueMasked: false,
            estimatedValueSource: 'DFD',
            isBudgetConfidential: false,
            pcaStatus: 'NOT_APPLICABLE',
            pcaYear: null,
            pcaItemCode: null,
            pcaJustification: null,
            notes: null,
            creationChannel: 'WEB',
            duplicatedFromId: null,
            openedAt: null,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            createdBy: { id: '0192a000-0000-7000-8000-00000000a0a1', name: 'Ana Souza' },
            version: processVersionOf(processId),
          },
        },
        { ETag: `"${processVersionOf(processId)}"` },
      );
    }
  }
  // CAL-05/CAL-06 (prévia da retomada — US-008): dias úteis sem feriados, fuso de Brasília.
  if (request.method === 'GET' && url.pathname === '/api/v1/calendar/business-days') {
    const dates = businessDaysBetween(
      String(url.searchParams.get('from')),
      String(url.searchParams.get('to')),
    );
    return send(response, 200, { data: { businessDays: dates.length, dates } });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/calendar/add-business-days') {
    const body = JSON.parse((await readBody(request)) || '{}');
    return send(response, 200, {
      data: {
        dueDateTime: addBusinessDaysBrt(String(body.fromDateTime), Number(body.businessDays)),
      },
    });
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
