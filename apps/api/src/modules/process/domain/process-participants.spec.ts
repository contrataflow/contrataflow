import { describe, expect, it } from 'vitest';

import { participationAppliesTo } from '#shared/auth/process-access.js';

import {
  compareParticipants,
  grantRefusal,
  isParticipationExpired,
  newParticipant,
  revokedParticipant,
  toParticipation,
  unfollowDecision,
} from './process-participants.js';
import type { GrantTarget, ProcessParticipant } from './process-participants.js';

/*
 * US-012 — regras puras de participantes (RN-PROC-126..135 · POL-10): elegibilidade por papel,
 * autoinclusão, referência inválida, validade, "deixar de seguir" e a participação que vale para
 * a autorização (usuário ou unidade de lotação, não vencida).
 */

const NOW = new Date('2026-10-17T12:00:00.000Z');
const CARLA = '0192d012-0000-7000-8000-0000000000a1';
const DIEGO = '0192d012-0000-7000-8000-0000000000a2';
const ELISA = '0192d012-0000-7000-8000-0000000000a3';
const UNIT = '0192d012-0000-7000-8000-0000000000d1';
const TOMORROW = new Date('2026-10-18T12:00:00.000Z');
const YESTERDAY = new Date('2026-10-16T12:00:00.000Z');

const internal = (userId: string): GrantTarget => ({
  kind: 'USER',
  userId,
  membership: { type: 'INTERNAL', status: 'ACTIVE', expiresAt: null },
});
const external = (expiresAt: Date | null = new Date('2026-12-31T00:00:00Z')): GrantTarget => ({
  kind: 'USER',
  userId: DIEGO,
  membership: { type: 'EXTERNAL', status: 'ACTIVE', expiresAt },
});
const unit = (isActive: boolean | null = true): GrantTarget => ({
  kind: 'DEPARTMENT',
  departmentId: UNIT,
  isActive,
});

describe('grantRefusal (RN-PROC-126..128 · POL-10)', () => {
  const request = (role: ProcessParticipant['role'], expiresAt: Date | null = null) => ({
    role,
    expiresAt,
    actorUserId: CARLA,
  });

  it('colaborador interno, observador de unidade e consultor externo dentro do vínculo: concede', () => {
    expect(grantRefusal(internal(ELISA), request('COLLABORATOR'), NOW)).toBeNull();
    expect(grantRefusal(unit(), request('OBSERVER'), NOW)).toBeNull();
    expect(grantRefusal(external(), request('CONSULTANT', TOMORROW), NOW)).toBeNull();
    // Vínculo externo sem prazo também comporta qualquer validade futura.
    expect(grantRefusal(external(null), request('CONSULTANT', TOMORROW), NOW)).toBeNull();
  });

  it('V-04: consultor para unidade, sem vínculo EXTERNAL ou além da validade do vínculo', () => {
    expect(grantRefusal(unit(), request('CONSULTANT', TOMORROW), NOW)).toEqual({
      kind: 'NOT_ELIGIBLE',
      reason: 'CONSULTANT_DEPARTMENT',
    });
    expect(grantRefusal(internal(ELISA), request('CONSULTANT', TOMORROW), NOW)).toEqual({
      kind: 'NOT_ELIGIBLE',
      reason: 'NOT_EXTERNAL',
    });
    expect(
      grantRefusal(
        external(new Date('2026-10-20T00:00:00Z')),
        request('CONSULTANT', new Date('2026-11-01T00:00:00Z')),
        NOW,
      ),
    ).toEqual({ kind: 'NOT_ELIGIBLE', reason: 'EXPIRES_AFTER_MEMBERSHIP' });
  });

  it('V-05: ninguém se inclui como Colaborador/Consultor; como Observador, pode', () => {
    expect(grantRefusal(internal(CARLA), request('COLLABORATOR'), NOW)).toEqual({
      kind: 'NOT_ELIGIBLE',
      reason: 'SELF',
    });
    expect(grantRefusal(internal(CARLA), request('OBSERVER'), NOW)).toBeNull();
  });

  it('V-06: alvo inexistente/de outro tenant, inativo, vencido ou de serviço', () => {
    expect(
      grantRefusal({ kind: 'USER', userId: ELISA, membership: null }, request('OBSERVER'), NOW),
    ).toEqual({ kind: 'INVALID_REFERENCE', field: 'userId', code: 'REFERENCE_NOT_FOUND' });
    expect(
      grantRefusal(
        {
          kind: 'USER',
          userId: ELISA,
          membership: { type: 'SERVICE', status: 'ACTIVE', expiresAt: null },
        },
        request('OBSERVER'),
        NOW,
      ),
    ).toEqual({ kind: 'INVALID_REFERENCE', field: 'userId', code: 'REFERENCE_NOT_FOUND' });
    expect(
      grantRefusal(
        {
          kind: 'USER',
          userId: ELISA,
          membership: { type: 'INTERNAL', status: 'SUSPENDED', expiresAt: null },
        },
        request('OBSERVER'),
        NOW,
      ),
    ).toEqual({ kind: 'INVALID_REFERENCE', field: 'userId', code: 'REFERENCE_INACTIVE' });
    expect(grantRefusal(external(YESTERDAY), request('CONSULTANT', TOMORROW), NOW)).toEqual({
      kind: 'INVALID_REFERENCE',
      field: 'userId',
      code: 'REFERENCE_INACTIVE',
    });
    expect(grantRefusal(unit(null), request('OBSERVER'), NOW)).toEqual({
      kind: 'INVALID_REFERENCE',
      field: 'departmentId',
      code: 'REFERENCE_NOT_FOUND',
    });
    expect(grantRefusal(unit(false), request('OBSERVER'), NOW)).toEqual({
      kind: 'INVALID_REFERENCE',
      field: 'departmentId',
      code: 'REFERENCE_INACTIVE',
    });
  });

  it('validade no passado (ou agora) é recusada', () => {
    expect(grantRefusal(external(), request('CONSULTANT', YESTERDAY), NOW)).toEqual({
      kind: 'EXPIRES_IN_PAST',
    });
    expect(grantRefusal(external(), request('CONSULTANT', NOW), NOW)).toEqual({
      kind: 'EXPIRES_IN_PAST',
    });
  });
});

describe('ciclo da participação (RN-PROC-129/133/134/135)', () => {
  const base = newParticipant({
    id: '0192d012-0000-7000-8000-0000000000f1',
    tenantId: '0192d012-0000-7000-8000-00000000000a',
    processId: '0192d012-0000-7000-8000-0000000000b1',
    target: { userId: ELISA },
    role: 'COLLABORATOR',
    notify: true,
    expiresAt: TOMORROW,
    reason: 'Parecer pontual',
    grantedById: CARLA,
    now: NOW,
  });

  it('só o consultor guarda validade; a revogação registra quando, quem e o motivo', () => {
    expect(base).toMatchObject({ userId: ELISA, departmentId: null, expiresAt: null });
    const consultant = newParticipant({
      id: '0192d012-0000-7000-8000-0000000000f2',
      tenantId: base.tenantId,
      processId: base.processId,
      target: { departmentId: UNIT },
      role: 'CONSULTANT',
      notify: false,
      expiresAt: TOMORROW,
      reason: null,
      grantedById: CARLA,
      now: NOW,
    });
    expect(consultant).toMatchObject({ userId: null, departmentId: UNIT, expiresAt: TOMORROW });
    expect(revokedParticipant(base, { at: NOW, byUserId: null, reason: 'fim' })).toMatchObject({
      revokedAt: NOW,
      revokedById: null,
      revocationReason: 'fim',
    });
  });

  it('expiração e participação que vale para o usuário ou a unidade de lotação', () => {
    expect(isParticipationExpired({ expiresAt: YESTERDAY }, NOW)).toBe(true);
    expect(isParticipationExpired({ expiresAt: null }, NOW)).toBe(false);
    const viewer = { userId: ELISA, ownDepartmentIds: [UNIT] };
    expect(participationAppliesTo(toParticipation(base), viewer, NOW)).toBe(true);
    expect(
      participationAppliesTo(
        { userId: null, departmentId: UNIT, role: 'OBSERVER', expiresAt: null },
        { userId: DIEGO, ownDepartmentIds: [UNIT] },
        NOW,
      ),
    ).toBe(true);
    expect(
      participationAppliesTo(
        { userId: DIEGO, role: 'CONSULTANT', expiresAt: YESTERDAY },
        { userId: DIEGO, ownDepartmentIds: [] },
        NOW,
      ),
    ).toBe(false);
    expect(
      participationAppliesTo(toParticipation(base), { userId: DIEGO, ownDepartmentIds: [] }, NOW),
    ).toBe(false);
  });

  it('deixar de seguir: sem participação = no-op; só OBSERVER sai sozinho', () => {
    expect(unfollowDecision(null)).toBe('NOOP');
    expect(unfollowDecision({ role: 'OBSERVER' })).toBe('REVOKE');
    expect(unfollowDecision({ role: 'COLLABORATOR' })).toBe('NOT_OBSERVER');
  });

  it('ordem da lista: concessão mais antiga primeiro', () => {
    const later = { ...base, id: '0192d012-0000-7000-8000-0000000000f0', grantedAt: TOMORROW };
    expect([later, base].sort(compareParticipants).map((row) => row.id)).toEqual([
      base.id,
      later.id,
    ]);
  });
});
