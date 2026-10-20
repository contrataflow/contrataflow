import { describe, expect, it } from 'vitest';

import { TENANT_TRANSITIONS, TenantTransitionError, canTransition, transition } from './tenant.js';
import type { TenantAction, TenantStatus } from './tenant.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ACTIVATED = new Date('2026-01-10T09:00:00.000Z');
const STATUSES: readonly TenantStatus[] = [
  'PROVISIONING',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDING',
  'DEACTIVATED',
];
const ACTIONS = Object.keys(TENANT_TRANSITIONS) as TenantAction[];

/** RN-TEN-09 como tabela: (origem, ação) → destino. */
const VALID: readonly [TenantStatus, TenantAction, TenantStatus][] = [
  ['PROVISIONING', 'ACTIVATE', 'ACTIVE'],
  ['SUSPENDED', 'ACTIVATE', 'ACTIVE'],
  ['OFFBOARDING', 'ACTIVATE', 'ACTIVE'],
  ['ACTIVE', 'SUSPEND', 'SUSPENDED'],
  ['ACTIVE', 'OFFBOARD', 'OFFBOARDING'],
  ['SUSPENDED', 'OFFBOARD', 'OFFBOARDING'],
  ['OFFBOARDING', 'DEACTIVATE', 'DEACTIVATED'],
  ['PROVISIONING', 'DEACTIVATE', 'DEACTIVATED'],
];

describe('máquina de estados do Tenant (RN-TEN-09)', () => {
  it.each(VALID)('%s --%s--> %s', (from, action, to) => {
    expect(canTransition(from, action)).toBe(true);
    const patch = transition({ status: from, activatedAt: null }, action, {
      now: NOW,
      reason: 'Contrato com pagamento em atraso',
    });
    expect(patch.status).toBe(to);
  });

  const invalid = STATUSES.flatMap((from) =>
    ACTIONS.filter((action) => !VALID.some(([f, a]) => f === from && a === action)).map(
      (action) => [from, action] as const,
    ),
  );

  it.each(invalid)('%s não aceita %s (409 INVALID_STATE)', (from, action) => {
    expect(canTransition(from, action)).toBe(false);
    expect(() =>
      transition({ status: from, activatedAt: null }, action, { now: NOW, reason: 'motivo longo' }),
    ).toThrow(TenantTransitionError);
  });

  it('DEACTIVATED é final', () => {
    expect(ACTIONS.some((action) => canTransition('DEACTIVATED', action))).toBe(false);
  });

  it('reativação preserva o activatedAt original e limpa suspensão e encerramento', () => {
    expect(
      transition({ status: 'SUSPENDED', activatedAt: ACTIVATED }, 'ACTIVATE', { now: NOW }),
    ).toEqual({
      status: 'ACTIVE',
      activatedAt: ACTIVATED,
      suspendedAt: null,
      suspensionReason: null,
      offboardingStartedAt: null,
      offboardingEndsAt: null,
    });
  });

  it('primeira ativação grava activatedAt = agora', () => {
    expect(
      transition({ status: 'PROVISIONING', activatedAt: null }, 'ACTIVATE', { now: NOW })
        .activatedAt,
    ).toBe(NOW);
  });

  it('suspensão grava data e motivo; sem motivo é erro de programação', () => {
    expect(
      transition({ status: 'ACTIVE', activatedAt: ACTIVATED }, 'SUSPEND', {
        now: NOW,
        reason: 'Contrato com pagamento em atraso',
      }),
    ).toEqual({
      status: 'SUSPENDED',
      suspendedAt: NOW,
      suspensionReason: 'Contrato com pagamento em atraso',
    });
    expect(() =>
      transition({ status: 'ACTIVE', activatedAt: ACTIVATED }, 'SUSPEND', { now: NOW }),
    ).toThrow(/motivo/);
  });

  it('encerramento e desativação marcam as datas sem excluir nada', () => {
    expect(
      transition({ status: 'ACTIVE', activatedAt: ACTIVATED }, 'OFFBOARD', { now: NOW }),
    ).toEqual({
      status: 'OFFBOARDING',
      offboardingStartedAt: NOW,
      offboardingEndsAt: new Date('2027-01-04T12:00:00.000Z'),
    });
    const until = new Date('2026-12-31T23:59:59.000Z');
    expect(
      transition({ status: 'SUSPENDED', activatedAt: ACTIVATED }, 'OFFBOARD', {
        now: NOW,
        offboardingEndsAt: until,
      }).offboardingEndsAt,
    ).toBe(until);
    expect(
      transition({ status: 'OFFBOARDING', activatedAt: ACTIVATED }, 'DEACTIVATE', { now: NOW }),
    ).toEqual({ status: 'DEACTIVATED', deactivatedAt: NOW });
  });
});
