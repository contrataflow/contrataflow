import { DOCUMENT_STATUSES } from '@contrataflow/validation';
import type { DocumentStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  allowedDocumentActions,
  applyApprovalDecision,
  assertConcludable,
  cancelDocument,
  concludingActionOf,
  deleteDocument,
  DocumentTransitionError,
  enterApprovalStage,
  finalizeDocument,
  hasLeftDraft,
  isEditable,
  newDocument,
  reopenDocument,
  submitDocument,
  updateDocumentHeader,
  withdrawSubmission,
} from './document.js';
import type { Document, DocumentActor, DocumentProcessState } from './document.js';
import { buildDocument, FIXTURE_NOW } from '../../../../test/support/document-fixtures.js';

/*
 * US-065 — máquina de estados `Document` (DEC-018 · RN-DOC-41..50): TODAS as transições da tabela,
 * inclusive as recusadas, e o cálculo de `allowedActions` (RN-DOC-18).
 */

const ANA = '0192f065-0000-7000-8000-0000000000a1';
const LATER = new Date('2026-10-17T10:00:00.000Z');
const stamp = { actorId: ANA, now: LATER };
const WITHOUT_APPROVAL = { requiresApproval: false };
const WITH_APPROVAL = { requiresApproval: true };
const REASON = 'Ajuste solicitado pelo controle interno.';

const inStatus = (status: DocumentStatus, overrides: Partial<Document> = {}) =>
  buildDocument({ status, ...overrides });

function refusal(apply: () => unknown): DocumentTransitionError {
  try {
    apply();
  } catch (error) {
    if (error instanceof DocumentTransitionError) return error;
    throw error;
  }
  throw new Error('A transição deveria ter sido recusada.');
}

const others = (allowed: readonly DocumentStatus[]) =>
  DOCUMENT_STATUSES.filter((status) => !allowed.includes(status));

describe('newDocument — fábrica única (RN-DOC-50)', () => {
  const base = {
    id: '0192f065-0000-7000-8000-0000000000d1',
    tenantId: '0192f065-0000-7000-8000-00000000000a',
    processId: '0192f065-0000-7000-8000-0000000000b1',
    templateVersionId: null,
    title: 'Estudo técnico',
    draftContent: { sections: {} },
    sourceDocumentId: null,
    createdById: ANA,
    now: FIXTURE_NOW,
  };

  it('nasce em DRAFT, com o sigilo do tipo, o criador como responsável e sem versão', () => {
    const document = newDocument({
      ...base,
      type: { id: 'tipo', allowMultiplePerProcess: true, defaultConfidentiality: 'RESTRICTED' },
      numbering: { number: 1, year: 2026, code: 'DESP 0001/2026' },
      responsibleId: null,
    });
    expect(document).toMatchObject({
      status: 'DRAFT',
      confidentiality: 'RESTRICTED',
      responsibleId: ANA,
      singletonKey: null,
      number: 1,
      year: 2026,
      code: 'DESP 0001/2026',
      currentVersionId: null,
      draftRevision: 1,
      version: 1,
    });
  });

  it('tipo singular recebe singletonKey = documentTypeId; sem numeração, código nulo', () => {
    const document = newDocument({
      ...base,
      type: { id: 'etp', allowMultiplePerProcess: false, defaultConfidentiality: 'INTERNAL' },
      numbering: null,
      responsibleId: '0192f065-0000-7000-8000-0000000000a2',
    });
    expect(document.singletonKey).toBe('etp');
    expect(document.code).toBeNull();
    expect(document.responsibleId).toBe('0192f065-0000-7000-8000-0000000000a2');
  });
});

describe('finalizar (RN-DOC-42 · DOC-10)', () => {
  it.each(['DRAFT', 'RETURNED'] as const)(
    '%s → FINALIZED com a versão e quem finalizou',
    (status) => {
      const next = finalizeDocument(inStatus(status), WITHOUT_APPROVAL, {
        ...stamp,
        versionId: 'v1',
        versionNumber: 1,
      });
      expect(next).toMatchObject({
        status: 'FINALIZED',
        currentVersionId: 'v1',
        currentVersionNumber: 1,
        finalizedAt: LATER,
        finalizedById: ANA,
        updatedAt: LATER,
        updatedById: ANA,
      });
      expect(isEditable(next)).toBe(false);
    },
  );

  it.each(others(['DRAFT', 'RETURNED']))('recusa a partir de %s (V-05)', (status) => {
    const error = refusal(() =>
      finalizeDocument(inStatus(status), WITHOUT_APPROVAL, {
        ...stamp,
        versionId: 'v',
        versionNumber: 1,
      }),
    );
    expect(error.failure).toBe('STATUS');
    expect(error.status).toBe(status);
  });

  it('recusa tipo que exige aprovação formal (é "Submeter")', () => {
    expect(
      refusal(() =>
        finalizeDocument(inStatus('DRAFT'), WITH_APPROVAL, {
          ...stamp,
          versionId: 'v',
          versionNumber: 1,
        }),
      ).failure,
    ).toBe('APPROVAL_MODE');
  });

  it('recusa documento excluído', () => {
    expect(
      refusal(() =>
        finalizeDocument(inStatus('DRAFT', { deletedAt: FIXTURE_NOW }), WITHOUT_APPROVAL, {
          ...stamp,
          versionId: 'v',
          versionNumber: 1,
        }),
      ).failure,
    ).toBe('STATUS');
  });
});

describe('submeter avulso (RN-DOC-43 · DOC-09)', () => {
  it.each(['DRAFT', 'RETURNED'] as const)('%s → IN_REVIEW com a aprovação pendente', (status) => {
    const next = submitDocument(inStatus(status), WITH_APPROVAL, {
      ...stamp,
      versionId: 'v2',
      versionNumber: 2,
      approvalId: 'apv',
    });
    expect(next).toMatchObject({
      status: 'IN_REVIEW',
      currentVersionId: 'v2',
      pendingApprovalId: 'apv',
      submittedAt: LATER,
      submittedById: ANA,
    });
  });

  it.each(others(['DRAFT', 'RETURNED']))('recusa a partir de %s', (status) => {
    expect(
      refusal(() =>
        submitDocument(inStatus(status), WITH_APPROVAL, {
          ...stamp,
          versionId: 'v',
          versionNumber: 1,
          approvalId: 'a',
        }),
      ).failure,
    ).toBe('STATUS');
  });

  it('recusa tipo sem aprovação formal (é "Finalizar")', () => {
    expect(
      refusal(() =>
        submitDocument(inStatus('DRAFT'), WITHOUT_APPROVAL, {
          ...stamp,
          versionId: 'v',
          versionNumber: 1,
          approvalId: 'a',
        }),
      ).failure,
    ).toBe('APPROVAL_MODE');
  });

  it('assertConcludable antecipa as mesmas recusas antes da completude', () => {
    expect(concludingActionOf(WITH_APPROVAL)).toBe('SUBMIT');
    expect(concludingActionOf(WITHOUT_APPROVAL)).toBe('FINALIZE');
    expect(() => {
      assertConcludable(inStatus('DRAFT'), WITHOUT_APPROVAL, 'FINALIZE');
    }).not.toThrow();
    expect(
      refusal(() => {
        assertConcludable(inStatus('DRAFT'), WITHOUT_APPROVAL, 'SUBMIT');
      }).failure,
    ).toBe('APPROVAL_MODE');
    expect(
      refusal(() => {
        assertConcludable(inStatus('FINALIZED'), WITHOUT_APPROVAL, 'FINALIZE');
      }).failure,
    ).toBe('STATUS');
  });
});

describe('entrada em etapa de aprovação (RN-DOC-44 · FA-02)', () => {
  const draftVersion = { id: 'v3', versionNumber: 3 };

  it.each(['DRAFT', 'RETURNED'] as const)('%s → IN_REVIEW com versão nova', (status) => {
    const outcome = enterApprovalStage(inStatus(status), {
      ...stamp,
      approvalId: 'apv',
      draftVersion,
    });
    expect(outcome.createdVersion).toBe(true);
    expect(outcome.document).toMatchObject({
      status: 'IN_REVIEW',
      currentVersionId: 'v3',
      pendingApprovalId: 'apv',
      submittedAt: LATER,
    });
  });

  it.each(['FINALIZED', 'APPROVED'] as const)(
    '%s mantém o status e só ganha pendingApprovalId',
    (status) => {
      const outcome = enterApprovalStage(inStatus(status, { currentVersionId: 'v1' }), {
        ...stamp,
        approvalId: 'apv',
        draftVersion: null,
      });
      expect(outcome.createdVersion).toBe(false);
      expect(outcome.document).toMatchObject({
        status,
        currentVersionId: 'v1',
        pendingApprovalId: 'apv',
      });
    },
  );

  it.each(['IN_REVIEW', 'REJECTED', 'CANCELED'] as const)('recusa a partir de %s', (status) => {
    expect(
      refusal(() =>
        enterApprovalStage(inStatus(status), { ...stamp, approvalId: 'a', draftVersion }),
      ).failure,
    ).toBe('STATUS');
  });

  it('recusa documento já coberto por outra aprovação pendente, e rascunho sem versão a criar', () => {
    expect(
      refusal(() =>
        enterApprovalStage(inStatus('FINALIZED', { pendingApprovalId: 'outra' }), {
          ...stamp,
          approvalId: 'a',
          draftVersion: null,
        }),
      ).failure,
    ).toBe('STATUS');
    expect(
      refusal(() =>
        enterApprovalStage(inStatus('DRAFT'), { ...stamp, approvalId: 'a', draftVersion: null }),
      ).failure,
    ).toBe('STATUS');
  });
});

describe('decisão da aprovação (RN-DOC-45 · FA-03)', () => {
  const pending = (status: DocumentStatus) =>
    inStatus(status, { pendingApprovalId: 'apv', currentVersionId: 'v2' });
  const decide = (document: Document, outcome: 'APPROVED' | 'RETURNED' | 'REJECTED') =>
    applyApprovalDecision(document, {
      ...stamp,
      approvalId: 'apv',
      outcome,
      analyzedVersionId: 'v2',
    });

  it.each(['IN_REVIEW', 'FINALIZED', 'APPROVED'] as const)(
    '%s + APPROVED → APPROVED com a versão analisada',
    (status) => {
      expect(decide(pending(status), 'APPROVED')).toMatchObject({
        status: 'APPROVED',
        approvedVersionId: 'v2',
        approvedAt: LATER,
        pendingApprovalId: null,
      });
    },
  );

  it.each(['IN_REVIEW', 'FINALIZED', 'APPROVED'] as const)(
    '%s + RETURNED → RETURNED (editável de novo)',
    (status) => {
      const next = decide(pending(status), 'RETURNED');
      expect(next).toMatchObject({
        status: 'RETURNED',
        returnedAt: LATER,
        pendingApprovalId: null,
      });
      expect(isEditable(next)).toBe(true);
    },
  );

  it.each(['IN_REVIEW', 'FINALIZED', 'APPROVED'] as const)('%s + REJECTED → REJECTED', (status) => {
    expect(decide(pending(status), 'REJECTED')).toMatchObject({
      status: 'REJECTED',
      rejectedAt: LATER,
      pendingApprovalId: null,
    });
  });

  it.each(['DRAFT', 'RETURNED', 'REJECTED', 'CANCELED'] as const)(
    'recusa documento em %s',
    (status) => {
      expect(refusal(() => decide(pending(status), 'APPROVED')).failure).toBe('STATUS');
    },
  );

  it('recusa a decisão de outra aprovação (não a pendente do documento)', () => {
    expect(
      refusal(() =>
        applyApprovalDecision(pending('IN_REVIEW'), {
          ...stamp,
          approvalId: 'outra',
          outcome: 'APPROVED',
          analyzedVersionId: 'v2',
        }),
      ).failure,
    ).toBe('STATUS');
  });
});

describe('retirar submissão avulsa (RN-DOC-46 · DOC-11 da US-053)', () => {
  it('IN_REVIEW → DRAFT, limpando a aprovação pendente', () => {
    expect(
      withdrawSubmission(inStatus('IN_REVIEW', { pendingApprovalId: 'apv' }), stamp),
    ).toMatchObject({
      status: 'DRAFT',
      pendingApprovalId: null,
    });
  });

  it.each(others(['IN_REVIEW']))('recusa a partir de %s', (status) => {
    expect(refusal(() => withdrawSubmission(inStatus(status), stamp)).failure).toBe('STATUS');
  });
});

describe('reabrir (RN-DOC-47 · POL-11 · DOC-12)', () => {
  const baseSections = {
    OBJETO: {
      state: 'FILLED' as const,
      content: { type: 'doc' as const },
      justification: null,
      revision: 5,
      updatedAt: LATER.toISOString(),
      updatedById: ANA,
    },
  };

  it.each(['APPROVED', 'FINALIZED', 'REJECTED'] as const)(
    '%s → DRAFT com justificativa e o rascunho da última versão, sem versão nova',
    (status) => {
      const document = inStatus(status, {
        currentVersionId: 'v1',
        currentVersionNumber: 1,
        draftRevision: 4,
      });
      const next = reopenDocument(document, { ...stamp, reason: REASON, baseSections });
      expect(next).toMatchObject({
        status: 'DRAFT',
        reopenedAt: LATER,
        reopenedById: ANA,
        reopenReason: REASON,
        draftRevision: 5,
        currentVersionId: 'v1',
        draftContent: { sections: baseSections },
      });
    },
  );

  it('sem conteúdo estruturado na versão (externo), mantém o rascunho atual', () => {
    const document = inStatus('FINALIZED', { draftContent: { sections: {} } });
    expect(
      reopenDocument(document, { ...stamp, reason: REASON, baseSections: null }).draftContent,
    ).toEqual({
      sections: {},
    });
  });

  it('com aprovação pendente → PENDING_APPROVAL (V-04)', () => {
    const error = refusal(() =>
      reopenDocument(inStatus('FINALIZED', { pendingApprovalId: 'apv' }), {
        ...stamp,
        reason: REASON,
        baseSections: null,
      }),
    );
    expect(error.failure).toBe('PENDING_APPROVAL');
    expect(error.status).toBe('FINALIZED');
  });

  it.each(others(['APPROVED', 'FINALIZED', 'REJECTED']))('recusa a partir de %s', (status) => {
    expect(
      refusal(() =>
        reopenDocument(inStatus(status), { ...stamp, reason: REASON, baseSections: null }),
      ).failure,
    ).toBe('STATUS');
  });
});

describe('cancelar (RN-DOC-48 · DOC-13)', () => {
  it.each(['DRAFT', 'RETURNED'] as const)('%s → CANCELED (final) com o motivo', (status) => {
    expect(cancelDocument(inStatus(status), { ...stamp, reason: REASON })).toMatchObject({
      status: 'CANCELED',
      canceledAt: LATER,
      canceledById: ANA,
      cancellationReason: REASON,
    });
  });

  it.each(others(['DRAFT', 'RETURNED']))('recusa a partir de %s (CANCELED é final)', (status) => {
    expect(
      refusal(() => cancelDocument(inStatus(status), { ...stamp, reason: REASON })).failure,
    ).toBe('STATUS');
  });
});

describe('excluir rascunho (RN-DOC-49 · DOC-14)', () => {
  it('rascunho nunca submetido recebe a exclusão lógica', () => {
    const next = deleteDocument(inStatus('DRAFT'), stamp);
    expect(next.deletedAt).toEqual(LATER);
    expect(isEditable(next)).toBe(false);
  });

  it('rascunho que já saiu de DRAFT (finalizado e reaberto) → ALREADY_SUBMITTED (V-07)', () => {
    const reopened = inStatus('DRAFT', { finalizedAt: FIXTURE_NOW, reopenedAt: LATER });
    expect(hasLeftDraft(reopened)).toBe(true);
    expect(refusal(() => deleteDocument(reopened, stamp)).failure).toBe('ALREADY_SUBMITTED');
    expect(
      refusal(() => deleteDocument(inStatus('DRAFT', { submittedAt: FIXTURE_NOW }), stamp)).failure,
    ).toBe('ALREADY_SUBMITTED');
  });

  it.each(others(['DRAFT']))('recusa a partir de %s', (status) => {
    expect(refusal(() => deleteDocument(inStatus(status), stamp)).failure).toBe('STATUS');
  });
});

describe('cabeçalho do rascunho (RN-DOC-55 · DOC-04)', () => {
  it('altera título e responsável e lista só o que mudou', () => {
    const document = inStatus('DRAFT', { title: 'Antigo', responsibleId: ANA });
    const { document: next, changes } = updateDocumentHeader(
      document,
      { title: 'Título novo', responsibleId: ANA },
      stamp,
    );
    expect(next).toMatchObject({ title: 'Título novo', responsibleId: ANA, updatedAt: LATER });
    expect(changes).toEqual([{ field: 'title', old: 'Antigo', new: 'Título novo' }]);
  });

  it('sem mudança devolve o mesmo documento', () => {
    const document = inStatus('RETURNED', { title: 'Igual' });
    const result = updateDocumentHeader(document, { title: 'Igual' }, stamp);
    expect(result.document).toBe(document);
    expect(result.changes).toEqual([]);
  });

  it.each(others(['DRAFT', 'RETURNED']))('%s → NOT_EDITABLE', (status) => {
    expect(
      refusal(() => updateDocumentHeader(inStatus(status), { title: 'Novo título' }, stamp))
        .failure,
    ).toBe('NOT_EDITABLE');
  });
});

describe('allowedActions (RN-DOC-18 · POL-02/POL-11)', () => {
  const everything: DocumentActor = {
    canEditType: true,
    canSubmitType: true,
    canReopen: true,
    canCancel: true,
    isCustodian: true,
    isCollaborator: false,
  };
  const editable: DocumentProcessState = { status: 'IN_PROGRESS', typeAllowedInStage: true };
  const actions = (
    document: Document,
    actor: Partial<DocumentActor> = {},
    process: Partial<DocumentProcessState> = {},
    type = WITHOUT_APPROVAL,
  ) =>
    allowedDocumentActions(
      document,
      type,
      { ...everything, ...actor },
      { ...editable, ...process },
    );

  it('rascunho nunca submetido, custodiante com todas as permissões', () => {
    expect(actions(inStatus('DRAFT'))).toEqual(['UPDATE', 'FINALIZE', 'CANCEL', 'DELETE']);
    expect(actions(inStatus('DRAFT'), {}, {}, WITH_APPROVAL)).toEqual([
      'UPDATE',
      'SUBMIT',
      'CANCEL',
      'DELETE',
    ]);
  });

  it('devolvido: edita, conclui e cancela, mas não exclui', () => {
    expect(actions(inStatus('RETURNED', { submittedAt: FIXTURE_NOW }))).toEqual([
      'UPDATE',
      'FINALIZE',
      'CANCEL',
    ]);
  });

  it('finalizado/aprovado/indeferido: só reabrir; com aprovação pendente, nada', () => {
    for (const status of ['FINALIZED', 'APPROVED', 'REJECTED'] as const) {
      expect(actions(inStatus(status))).toEqual(['REOPEN']);
      expect(actions(inStatus(status, { pendingApprovalId: 'apv' }))).toEqual([]);
    }
    expect(actions(inStatus('IN_REVIEW'))).toEqual([]);
    expect(actions(inStatus('CANCELED'))).toEqual([]);
  });

  it('colaborador (sem custódia) edita e conclui, mas não reabre nem cancela', () => {
    const collaborator = { isCustodian: false, isCollaborator: true };
    expect(actions(inStatus('DRAFT'), collaborator)).toEqual(['UPDATE', 'FINALIZE', 'DELETE']);
    expect(actions(inStatus('FINALIZED'), collaborator)).toEqual([]);
  });

  it('sem custódia nem participação, nenhuma ação', () => {
    expect(actions(inStatus('DRAFT'), { isCustodian: false })).toEqual([]);
  });

  it('cada ação depende da sua permissão', () => {
    expect(actions(inStatus('DRAFT'), { canEditType: false })).toEqual(['FINALIZE', 'CANCEL']);
    expect(actions(inStatus('DRAFT'), { canSubmitType: false, canCancel: false })).toEqual([
      'UPDATE',
      'DELETE',
    ]);
    expect(actions(inStatus('APPROVED'), { canReopen: false })).toEqual([]);
  });

  it('processo fora de DRAFT/IN_PROGRESS/RETURNED ou tipo fora da etapa bloqueia', () => {
    expect(actions(inStatus('DRAFT'), {}, { status: 'SUSPENDED' })).toEqual([]);
    expect(actions(inStatus('DRAFT'), {}, { typeAllowedInStage: false })).toEqual(['CANCEL']);
    expect(actions(inStatus('FINALIZED'), {}, { typeAllowedInStage: false })).toEqual([]);
  });

  it('documento excluído não tem ações', () => {
    expect(actions(inStatus('DRAFT', { deletedAt: FIXTURE_NOW }))).toEqual([]);
  });
});
