import type { ChecklistViolation, ProcessStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  acknowledgedWarningsOf,
  blockingViolations,
  canForwardInStatus,
  changedDuringPass,
  chosenDepartmentIssue,
  coveredDocuments,
  destinationDecision,
  isEligibleAssignee,
  movementDocumentIds,
  movementDocumentRefs,
  notForwardableMessage,
  statusOnEntering,
  unacknowledgedWarnings,
  unknownDocumentIndexes,
} from './process-forward.js';
import type { AssigneeFacts, ForwardDocumentFact } from './process-forward.js';

/*
 * US-047 — regras puras do encaminhamento (RN-TRAM-02/05..08/12/13): status, bloqueios e avisos
 * reconhecidos (DEC-016), unidade e responsável de destino e os documentos da tramitação.
 */

const ORG = '0192d047-0000-7000-8000-0000000000a0';
const COMPRAS = '0192d047-0000-7000-8000-0000000000a1';
const OTHER = '0192d047-0000-7000-8000-0000000000a2';
const RULE_ETP = '0192d047-0000-7000-8000-0000000000b1';
const RULE_RISK = '0192d047-0000-7000-8000-0000000000b2';
const NOW = new Date('2026-10-05T15:00:00.000Z');

function violation(
  ruleId: string,
  severity: 'BLOCKING' | 'WARNING',
  message: string,
): ChecklistViolation {
  return {
    code: 'WORKFLOW_RULE',
    severity,
    message,
    ruleId,
    sectionKey: null,
    field: null,
    itemId: null,
    params: {},
    name: message,
    type: 'REQUIRED_DOCUMENT',
    satisfied: false,
    scope: 'STAGE_EXIT',
  };
}

function document(overrides: Partial<ForwardDocumentFact> = {}): ForwardDocumentFact {
  return {
    id: '0192d047-0000-7000-8000-0000000000c1',
    typeCode: 'ETP',
    code: 'ETP 0003/2026',
    title: 'Estudo técnico preliminar',
    status: 'FINALIZED',
    currentVersionId: '0192d047-0000-7000-8000-0000000000d1',
    currentVersionNumber: 2,
    updatedAt: new Date('2026-10-04T12:00:00.000Z'),
    ...overrides,
  };
}

const eligible: AssigneeFacts = {
  membershipStatus: 'ACTIVE',
  membershipExpiresAt: null,
  assignedToDepartment: true,
  canViewProcesses: true,
};

describe('Feature: Encaminhar processo — regras puras (US-047)', () => {
  describe('RN-TRAM-02 · RN-TRAM-13: status', () => {
    it.each<[ProcessStatus, boolean]>([
      ['DRAFT', true],
      ['IN_PROGRESS', true],
      ['RETURNED', true],
      ['AWAITING_APPROVAL', false],
      ['SUSPENDED', false],
      ['CANCELED', false],
      ['COMPLETED', false],
      ['PUBLISHED', false],
    ])('%s pode ser encaminhado? %s', (status, expected) => {
      expect(canForwardInStatus(status)).toBe(expected);
    });

    it('mensagem do 409 com o status em pt-BR', () => {
      expect(notForwardableMessage('SUSPENDED')).toBe(
        'O processo está suspenso e não pode ser encaminhado.',
      );
    });

    it('destino APPROVAL aguarda aprovação; START/TASK ficam em andamento (DEC-013)', () => {
      expect(statusOnEntering('APPROVAL')).toBe('AWAITING_APPROVAL');
      expect(statusOnEntering('TASK')).toBe('IN_PROGRESS');
      expect(statusOnEntering('START')).toBe('IN_PROGRESS');
    });
  });

  describe('RN-TRAM-05/06: bloqueios e avisos reconhecidos', () => {
    const violations = [
      violation(RULE_ETP, 'BLOCKING', 'O ETP deve estar completo.'),
      violation(RULE_RISK, 'WARNING', 'Recomenda-se elaborar o mapa de riscos.'),
    ];

    it('só as BLOCKING impedem', () => {
      expect(blockingViolations(violations).map((item) => item.ruleId)).toEqual([RULE_ETP]);
    });

    it('aviso não reconhecido falta; ids extras são ignorados', () => {
      expect(unacknowledgedWarnings(violations, []).map((item) => item.ruleId)).toEqual([
        RULE_RISK,
      ]);
      expect(unacknowledgedWarnings(violations, [RULE_RISK, OTHER])).toEqual([]);
    });

    it('os reconhecidos ficam com id e mensagem da regra (DEC-016)', () => {
      expect(acknowledgedWarningsOf(violations, [RULE_RISK, OTHER])).toEqual([
        { ruleId: RULE_RISK, message: 'Recomenda-se elaborar o mapa de riscos.' },
      ]);
    });
  });

  describe('RN-TRAM-07: unidade de destino', () => {
    it('FIXED/REQUESTING_* usam a resolvida; enviar a mesma é aceito', () => {
      expect(destinationDecision('FIXED', COMPRAS, null)).toEqual({
        kind: 'RESOLVED',
        departmentId: COMPRAS,
      });
      expect(destinationDecision('REQUESTING_DEPARTMENT', COMPRAS, COMPRAS)).toEqual({
        kind: 'RESOLVED',
        departmentId: COMPRAS,
      });
    });

    it('unidade enviada diferente da resolvida → MISMATCH; FIXED sem unidade → UNRESOLVED', () => {
      expect(destinationDecision('FIXED', COMPRAS, OTHER)).toEqual({ kind: 'MISMATCH' });
      expect(destinationDecision('FIXED', null, null)).toEqual({ kind: 'UNRESOLVED' });
    });

    it('CHOSEN_ON_FORWARD exige a unidade (DEPARTMENT_REQUIRED)', () => {
      expect(destinationDecision('CHOSEN_ON_FORWARD', null, null)).toEqual({ kind: 'REQUIRED' });
      expect(destinationDecision('CHOSEN_ON_FORWARD', null, OTHER)).toEqual({
        kind: 'RESOLVED',
        departmentId: OTHER,
      });
    });

    it('unidade escolhida: inexistente/de outro órgão = REFERENCE_NOT_FOUND; inativa = REFERENCE_INACTIVE', () => {
      expect(chosenDepartmentIssue(null, ORG)).toBe('REFERENCE_NOT_FOUND');
      expect(chosenDepartmentIssue({ organizationId: OTHER, isActive: true }, ORG)).toBe(
        'REFERENCE_NOT_FOUND',
      );
      expect(chosenDepartmentIssue({ organizationId: ORG, isActive: false }, ORG)).toBe(
        'REFERENCE_INACTIVE',
      );
      expect(chosenDepartmentIssue({ organizationId: ORG, isActive: true }, ORG)).toBeNull();
    });
  });

  describe('RN-TRAM-08: elegibilidade do responsável', () => {
    it('vínculo ativo não vencido, lotado no destino e com PROCESS_VIEW', () => {
      expect(isEligibleAssignee(eligible, NOW)).toBe(true);
    });

    it.each<[string, AssigneeFacts | null]>([
      ['sem vínculo no tenant', null],
      ['vínculo suspenso', { ...eligible, membershipStatus: 'SUSPENDED' }],
      ['vínculo vencido', { ...eligible, membershipExpiresAt: new Date('2026-10-01T00:00:00Z') }],
      ['não lotado no destino', { ...eligible, assignedToDepartment: false }],
      ['sem PROCESS_VIEW', { ...eligible, canViewProcesses: false }],
    ])('inelegível: %s', (_case, facts) => {
      expect(isEligibleAssignee(facts, NOW)).toBe(false);
    });

    it('vínculo com validade futura é elegível', () => {
      expect(
        isEligibleAssignee({ ...eligible, membershipExpiresAt: new Date('2027-01-01Z') }, NOW),
      ).toBe(true);
    });
  });

  describe('RN-TRAM-12: documentos que acompanham a tramitação', () => {
    const enteredAt = new Date('2026-10-03T12:00:00.000Z');
    const etp = document();
    const old = document({
      id: '0192d047-0000-7000-8000-0000000000c2',
      typeCode: 'DFD',
      updatedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const canceled = document({ id: '0192d047-0000-7000-8000-0000000000c3', status: 'CANCELED' });

    it('padrão: os alterados durante a passagem atual, exceto cancelados', () => {
      expect(changedDuringPass([etp, old, canceled], enteredAt)).toEqual([etp.id]);
    });

    it('ids que não são documentos do processo (V-04) — pela posição', () => {
      expect(unknownDocumentIndexes([etp.id, OTHER], [etp, old])).toEqual([1]);
    });

    it('cobertos entram junto, sem repetição', () => {
      expect(movementDocumentIds([etp.id], [old.id, etp.id])).toEqual([etp.id, old.id]);
    });

    it('MovementDocumentRef com status e versão (entities.md §5.6)', () => {
      expect(movementDocumentRefs([etp.id, OTHER], [etp])).toEqual([
        {
          documentId: etp.id,
          documentVersionId: etp.currentVersionId,
          versionNumber: 2,
          code: 'ETP 0003/2026',
          title: 'Estudo técnico preliminar',
          documentTypeCode: 'ETP',
          status: 'FINALIZED',
        },
      ]);
    });

    it('cobertos da etapa APPROVAL: dos tipos configurados, não cancelados (RN-TRAM-44)', () => {
      expect(coveredDocuments([etp, old, canceled], ['DFD', 'ETP']).map((item) => item.id)).toEqual(
        [etp.id, old.id],
      );
    });
  });
});
