import type { MovementItemDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTER_OPTIONS,
  EMPTY_MOVEMENT_FILTERS,
  activeFilterCount,
  hasActiveFilters,
  isMovementPeriodInverted,
  mergeFilterOptions,
  movementQueryOf,
  statusChanged,
} from './movements-model';

const UNIT_A = '0192f054-0000-7000-8000-0000000000a1';
const UNIT_B = '0192f054-0000-7000-8000-0000000000a2';
const ANA = '0192f054-0000-7000-8000-0000000000c1';

function item(patch: Partial<MovementItemDto> = {}): MovementItemDto {
  return {
    id: '0192f054-0000-7000-8000-000000000001',
    sequence: 1,
    action: 'FORWARD',
    fromStage: null,
    toStage: null,
    fromDepartment: { id: UNIT_B, name: 'Setor de Manutenção', isActive: true },
    toDepartment: { id: UNIT_A, name: 'Almoxarifado', isActive: false },
    fromUser: null,
    toUser: null,
    statusFrom: 'IN_PROGRESS',
    statusTo: 'IN_PROGRESS',
    actor: { type: 'USER', id: ANA, name: 'Ana Souza', departmentName: null },
    comment: null,
    dueAt: null,
    documents: [],
    approvalId: null,
    approvalSummary: null,
    occurredAt: '2026-10-01T12:00:00.000Z',
    ip: null,
    userAgent: null,
    correlationId: 'c',
    ...patch,
  };
}

describe('Aba "Tramitação" — modelo (US-054)', () => {
  it('sem filtros: query vazia e nenhum filtro ativo', () => {
    expect(movementQueryOf(EMPTY_MOVEMENT_FILTERS, 'America/Sao_Paulo')).toEqual({
      action: undefined,
      fromDepartmentId: undefined,
      toDepartmentId: undefined,
      actorId: undefined,
      occurredFrom: undefined,
      occurredTo: undefined,
    });
    expect(hasActiveFilters(EMPTY_MOVEMENT_FILTERS)).toBe(false);
  });

  it('ações por vírgula (OU) e período local convertido para instantes UTC inclusivos', () => {
    const filters = {
      ...EMPTY_MOVEMENT_FILTERS,
      actions: ['FORWARD', 'RETURN'] as const,
      toDepartmentId: UNIT_A,
      actorId: ANA,
      from: '2026-10-01',
      to: '2026-10-01',
    };
    expect(movementQueryOf(filters, 'America/Sao_Paulo')).toEqual({
      action: 'FORWARD,RETURN',
      fromDepartmentId: undefined,
      toDepartmentId: UNIT_A,
      actorId: ANA,
      occurredFrom: '2026-10-01T03:00:00.000Z',
      occurredTo: '2026-10-02T02:59:59.999Z',
    });
    expect(activeFilterCount(filters)).toBe(6);
  });

  it('V-02: período inicial posterior ao final', () => {
    expect(isMovementPeriodInverted({ from: '2026-10-05', to: '2026-10-01' })).toBe(true);
    expect(isMovementPeriodInverted({ from: '2026-10-01', to: '2026-10-01' })).toBe(false);
    expect(isMovementPeriodInverted({ from: '', to: '2026-10-01' })).toBe(false);
  });

  it('opções de unidade e ator: as já vistas, sem repetir, em ordem alfabética; sistema fora', () => {
    const first = mergeFilterOptions(EMPTY_FILTER_OPTIONS, [item()]);
    expect(first.departments.map((option) => option.name)).toEqual([
      'Almoxarifado',
      'Setor de Manutenção',
    ]);
    expect(first.actors).toEqual([{ id: ANA, name: 'Ana Souza' }]);
    const again = mergeFilterOptions(first, [
      item({
        actor: { type: 'SYSTEM', id: null, name: null, departmentName: null },
        toDepartment: { id: UNIT_A, name: null, isActive: true },
      }),
    ]);
    expect(again).toEqual(first);
  });

  it('statusChanged: só quando o status de destino difere do de origem', () => {
    expect(statusChanged(item())).toBe(false);
    expect(statusChanged(item({ statusFrom: null, statusTo: 'DRAFT' }))).toBe(true);
    expect(statusChanged(item({ statusTo: 'RETURNED' }))).toBe(true);
    expect(statusChanged(item({ statusTo: null }))).toBe(false);
  });
});
