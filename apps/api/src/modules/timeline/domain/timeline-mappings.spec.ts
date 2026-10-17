import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TIMELINE_ENTRY_TYPES } from '@contrataflow/types';
import type { TimelineEntryType } from '@contrataflow/types';
import { matchesAnyRoutingKey } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { TimelinePayloadError, graphemesOf } from './timeline-entry.js';
import type { TimelineEntryProjection } from './timeline-entry.js';
import { TimelineLookups } from './timeline-lookups.js';
import type { TimelineLookupRecords, TimelineLookupRef } from './timeline-lookups.js';
import { TIMELINE_MAPPINGS, TIMELINE_ROUTING_KEYS } from './timeline-mappings.js';
import type { TimelineSourceEvent } from './timeline-mappings.js';

const id = (n: number) => `0192f000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const TENANT = id(1);
const PROCESS = id(2);
const OTHER_PROCESS = id(3);
const ANA = id(10);
const BRUNO = id(11);
const DEPT_MANUT = id(20);
const DEPT_COMPRAS = id(21);
const ROLE = id(30);
const STAGE_FROM = id(40);
const STAGE_TO = id(41);
const MOVEMENT = id(42);
const PARTICIPANT = id(43);
const DOC = id(50);
const DOC_VERSION = id(51);
const APPROVAL = id(60);
const COMMENT = id(70);
const ATTACHMENT = id(71);
const ALTERNATIVE = id(80);
const PRICE_RESEARCH = id(81);
const PRICE_ITEM = id(82);
const QUOTATION = id(83);
const RISK = id(84);
const TERM = id(85);
const ETP = id(86);

/** Leituras auxiliares de teste: o estado "no momento do fato". */
const RECORDS: { [K in keyof TimelineLookupRecords]: Record<string, TimelineLookupRecords[K]> } = {
  USER: { [ANA]: { name: 'Ana Souza' }, [BRUNO]: { name: 'Bruno Lima' } },
  DEPARTMENT: {
    [DEPT_MANUT]: { name: 'Setor de Manutenção' },
    [DEPT_COMPRAS]: { name: 'Departamento de Compras' },
  },
  ROLE: { [ROLE]: { name: 'Gestor de Contratações' } },
  PROCESS: {
    [PROCESS]: { code: '0012/2026', isBudgetConfidential: false },
    [OTHER_PROCESS]: { code: '0007/2026', isBudgetConfidential: false },
  },
  PROCESS_STAGE: { [STAGE_FROM]: { name: 'Abertura' }, [STAGE_TO]: { name: 'Aprovação do DFD' } },
  PROCESS_PARTICIPANT: { [PARTICIPANT]: { name: 'Bruno Lima', role: 'OBSERVER' } },
  DOCUMENT: { [DOC]: { code: 'DFD 0003/2026', title: 'DFD de manutenção', typeName: 'DFD' } },
  DOCUMENT_VERSION: { [DOC_VERSION]: { versionNumber: 3 } },
  APPROVAL: { [APPROVAL]: { title: 'Aprovação do DFD' } },
  COMMENT: { [COMMENT]: { excerpt: 'Favor revisar o item 2.' } },
  ATTACHMENT: { [ATTACHMENT]: { fileName: 'orcamento.pdf', targetType: 'PROCESS' } },
  ETP_ALTERNATIVE: { [ALTERNATIVE]: { name: 'Locação de equipamentos' } },
  PRICE_ITEM: { [PRICE_ITEM]: { sequence: 4 } },
  QUOTATION: { [QUOTATION]: { sourceLabel: 'Fornecedor XPTO' } },
  RISK: { [RISK]: { code: 'R-02', title: 'Atraso na entrega' } },
};

function lookups(overrides: Partial<typeof RECORDS> = {}): TimelineLookups {
  const merged = { ...RECORDS, ...overrides };
  return new TimelineLookups(
    Object.fromEntries(
      Object.entries(merged).map(([kind, records]) => [kind, new Map(Object.entries(records))]),
    ),
  );
}

function event(
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<TimelineSourceEvent> = {},
): TimelineSourceEvent {
  return {
    eventId: id(999),
    eventType,
    routingKey: 'process.created',
    eventVersion: 1,
    occurredAt: '2026-10-15T12:00:00.000Z',
    tenantId: TENANT,
    aggregateType: 'Process',
    aggregateId: PROCESS,
    processId: PROCESS,
    actor: { type: 'USER', userId: ANA, membershipId: id(12) },
    correlationId: 'corr-us059',
    causationId: null,
    payload,
    ...overrides,
  };
}

interface Projected {
  readonly refs: readonly TimelineLookupRef[];
  readonly actorDepartmentId: string | null;
  readonly entries: readonly TimelineEntryProjection[];
}

function project(source: TimelineSourceEvent, book = lookups()): Projected | null {
  const mapping = TIMELINE_MAPPINGS.get(source.eventType);
  if (!mapping) throw new Error(`sem mapeamento para ${source.eventType}`);
  const plan = mapping.plan(source);
  if (plan === null) return null;
  return {
    refs: plan.refs,
    actorDepartmentId: plan.actorDepartmentId,
    entries: plan.build({ lookups: book, actorName: 'Ana Souza' }),
  };
}

function only(projected: Projected | null): TimelineEntryProjection {
  expect(projected?.entries).toHaveLength(1);
  const [first] = projected?.entries ?? [];
  if (!first) throw new Error('sem entrada');
  return first;
}

const stageChange = (cause: string, extra: Record<string, unknown> = {}) => ({
  cause,
  movementId: MOVEMENT,
  fromStage: { processStageId: STAGE_FROM, key: 'ABERTURA' },
  toStage: { processStageId: STAGE_TO, key: 'APROVACAO_DFD', type: 'APPROVAL' },
  fromDepartmentId: DEPT_MANUT,
  toDepartmentId: DEPT_COMPRAS,
  toUserId: BRUNO,
  dueAt: '2026-10-09T23:59:59-03:00',
  documentIds: [DOC],
  ...extra,
});

/** Um evento válido por linha da RN-TML-02 → tipo esperado. */
const CASES: readonly (readonly [string, Record<string, unknown>, TimelineEntryType])[] = [
  [
    'ProcessCreated',
    { title: 'Manutenção', requestingDepartmentId: DEPT_MANUT },
    'PROCESS_CREATED',
  ],
  ['ProcessUpdated', { changedFields: ['title'] }, 'PROCESS_UPDATED'],
  [
    'ProcessNumberAssigned',
    { number: 12, year: 2026, code: '0012/2026' },
    'PROCESS_NUMBER_ASSIGNED',
  ],
  [
    'ProcessItemsChanged',
    { added: [id(90)], updated: [], removed: [id(91), id(92)], itemsCount: 5 },
    'ITEMS_CHANGED',
  ],
  ['ProcessStageChanged', stageChange('FORWARD'), 'PROCESS_FORWARDED'],
  ['ProcessStageChanged', stageChange('RETURN'), 'PROCESS_RETURNED'],
  ['ProcessStageChanged', stageChange('APPROVAL_APPROVED'), 'PROCESS_STAGE_CHANGED'],
  ['ProcessStageChanged', stageChange('COMPLETE'), 'PROCESS_STAGE_CHANGED'],
  [
    'ProcessAssigned',
    { assignmentType: 'CLAIM', departmentId: DEPT_COMPRAS, toUserId: ANA },
    'PROCESS_CLAIMED',
  ],
  [
    'ProcessAssigned',
    { assignmentType: 'MANUAL', departmentId: DEPT_COMPRAS, toUserId: BRUNO, fromUserId: ANA },
    'PROCESS_ASSIGNED',
  ],
  [
    'ProcessStatusChanged',
    { fromStatus: 'IN_PROGRESS', toStatus: 'SUSPENDED', reasonProvided: true },
    'PROCESS_SUSPENDED',
  ],
  [
    'ProcessStatusChanged',
    { fromStatus: 'SUSPENDED', toStatus: 'IN_PROGRESS', reasonProvided: false },
    'PROCESS_RESUMED',
  ],
  ['ProcessStatusChanged', { fromStatus: 'IN_PROGRESS', toStatus: 'CANCELED' }, 'PROCESS_CANCELED'],
  [
    'ProcessStatusChanged',
    { fromStatus: 'AWAITING_APPROVAL', toStatus: 'COMPLETED' },
    'PROCESS_COMPLETED',
  ],
  [
    'ProcessParticipantAdded',
    { participantId: PARTICIPANT, userId: BRUNO, role: 'OBSERVER' },
    'PARTICIPANT_ADDED',
  ],
  [
    'ProcessParticipantRemoved',
    { participantId: PARTICIPANT, reason: 'REVOKED' },
    'PARTICIPANT_REMOVED',
  ],
  ['ProcessConfidentialityChanged', { isBudgetConfidential: true }, 'CONFIDENTIALITY_CHANGED'],
  [
    'ProcessStageOverdue',
    { processStageId: STAGE_TO, stageKey: 'APROVACAO_DFD', dueAt: '2026-10-09T23:59:59-03:00' },
    'STAGE_OVERDUE',
  ],
  [
    'DocumentCreated',
    { documentId: DOC, documentTypeCode: 'DFD', kind: 'STRUCTURED', title: 'DFD de manutenção' },
    'DOCUMENT_CREATED',
  ],
  [
    'DocumentVersionCreated',
    { documentId: DOC, documentVersionId: DOC_VERSION, versionNumber: 3, reason: 'SUBMISSION' },
    'DOCUMENT_VERSION_CREATED',
  ],
  ['DocumentSubmitted', { documentId: DOC, documentVersionId: DOC_VERSION }, 'DOCUMENT_SUBMITTED'],
  ['DocumentFinalized', { documentId: DOC, documentVersionId: DOC_VERSION }, 'DOCUMENT_FINALIZED'],
  ['DocumentApproved', { documentId: DOC, approvalId: APPROVAL }, 'DOCUMENT_APPROVED'],
  ['DocumentReturned', { documentId: DOC, approvalId: APPROVAL }, 'DOCUMENT_RETURNED'],
  ['DocumentRejected', { documentId: DOC, approvalId: APPROVAL }, 'DOCUMENT_REJECTED'],
  ['DocumentReopened', { documentId: DOC, fromStatus: 'APPROVED' }, 'DOCUMENT_REOPENED'],
  ['DocumentCanceled', { documentId: DOC, fromStatus: 'DRAFT' }, 'DOCUMENT_CANCELED'],
  ['DocumentWithdrawn', { documentId: DOC, approvalId: APPROVAL }, 'DOCUMENT_WITHDRAWN'],
  [
    'ApprovalRequested',
    { approvalId: APPROVAL, subjectType: 'DOCUMENT', approverType: 'USER', approverUserId: BRUNO },
    'APPROVAL_REQUESTED',
  ],
  [
    'ApprovalCompleted',
    { approvalId: APPROVAL, decidedById: BRUNO, decidedAsDeputy: false },
    'APPROVAL_DECIDED',
  ],
  [
    'ApprovalReturned',
    { approvalId: APPROVAL, decidedById: BRUNO, decidedAsDeputy: true },
    'APPROVAL_DECIDED',
  ],
  [
    'ApprovalRejected',
    { approvalId: APPROVAL, decidedById: BRUNO, decidedAsDeputy: false },
    'APPROVAL_DECIDED',
  ],
  ['ApprovalCanceled', { approvalId: APPROVAL, reason: 'WITHDRAWN' }, 'APPROVAL_CANCELED'],
  ['ApprovalReassigned', { approvalId: APPROVAL, toApproverUserId: ANA }, 'APPROVAL_REASSIGNED'],
  ['CommentCreated', { commentId: COMMENT, targetType: 'PROCESS' }, 'COMMENT_ADDED'],
  ['CommentDeleted', { commentId: COMMENT, byModerator: true }, 'COMMENT_REMOVED'],
  [
    'AttachmentUploaded',
    {
      attachmentId: ATTACHMENT,
      targetType: 'PROCESS',
      targetId: PROCESS,
      fileName: 'orcamento.pdf',
    },
    'ATTACHMENT_ADDED',
  ],
  ['AttachmentDeleted', { attachmentId: ATTACHMENT, hasReason: false }, 'ATTACHMENT_REMOVED'],
  [
    'EtpAlternativeRecommended',
    { etpId: ETP, alternativeId: ALTERNATIVE },
    'ETP_ALTERNATIVE_RECOMMENDED',
  ],
  [
    'QuotationExcluded',
    {
      priceResearchId: PRICE_RESEARCH,
      quotationId: QUOTATION,
      priceItemId: PRICE_ITEM,
      reason: 'EXCESSIVE',
    },
    'QUOTATION_EXCLUDED',
  ],
  [
    'QuotationRestored',
    { priceResearchId: PRICE_RESEARCH, quotationId: QUOTATION, priceItemId: PRICE_ITEM },
    'QUOTATION_RESTORED',
  ],
  ['RiskCreated', { riskId: RISK, code: 'R-02', level: 'HIGH', phase: 'PLANNING' }, 'RISK_ADDED'],
  [
    'RiskAssessed',
    { riskId: RISK, fromLevel: 'HIGH', toLevel: 'MEDIUM', score: 9 },
    'RISK_LEVEL_CHANGED',
  ],
  ['RiskDeleted', { riskId: RISK, code: 'R-02' }, 'RISK_REMOVED'],
  [
    'TermImportedFromEtp',
    {
      termId: TERM,
      etpId: ETP,
      etpVersionId: DOC_VERSION,
      sectionsImported: ['a', 'b'],
      itemsImported: 3,
    },
    'TERM_IMPORTED_FROM_ETP',
  ],
  [
    'AiGenerationCompleted',
    {
      generationId: id(90),
      documentId: DOC,
      targetModule: 'DFD',
      kind: 'DRAFT',
      action: null,
      sectionKey: null,
      model: 'fake-draft-1',
      promptVersion: '1.0.0',
    },
    'AI_CONTENT_GENERATED',
  ],
];

const EVENTS_DOC = fileURLToPath(
  new URL('../../../../../../docs/mvp-01/events.md', import.meta.url),
);

/**
 * Eventos de origem de events.md §5 já especificados cujas stories produtoras ainda não foram
 * implementadas (EP-020 — IA). A story que implementar o produtor registra o tipo, a linha do
 * mapeamento e remove o evento daqui.
 */
const PENDING_SOURCE_EVENTS: Readonly<Record<string, string>> = {
  AiContentApplied: 'US-117',
  AiContentReviewed: 'US-122',
};

/** Eventos de origem citados na tabela de events.md §5. */
function documentedSourceEvents(): string[] {
  const doc = readFileSync(EVENTS_DOC, 'utf8');
  const section = doc.slice(
    doc.indexOf('## 5. Projeção na timeline'),
    doc.indexOf('## 6. Notificações'),
  );
  const names = section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) =>
      [...(line.split('|')[2] ?? '').matchAll(/`([A-Z][A-Za-z]+)\*?`/g)].map((m) => m[1]),
    )
    // Nome de evento: agregado + fato (≥ 2 palavras); `FORWARD`, `Returned` etc. são abreviações.
    .filter((name): name is string => name !== undefined && /^[A-Z][a-z]+[A-Z]/.test(name))
    .filter((name) => !(name in PENDING_SOURCE_EVENTS));
  return [...new Set(names)];
}

describe('mapeamento evento → TimelineEntryType (RN-TML-02)', () => {
  it.each(CASES)('%s → %s', (eventType, payload, expected) => {
    expect(only(project(event(eventType, payload))).type).toBe(expected);
  });

  it('cobre todos os tipos do registro e só tipos registrados', () => {
    const produced = new Set([...TIMELINE_MAPPINGS.values()].flatMap((m) => m.entryTypes));
    expect([...produced].sort()).toEqual([...TIMELINE_ENTRY_TYPES].sort());
    expect(new Set(CASES.map(([, , type]) => type)).size).toBe(TIMELINE_ENTRY_TYPES.length - 1);
  });

  it('tem uma linha para cada evento de origem de events.md §5 (sufixos `*` expandidos)', () => {
    const documented = documentedSourceEvents();
    expect(documented.length).toBeGreaterThanOrEqual(20);
    for (const name of documented) {
      const covered =
        TIMELINE_MAPPINGS.has(name) ||
        [...TIMELINE_MAPPINGS.keys()].some((eventType) => eventType.startsWith(name));
      expect(covered, name).toBe(true);
    }
  });

  it('as routing keys assinadas cobrem os agregados de todos os eventos mapeados', () => {
    const routingKeys: Record<string, string> = {
      Process: 'process.created',
      Document: 'document.created.dfd',
      Approval: 'approval.requested',
      Comment: 'comment.created',
      Attachment: 'attachment.uploaded',
      Etp: 'etp.alternative_recommended',
      Quotation: 'price_research.quotation_excluded',
      Risk: 'risk.created',
      Term: 'term.imported_from_etp',
      AiGeneration: 'ai.generation_completed',
    };
    for (const eventType of TIMELINE_MAPPINGS.keys()) {
      const prefix = Object.keys(routingKeys).find((name) => eventType.startsWith(name));
      expect(prefix, eventType).toBeDefined();
      expect(matchesAnyRoutingKey(TIMELINE_ROUTING_KEYS, routingKeys[prefix ?? ''] ?? '')).toBe(
        true,
      );
    }
  });

  it('evento fora do registro não tem mapeamento (RN-TML-07)', () => {
    expect(TIMELINE_MAPPINGS.has('DocumentRenditionReady')).toBe(false);
    expect(TIMELINE_MAPPINGS.has('UserInvited')).toBe(false);
  });
});

describe('params congelados, entidade e visibilidade', () => {
  it('PROCESS_CREATED: code, title e requestingDepartmentName no momento do fato', () => {
    const projected = project(
      event('ProcessCreated', {
        code: '0012/2026',
        title: 'Manutenção predial',
        requestingDepartmentId: DEPT_MANUT,
        workflowId: id(5),
      }),
    );
    expect(projected?.refs).toEqual([{ kind: 'DEPARTMENT', id: DEPT_MANUT }]);
    expect(only(projected)).toEqual({
      type: 'PROCESS_CREATED',
      params: {
        code: '0012/2026',
        title: 'Manutenção predial',
        requestingDepartmentName: 'Setor de Manutenção',
      },
      visibility: 'STANDARD',
      entityType: 'Process',
      entityId: PROCESS,
      movementId: null,
    });
  });

  it('ProcessCreated com duplicatedFromId gera também PROCESS_DUPLICATED_FROM', () => {
    const projected = project(
      event('ProcessCreated', {
        title: 'Cópia',
        requestingDepartmentId: DEPT_MANUT,
        duplicatedFromId: OTHER_PROCESS,
      }),
    );
    expect(projected?.entries.map((e) => [e.type, e.params])).toEqual([
      [
        'PROCESS_CREATED',
        { code: null, title: 'Cópia', requestingDepartmentName: 'Setor de Manutenção' },
      ],
      ['PROCESS_DUPLICATED_FROM', { sourceProcessId: OTHER_PROCESS, sourceCode: '0007/2026' }],
    ]);
  });

  describe('PROCESS_UPDATED e POL-09 (RN-TML-05)', () => {
    const confidential = { [PROCESS]: { code: '0012/2026', isBudgetConfidential: true } };

    it('estimatedValue de processo sigiloso → BUDGET_RESTRICTED', () => {
      const projected = project(
        event('ProcessUpdated', { changedFields: ['title', 'estimatedValue'], version: 4 }),
        lookups({ PROCESS: confidential }),
      );
      expect(projected?.refs).toEqual([{ kind: 'PROCESS', id: PROCESS }]);
      expect(only(projected)).toMatchObject({
        params: { fields: ['title', 'estimatedValue'] },
        visibility: 'BUDGET_RESTRICTED',
      });
    });

    it('estimatedValue de processo público → STANDARD', () => {
      const projected = project(event('ProcessUpdated', { changedFields: ['estimatedValue'] }));
      expect(only(projected).visibility).toBe('STANDARD');
    });

    it('sem campo orçamentário não lê o sigilo e fica STANDARD, mesmo em processo sigiloso', () => {
      const projected = project(
        event('ProcessUpdated', { changedFields: ['title'] }),
        lookups({ PROCESS: confidential }),
      );
      expect(projected?.refs).toEqual([]);
      expect(only(projected).visibility).toBe('STANDARD');
    });

    it('processo não encontrado falha fechado (BUDGET_RESTRICTED)', () => {
      const projected = project(
        event('ProcessUpdated', { changedFields: ['estimatedValue'] }),
        lookups({ PROCESS: {} }),
      );
      expect(only(projected).visibility).toBe('BUDGET_RESTRICTED');
    });
  });

  it('ITEMS_CHANGED: contagens', () => {
    const projected = project(
      event('ProcessItemsChanged', {
        added: [id(90)],
        updated: [id(93)],
        removed: [id(91), id(92)],
        itemsCount: 5,
      }),
    );
    expect(only(projected).params).toEqual({
      itemsCount: 5,
      addedCount: 1,
      updatedCount: 1,
      removedCount: 2,
    });
  });

  it('PROCESS_FORWARDED: etapas, unidade, usuário, prazo, documentos e tramitação (RN-TML-08)', () => {
    const projected = project(
      event('ProcessStageChanged', stageChange('FORWARD', { hasComment: true })),
    );
    expect(projected?.actorDepartmentId).toBe(DEPT_MANUT);
    expect(projected?.refs).toEqual([
      { kind: 'PROCESS_STAGE', id: STAGE_FROM },
      { kind: 'PROCESS_STAGE', id: STAGE_TO },
      { kind: 'DEPARTMENT', id: DEPT_COMPRAS },
      { kind: 'USER', id: BRUNO },
      { kind: 'DOCUMENT', id: DOC },
    ]);
    expect(only(projected)).toEqual({
      type: 'PROCESS_FORWARDED',
      params: {
        fromStageName: 'Abertura',
        toStageName: 'Aprovação do DFD',
        toDepartmentName: 'Departamento de Compras',
        toUserName: 'Bruno Lima',
        dueAt: '2026-10-09T23:59:59-03:00',
        documents: [
          {
            documentId: DOC,
            documentCode: 'DFD 0003/2026',
            documentTitle: 'DFD de manutenção',
            typeName: 'DFD',
          },
        ],
        hasComment: true,
      },
      visibility: 'STANDARD',
      entityType: 'Process',
      entityId: PROCESS,
      movementId: MOVEMENT,
    });
  });

  it.each([
    ['APPROVAL_APPROVED', 'APPROVED'],
    ['APPROVAL_RETURNED', 'RETURNED'],
    ['APPROVAL_REJECTED', 'REJECTED'],
    ['COMPLETE', 'COMPLETED'],
  ])('PROCESS_STAGE_CHANGED (%s) traz decision %s', (cause, decision) => {
    const projected = project(
      event('ProcessStageChanged', stageChange(cause, { toUserId: null, dueAt: null })),
    );
    expect(only(projected)).toMatchObject({
      type: 'PROCESS_STAGE_CHANGED',
      params: { decision, toUserName: null, dueAt: null, hasComment: false },
    });
  });

  it('nomes de entidade não encontrada ficam nulos (sem inventar rótulo)', () => {
    const projected = project(
      event('ProcessStageChanged', stageChange('RETURN')),
      lookups({ PROCESS_STAGE: {}, DEPARTMENT: {}, USER: {}, DOCUMENT: {} }),
    );
    expect(only(projected).params).toMatchObject({
      fromStageName: null,
      toStageName: null,
      toDepartmentName: null,
      toUserName: null,
      documents: [{ documentId: DOC, documentCode: null, documentTitle: null, typeName: null }],
    });
  });

  it('PROCESS_ASSIGNED: toUserName e fromUserName; unidade da custódia como unidade do ator', () => {
    const projected = project(
      event('ProcessAssigned', {
        assignmentType: 'MANUAL',
        departmentId: DEPT_COMPRAS,
        toUserId: BRUNO,
        fromUserId: ANA,
        processStageId: STAGE_TO,
      }),
    );
    expect(projected?.actorDepartmentId).toBe(DEPT_COMPRAS);
    expect(only(projected).params).toEqual({ toUserName: 'Bruno Lima', fromUserName: 'Ana Souza' });
  });

  it.each(['STAGE_ENTRY', 'RETURN'])(
    'ProcessAssigned %s não gera entrada própria (FA-02 — vem com a tramitação)',
    (assignmentType) => {
      expect(
        project(event('ProcessAssigned', { assignmentType, departmentId: DEPT_COMPRAS })),
      ).toBeNull();
    },
  );

  it('PROCESS_SUSPENDED: motivo (quando informado no payload)', () => {
    const projected = project(
      event('ProcessStatusChanged', {
        fromStatus: 'IN_PROGRESS',
        toStatus: 'SUSPENDED',
        reasonProvided: true,
        reason: 'Aguardando dotação',
      }),
    );
    expect(only(projected).params).toEqual({ reason: 'Aguardando dotação', reasonProvided: true });
  });

  it('PROCESS_COMPLETED sem params; demais mudanças de status são ignoradas', () => {
    expect(
      only(
        project(
          event('ProcessStatusChanged', { fromStatus: 'IN_PROGRESS', toStatus: 'COMPLETED' }),
        ),
      ).params,
    ).toEqual({});
    expect(
      project(event('ProcessStatusChanged', { fromStatus: 'DRAFT', toStatus: 'IN_PROGRESS' })),
    ).toBeNull();
  });

  it('PARTICIPANT_ADDED: usuário ou unidade, papel e validade', () => {
    const user = project(
      event('ProcessParticipantAdded', {
        participantId: PARTICIPANT,
        userId: BRUNO,
        role: 'OBSERVER',
        expiresAt: '2026-12-31T23:59:59-03:00',
      }),
    );
    expect(only(user)).toMatchObject({
      params: {
        name: 'Bruno Lima',
        principalType: 'USER',
        role: 'OBSERVER',
        expiresAt: '2026-12-31T23:59:59-03:00',
      },
      entityType: 'ProcessParticipant',
      entityId: PARTICIPANT,
    });
    const department = project(
      event('ProcessParticipantAdded', {
        participantId: PARTICIPANT,
        departmentId: DEPT_COMPRAS,
        role: 'CONSULTANT',
      }),
    );
    expect(only(department).params).toMatchObject({
      name: 'Departamento de Compras',
      principalType: 'DEPARTMENT',
      expiresAt: null,
    });
  });

  it('PARTICIPANT_REMOVED: nome e papel congelados do participante', () => {
    const projected = project(
      event('ProcessParticipantRemoved', { participantId: PARTICIPANT, reason: 'EXPIRED' }),
    );
    expect(only(projected).params).toEqual({
      name: 'Bruno Lima',
      role: 'OBSERVER',
      reason: 'EXPIRED',
    });
    const unknown = project(
      event('ProcessParticipantRemoved', { participantId: PARTICIPANT, reason: 'REVOKED' }),
      lookups({ PROCESS_PARTICIPANT: {} }),
    );
    expect(only(unknown).params).toEqual({ name: null, role: null, reason: 'REVOKED' });
  });

  it('CONFIDENTIALITY_CHANGED é STANDARD (o sigilo em si não é segredo)', () => {
    const projected = project(
      event('ProcessConfidentialityChanged', { isBudgetConfidential: true }),
    );
    expect(only(projected)).toMatchObject({
      params: { isBudgetConfidential: true },
      visibility: 'STANDARD',
    });
  });

  it('STAGE_OVERDUE: nome da etapa e prazo', () => {
    const projected = project(
      event(
        'ProcessStageOverdue',
        { processStageId: STAGE_TO, stageKey: 'APROVACAO_DFD', dueAt: '2026-10-09T23:59:59-03:00' },
        { actor: { type: 'SYSTEM', userId: null, membershipId: null } },
      ),
    );
    expect(only(projected)).toMatchObject({
      params: {
        stageName: 'Aprovação do DFD',
        stageKey: 'APROVACAO_DFD',
        dueAt: '2026-10-09T23:59:59-03:00',
      },
      entityType: 'ProcessStage',
      entityId: STAGE_TO,
    });
  });

  it('DOCUMENT_CREATED: código e título do payload; tipo congelado', () => {
    const projected = project(
      event('DocumentCreated', {
        documentId: DOC,
        documentTypeCode: 'DFD',
        code: 'DFD 0009/2026',
        title: 'Novo DFD',
      }),
    );
    expect(only(projected)).toMatchObject({
      params: {
        documentId: DOC,
        documentCode: 'DFD 0009/2026',
        documentTitle: 'Novo DFD',
        typeCode: 'DFD',
        typeName: 'DFD',
      },
      entityType: 'Document',
      entityId: DOC,
    });
    const withoutCode = project(
      event('DocumentCreated', { documentId: DOC, documentTypeCode: 'DFD', title: 'Novo DFD' }),
      lookups({ DOCUMENT: {} }),
    );
    expect(only(withoutCode).params).toMatchObject({ documentCode: null, typeName: null });
  });

  it('DOCUMENT_VERSION_CREATED: versão, motivo e rótulo do documento', () => {
    const projected = project(
      event('DocumentVersionCreated', {
        documentId: DOC,
        documentVersionId: DOC_VERSION,
        versionNumber: 3,
        reason: 'SUBMISSION',
      }),
    );
    expect(only(projected).params).toEqual({
      documentId: DOC,
      documentCode: 'DFD 0003/2026',
      documentTitle: 'DFD de manutenção',
      typeName: 'DFD',
      documentVersionId: DOC_VERSION,
      versionNumber: 3,
      reason: 'SUBMISSION',
    });
  });

  it('DOCUMENT_FINALIZED com resumo de valores: BUDGET_RESTRICTED em processo sigiloso', () => {
    const summary = { totalEstimatedValueMasked: true, itemsCount: 4, itemsWithAlertsCount: 1 };
    const restricted = project(
      event('DocumentFinalized', {
        documentId: DOC,
        documentVersionId: DOC_VERSION,
        typedSummary: summary,
      }),
      lookups({ PROCESS: { [PROCESS]: { code: '0012/2026', isBudgetConfidential: true } } }),
    );
    expect(only(restricted)).toMatchObject({
      params: { summary },
      visibility: 'BUDGET_RESTRICTED',
    });
    const plain = project(
      event('DocumentFinalized', { documentId: DOC, documentVersionId: DOC_VERSION }),
    );
    expect(plain?.refs).toEqual([{ kind: 'DOCUMENT', id: DOC }]);
    expect(only(plain).visibility).toBe('STANDARD');
  });

  it('DOCUMENT_APPROVED: o decisor (ator do evento) é o approverName', () => {
    const projected = project(event('DocumentApproved', { documentId: DOC, approvalId: APPROVAL }));
    expect(only(projected).params).toMatchObject({
      approverName: 'Ana Souza',
      approvalId: APPROVAL,
    });
  });

  it('DOCUMENT_REOPENED: motivo opcional', () => {
    const projected = project(
      event('DocumentReopened', { documentId: DOC, reason: 'Ajustar valores' }),
    );
    expect(only(projected).params).toMatchObject({ reason: 'Ajustar valores' });
    expect(only(project(event('DocumentCanceled', { documentId: DOC }))).params).toMatchObject({
      reason: null,
    });
  });

  it.each([
    ['USER', { approverUserId: BRUNO }, 'Bruno Lima'],
    ['ROLE', { approverRoleId: ROLE }, 'Gestor de Contratações'],
    ['DEPARTMENT_HEAD', { approverDepartmentId: DEPT_COMPRAS }, 'Departamento de Compras'],
  ])('APPROVAL_REQUESTED: approverLabel do aprovador %s', (approverType, approver, label) => {
    const projected = project(
      event('ApprovalRequested', {
        approvalId: APPROVAL,
        subjectType: 'PROCESS_STAGE',
        approverType,
        dueAt: '2026-10-20T23:59:59-03:00',
        ...approver,
      }),
    );
    expect(only(projected)).toMatchObject({
      params: { approverType, approverLabel: label, dueAt: '2026-10-20T23:59:59-03:00' },
      entityType: 'Approval',
      entityId: APPROVAL,
    });
  });

  it.each([
    ['ApprovalCompleted', 'APPROVED', false],
    ['ApprovalReturned', 'RETURNED', true],
    ['ApprovalRejected', 'REJECTED', false],
  ])('APPROVAL_DECIDED por %s: decision %s', (eventType, decision, hasComment) => {
    const projected = project(
      event(eventType, { approvalId: APPROVAL, decidedById: BRUNO, decidedAsDeputy: true }),
    );
    expect(only(projected).params).toEqual({
      decision,
      title: 'Aprovação do DFD',
      asDeputy: true,
      hasComment,
    });
  });

  it('APPROVAL_CANCELED e APPROVAL_REASSIGNED', () => {
    expect(
      only(project(event('ApprovalCanceled', { approvalId: APPROVAL, reason: 'PROCESS_CANCELED' })))
        .params,
    ).toEqual({ title: 'Aprovação do DFD', reason: 'PROCESS_CANCELED' });
    expect(
      only(project(event('ApprovalReassigned', { approvalId: APPROVAL, toApproverRoleId: ROLE })))
        .params,
    ).toEqual({
      title: 'Aprovação do DFD',
      toApproverLabel: 'Gestor de Contratações',
      reason: null,
    });
  });

  it('COMMENT_ADDED: trecho de até 140 caracteres e documento quando houver', () => {
    const long = 'x'.repeat(300);
    const projected = project(
      event('CommentCreated', { commentId: COMMENT, targetType: 'DOCUMENT', documentId: DOC }),
      lookups({ COMMENT: { [COMMENT]: { excerpt: long } } }),
    );
    const params = only(projected).params;
    expect(params).toMatchObject({ targetType: 'DOCUMENT', documentCode: 'DFD 0003/2026' });
    expect(graphemesOf(String(params.excerpt))).toHaveLength(140);
    expect(only(projected)).toMatchObject({ entityType: 'Comment', entityId: COMMENT });
  });

  it('COMMENT_REMOVED só por moderação', () => {
    expect(project(event('CommentDeleted', { commentId: COMMENT, byModerator: false }))).toBeNull();
  });

  it('ATTACHMENT_ADDED/REMOVED: nome do arquivo e alvo; anexo pode não ser de processo', () => {
    const onDocument = project(
      event('AttachmentUploaded', {
        attachmentId: ATTACHMENT,
        targetType: 'DOCUMENT',
        targetId: DOC,
        fileName: 'anexo.pdf',
      }),
    );
    expect(only(onDocument).params).toMatchObject({
      fileName: 'anexo.pdf',
      targetType: 'DOCUMENT',
      documentTitle: 'DFD de manutenção',
    });
    expect(TIMELINE_MAPPINGS.get('AttachmentUploaded')?.processOptional).toBe(true);
    expect(only(project(event('AttachmentDeleted', { attachmentId: ATTACHMENT }))).params).toEqual({
      fileName: 'orcamento.pdf',
      targetType: 'PROCESS',
    });
    expect(
      only(
        project(
          event('AttachmentDeleted', { attachmentId: ATTACHMENT }),
          lookups({ ATTACHMENT: {} }),
        ),
      ).params,
    ).toEqual({ fileName: null, targetType: null });
  });

  it('ETP_ALTERNATIVE_RECOMMENDED: nome da alternativa', () => {
    expect(
      only(project(event('EtpAlternativeRecommended', { etpId: ETP, alternativeId: ALTERNATIVE })))
        .params,
    ).toEqual({ name: 'Locação de equipamentos' });
  });

  it('QUOTATION_EXCLUDED: item, fonte e motivo; BUDGET_RESTRICTED se sigiloso', () => {
    const payload = {
      priceResearchId: PRICE_RESEARCH,
      quotationId: QUOTATION,
      priceItemId: PRICE_ITEM,
      reason: 'EXCESSIVE',
    };
    expect(only(project(event('QuotationExcluded', payload)))).toMatchObject({
      params: { itemSequence: 4, sourceLabel: 'Fornecedor XPTO', reason: 'EXCESSIVE' },
      visibility: 'STANDARD',
      entityType: 'Quotation',
    });
    const confidential = lookups({
      PROCESS: { [PROCESS]: { code: '0012/2026', isBudgetConfidential: true } },
    });
    expect(only(project(event('QuotationRestored', payload), confidential)).visibility).toBe(
      'BUDGET_RESTRICTED',
    );
  });

  it('RISK_ADDED, RISK_LEVEL_CHANGED e RISK_REMOVED', () => {
    expect(
      only(project(event('RiskCreated', { riskId: RISK, code: 'R-02', level: 'HIGH' }))).params,
    ).toEqual({ code: 'R-02', title: 'Atraso na entrega', level: 'HIGH' });
    expect(
      only(project(event('RiskAssessed', { riskId: RISK, fromLevel: 'HIGH', toLevel: 'LOW' })))
        .params,
    ).toEqual({ code: 'R-02', title: 'Atraso na entrega', level: 'LOW', fromLevel: 'HIGH' });
    expect(
      only(
        project(
          event('RiskAssessed', { riskId: RISK, fromLevel: 'HIGH', toLevel: 'LOW' }),
          lookups({ RISK: {} }),
        ),
      ).params,
    ).toMatchObject({ code: null, title: null });
    expect(only(project(event('RiskDeleted', { riskId: RISK, code: 'R-02' }))).params).toEqual({
      code: 'R-02',
      title: 'Atraso na entrega',
    });
  });

  it('TERM_IMPORTED_FROM_ETP: versão do ETP e contagens', () => {
    const projected = project(
      event('TermImportedFromEtp', {
        termId: TERM,
        etpId: ETP,
        etpVersionId: DOC_VERSION,
        sectionsImported: ['objeto', 'requisitos'],
        itemsImported: 3,
      }),
    );
    expect(only(projected)).toMatchObject({
      params: { etpVersion: 3, sectionsCount: 2, itemsImported: 3 },
      entityType: 'TermOfReference',
      entityId: TERM,
    });
  });

  it('AI_CONTENT_GENERATED: documento congelado, alvo e modelo — nunca o texto gerado', () => {
    const base = {
      generationId: id(90),
      targetModule: 'DFD',
      kind: 'DRAFT',
      action: null,
      sectionKey: null,
      model: 'fake-draft-1',
      promptVersion: '1.0.0',
      totalTokens: 1200,
    };
    expect(
      only(project(event('AiGenerationCompleted', { ...base, documentId: DOC }))),
    ).toMatchObject({
      params: {
        documentId: DOC,
        documentCode: 'DFD 0003/2026',
        generationId: id(90),
        kind: 'DRAFT',
        model: 'fake-draft-1',
        promptVersion: '1.0.0',
      },
      entityType: 'AiGeneration',
      entityId: id(90),
      visibility: 'STANDARD',
    });
    const risks = only(
      project(
        event('AiGenerationCompleted', { ...base, documentId: null, targetModule: 'RISK_MAP' }),
      ),
    );
    expect(risks.params).toMatchObject({ documentId: null, targetModule: 'RISK_MAP' });
    expect(JSON.stringify(risks.params)).not.toContain('totalTokens');
  });

  it('actorDepartmentId opcional no payload vira a unidade do ator', () => {
    const projected = project(
      event('ProcessUpdated', { changedFields: ['title'], actorDepartmentId: DEPT_MANUT }),
    );
    expect(projected?.actorDepartmentId).toBe(DEPT_MANUT);
    expect(
      project(event('ProcessUpdated', { changedFields: ['title'] }))?.actorDepartmentId,
    ).toBeNull();
    expect(
      project(event('ProcessUpdated', { changedFields: ['title'], actorDepartmentId: 'x' }))
        ?.actorDepartmentId,
    ).toBeNull();
  });
});

describe('V-01: payload sem os campos exigidos', () => {
  it.each([
    ['ProcessCreated', { title: 'Sem unidade' }, 'requestingDepartmentId'],
    ['ProcessStageChanged', { ...stageChange('FORWARD'), cause: 'TELEPORT' }, 'cause'],
    ['ProcessParticipantAdded', { participantId: PARTICIPANT, role: 'OBSERVER' }, 'userId'],
    ['RiskCreated', { riskId: RISK, code: 'R-01', level: 'CATASTROPHIC' }, 'level'],
  ])('%s sem %s → TimelinePayloadError sem valores', (eventType, payload, field) => {
    const attempt = () => project(event(eventType, payload));
    expect(attempt).toThrow(TimelinePayloadError);
    expect(attempt).toThrow(new RegExp(`${eventType}.*${field}`));
    expect(attempt).not.toThrow(/Sem unidade|TELEPORT|CATASTROPHIC/);
  });
});
