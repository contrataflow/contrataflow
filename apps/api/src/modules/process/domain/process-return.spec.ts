import { PROCESS_STATUSES } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  canReturnInStatus,
  resolvePreviousAssignee,
  returnDepartmentOf,
} from './process-return.js';

/*
 * US-048 — regras puras da devolução: status (RN-TRAM-23), `PREVIOUS_ASSIGNEE` (RN-TRAM-28) e a
 * unidade da etapa de destino (RN-TRAM-27).
 */

const at = (iso: string) => new Date(iso);

describe('Feature: Devolver processo (domínio)', () => {
  it('RN-TRAM-23: só IN_PROGRESS pode ser devolvido por esta ação', () => {
    expect(PROCESS_STATUSES.filter(canReturnInStatus)).toEqual(['IN_PROGRESS']);
  });

  describe('RN-TRAM-28 — PREVIOUS_ASSIGNEE', () => {
    it('responsável da responsabilidade mais recente (maior startedAt), em qualquer ordem', () => {
      expect(
        resolvePreviousAssignee([
          { assigneeId: 'ana', startedAt: at('2026-10-01T10:00:00Z') },
          { assigneeId: 'bia', startedAt: at('2026-10-03T10:00:00Z') },
          { assigneeId: 'caio', startedAt: at('2026-10-02T10:00:00Z') },
        ]),
      ).toBe('bia');
    });

    it('ignora responsabilidades de fila (assigneeId null) mais recentes', () => {
      expect(
        resolvePreviousAssignee([
          { assigneeId: 'ana', startedAt: at('2026-10-01T10:00:00Z') },
          { assigneeId: null, startedAt: at('2026-10-05T10:00:00Z') },
        ]),
      ).toBe('ana');
    });

    it('FA-01: sem histórico individual → fila da unidade (null)', () => {
      expect(resolvePreviousAssignee([])).toBeNull();
      expect(
        resolvePreviousAssignee([{ assigneeId: null, startedAt: at('2026-10-01T10:00:00Z') }]),
      ).toBeNull();
    });
  });

  describe('RN-TRAM-27 — unidade da etapa de destino', () => {
    it('FIXED/REQUESTING_* usam a unidade recalculada pelo workflow', () => {
      expect(returnDepartmentOf('FIXED', 'compras', 'antiga')).toBe('compras');
      expect(returnDepartmentOf('REQUESTING_DEPARTMENT', 'setor', 'antiga')).toBe('setor');
      expect(returnDepartmentOf('REQUESTING_SECRETARIAT', null, 'antiga')).toBeNull();
    });

    it('CHOSEN_ON_FORWARD reaproveita a unidade da última passagem', () => {
      expect(returnDepartmentOf('CHOSEN_ON_FORWARD', null, 'planejamento')).toBe('planejamento');
    });
  });
});
