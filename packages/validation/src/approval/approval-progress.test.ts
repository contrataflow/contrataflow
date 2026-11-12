import { describe, expect, it } from 'vitest';

import {
  APPROVAL_MY_LINE_STATUSES,
  approvalLineCountsOf,
  approvalLineSituationOf,
  approvalProgressLabelOf,
  approvalProgressOf,
} from './approval-progress.js';

/* US-136 — andamento (RN-APV-67/70) e situação das linhas (RN-APV-71). */

const counts = (totalLines: number, approvedLines = 0, pendingLines = 0, waitingLines = 0) => ({
  totalLines,
  approvedLines,
  pendingLines,
  waitingLines,
});

describe('approvalLineCountsOf (RN-APV-67)', () => {
  it('conta só as linhas vigentes (as CANCELED ficam de fora)', () => {
    expect(
      approvalLineCountsOf([
        { sequence: 1, status: 'APPROVED' },
        { sequence: 2, status: 'CANCELED' },
        { sequence: 2, status: 'PENDING' },
        { sequence: 3, status: 'WAITING' },
      ]),
    ).toEqual(counts(3, 1, 1, 1));
  });
});

describe('approvalProgressLabelOf (RN-APV-70)', () => {
  const pending = (
    policy: 'ANY' | 'ALL' | 'SEQUENTIAL',
    c: ReturnType<typeof counts>,
    current: { sequence: number; label: string } | null = null,
  ) => approvalProgressLabelOf({ policy, approvalStatus: 'PENDING', counts: c, current });

  it('ALL: "{aprovadas} de {total} aprovaram"', () => {
    expect(pending('ALL', counts(3, 1, 2))).toBe('1 de 3 aprovaram');
  });

  it('SEQUENTIAL: "Etapa {n} de {total} — {rótulo}"', () => {
    expect(
      pending('SEQUENTIAL', counts(2, 0, 1, 1), {
        sequence: 1,
        label: 'Secretário de Administração',
      }),
    ).toBe('Etapa 1 de 2 — Secretário de Administração');
  });

  it('ANY: várias linhas "Qualquer um dos N aprovadores"; uma linha, ausente (MVP 1)', () => {
    expect(pending('ANY', counts(3, 0, 3))).toBe('Qualquer um dos 3 aprovadores');
    expect(pending('ANY', counts(1, 0, 1))).toBeUndefined();
    expect(
      approvalProgressOf({
        policy: 'ANY',
        approvalStatus: 'APPROVED',
        counts: counts(1, 1),
        current: null,
      }),
    ).toEqual(counts(1, 1));
  });

  it('Encerrada: "Encerrada — {resultado}"', () => {
    expect(
      approvalProgressLabelOf({
        policy: 'ALL',
        approvalStatus: 'RETURNED',
        counts: counts(2, 0),
        current: null,
      }),
    ).toBe('Encerrada — devolvida');
  });
});

describe('approvalLineSituationOf (RN-APV-71)', () => {
  it('texto por estado, com o motivo da dispensa; a substituída por redirecionamento', () => {
    expect(approvalLineSituationOf('WAITING', null)).toBe('Aguardando a vez');
    expect(approvalLineSituationOf('PENDING', null)).toBe('Pendente');
    expect(approvalLineSituationOf('APPROVED', null)).toBe('Aprovou');
    expect(approvalLineSituationOf('SKIPPED', 'NEGATIVE_DECISION')).toBe(
      'Dispensada — encerrada por decisão negativa',
    );
    expect(approvalLineSituationOf('SKIPPED', 'ANY_DECIDED')).toBe(
      'Dispensada — decidida por outro aprovador',
    );
    expect(approvalLineSituationOf('CANCELED', 'REASSIGNED')).toBe('Substituída');
    expect(approvalLineSituationOf('CANCELED', 'WITHDRAWN')).toBe('Cancelada');
  });

  it('"Minha situação" não filtra CANCELED', () => {
    expect(APPROVAL_MY_LINE_STATUSES).not.toContain('CANCELED');
  });
});
