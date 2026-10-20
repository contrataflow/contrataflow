import type { UserLookupItem } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  EMPTY_PARTICIPANT_FORM,
  followStateOf,
  participantBodyOf,
  participantProblemOf,
  validateParticipant,
  withTargetType,
  withUser,
} from './process-participants-model';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const ELISA: UserLookupItem = {
  id: '0192a000-0000-7000-8000-0000000000e1',
  name: 'Elisa Melo',
  email: 'elisa@a.test',
  membershipType: 'INTERNAL',
  membershipExpiresAt: null,
};
const DIEGO: UserLookupItem = {
  id: '0192a000-0000-7000-8000-0000000000d1',
  name: 'Diego Alves',
  email: 'diego@consultoria.test',
  membershipType: 'EXTERNAL',
  membershipExpiresAt: '2026-12-31T00:00:00.000Z',
};
const UNIT = {
  id: '0192a000-0000-7000-8000-0000000000f1',
  name: 'Secretaria de Saúde',
  type: 'SECRETARIAT' as const,
  path: '/x/',
};

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new ApiError({
    status,
    code,
    detail: 'detalhe',
    problem: {
      type: 'https://docs.contrataflow.com.br/errors/x',
      title: 't',
      status,
      detail: 'detalhe',
      instance: '/x',
      code,
      correlationId: 'c',
      errors: [],
      violations: [],
      ...extra,
    },
  });
}

describe('diálogo "Adicionar participante" (US-012)', () => {
  it('vínculo externo sugere Consultor; voltar para interno volta a Observador; unidade nunca é Consultor', () => {
    const external = withUser(EMPTY_PARTICIPANT_FORM, DIEGO);
    expect(external.role).toBe('CONSULTANT');
    expect(withUser(external, ELISA).role).toBe('OBSERVER');
    expect(withUser({ ...EMPTY_PARTICIPANT_FORM, role: 'COLLABORATOR' }, ELISA).role).toBe(
      'COLLABORATOR',
    );
    expect(withTargetType(external, 'DEPARTMENT')).toMatchObject({
      targetType: 'DEPARTMENT',
      user: null,
      role: 'OBSERVER',
    });
  });

  it('V-01..V-04 no cliente: alvo, consultor sem validade, vencida, além do vínculo, interno ou unidade', () => {
    expect(validateParticipant(EMPTY_PARTICIPANT_FORM, NOW)).toEqual({
      target: 'Selecione um usuário ou uma unidade.',
    });
    const consultant = withUser(EMPTY_PARTICIPANT_FORM, DIEGO);
    expect(validateParticipant(consultant, NOW)).toEqual({
      expiresAt: 'Informe a validade da participação do consultor.',
    });
    expect(validateParticipant({ ...consultant, expiresAt: '2026-10-01T10:00' }, NOW)).toEqual({
      expiresAt: 'A validade deve ser uma data futura.',
    });
    expect(validateParticipant({ ...consultant, expiresAt: '2027-02-01T10:00' }, NOW)).toEqual({
      expiresAt: 'A validade não pode ultrapassar a do vínculo externo do usuário.',
    });
    expect(validateParticipant({ ...consultant, expiresAt: '2026-11-30T18:00' }, NOW)).toEqual({});
    expect(
      validateParticipant(
        {
          ...withUser(EMPTY_PARTICIPANT_FORM, ELISA),
          role: 'CONSULTANT',
          expiresAt: '2026-11-30T18:00',
        },
        NOW,
      ),
    ).toEqual({ role: 'Este usuário não pode receber o papel de Consultor.' });
    expect(
      validateParticipant(
        {
          ...EMPTY_PARTICIPANT_FORM,
          targetType: 'DEPARTMENT',
          department: UNIT,
          reason: 'x'.repeat(501),
        },
        NOW,
      ),
    ).toEqual({ reason: 'O motivo deve ter no máximo 500 caracteres.' });
  });

  it('corpo do PRC-29: validade ISO só para Consultor, motivo vazio omitido', () => {
    const consultant = {
      ...withUser(EMPTY_PARTICIPANT_FORM, DIEGO),
      expiresAt: '2026-11-30T18:00',
    };
    expect(participantBodyOf(consultant)).toEqual({
      userId: DIEGO.id,
      role: 'CONSULTANT',
      notify: true,
      expiresAt: new Date('2026-11-30T18:00').toISOString(),
    });
    expect(
      participantBodyOf({
        ...EMPTY_PARTICIPANT_FORM,
        targetType: 'DEPARTMENT',
        department: UNIT,
        notify: false,
        reason: '  Acompanhar  ',
        expiresAt: '2026-11-30T18:00',
      }),
    ).toEqual({ departmentId: UNIT.id, role: 'OBSERVER', notify: false, reason: 'Acompanhar' });
  });

  it('erros da API: campos, referência inválida, não elegível, já participa, sem permissão e indisponível', () => {
    expect(
      participantProblemOf(
        problem(422, 'VALIDATION_ERROR', {
          errors: [
            { field: 'userId', code: 'REFERENCE_NOT_FOUND', message: 'Registro não encontrado.' },
            { field: 'expiresAt', code: 'CONDITIONAL_REQUIRED', message: 'Informe a validade.' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'fields',
      fields: {
        target: 'Selecione um usuário ou unidade válidos.',
        expiresAt: 'Informe a validade.',
      },
    });
    expect(participantProblemOf(problem(422, 'PARTICIPANT_NOT_ELIGIBLE'))).toEqual({
      kind: 'fields',
      fields: { role: 'detalhe' },
    });
    expect(
      participantProblemOf(
        problem(409, 'PARTICIPANT_ALREADY_EXISTS', { meta: { currentRole: 'COLLABORATOR' } }),
      ),
    ).toEqual({ kind: 'exists', currentRole: 'COLLABORATOR' });
    expect(participantProblemOf(problem(403, 'PERMISSION_DENIED'))).toEqual({
      kind: 'message',
      message: 'Você não tem permissão para gerenciar participantes deste processo.',
    });
    expect(participantProblemOf(problem(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
    });
    expect(participantProblemOf(new Error('x'))).toEqual({ kind: 'unavailable' });
  });
});

describe('botão "Seguir" (FA-01 · RN-PROC-133)', () => {
  it('sem participação, observador e outro papel', () => {
    expect(followStateOf({ canManage: false, me: null })).toEqual({ kind: 'FOLLOW' });
    expect(
      followStateOf({ canManage: false, me: { participantId: ELISA.id, role: 'OBSERVER' } }),
    ).toEqual({ kind: 'FOLLOWING' });
    expect(
      followStateOf({ canManage: false, me: { participantId: ELISA.id, role: 'COLLABORATOR' } }),
    ).toEqual({ kind: 'PARTICIPATING', role: 'COLLABORATOR' });
  });
});
