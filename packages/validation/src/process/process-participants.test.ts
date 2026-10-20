import { describe, expect, it } from 'vitest';

import { ProcessParticipantAdded, ProcessParticipantRemoved } from './events.js';
import {
  addProcessParticipantSchema,
  removeProcessParticipantSchema,
} from './process-participants.js';
import { userLookupQuerySchema } from '../identity/user-lookup.js';

const USER = '0192a000-0000-7000-8000-0000000000a1';
const UNIT = '0192d006-0000-7000-8000-0000000000a2';
const PARTICIPANT = '0192d012-0000-7000-8000-000000000001';

function issuesOf(input: unknown) {
  const result = addProcessParticipantSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => [
    issue.path.join('.'),
    (issue as { params?: { code?: string } }).params?.code ?? issue.code,
  ]);
}

describe('addProcessParticipantSchema (US-012 · V-01..V-03)', () => {
  it('aceita usuário ou unidade, com notify padrão true e motivo vazio como null', () => {
    expect(addProcessParticipantSchema.parse({ userId: USER, role: 'COLLABORATOR' })).toEqual({
      userId: USER,
      role: 'COLLABORATOR',
      notify: true,
    });
    expect(
      addProcessParticipantSchema.parse({
        departmentId: UNIT,
        role: 'OBSERVER',
        notify: false,
        reason: '   ',
      }),
    ).toEqual({ departmentId: UNIT, role: 'OBSERVER', notify: false, reason: null });
  });

  it('V-01: papel ausente ou fora do enum (INVALID_ENUM na API)', () => {
    expect(issuesOf({ userId: USER })).toEqual([['role', 'invalid_value']]);
    expect(issuesOf({ userId: USER, role: 'OWNER' })).toEqual([['role', 'invalid_value']]);
  });

  it('V-02: nem usuário nem unidade (REQUIRED) ou os dois (NOT_ALLOWED)', () => {
    expect(issuesOf({ role: 'OBSERVER' })).toEqual([['userId', 'REQUIRED']]);
    expect(issuesOf({ userId: USER, departmentId: UNIT, role: 'OBSERVER' })).toEqual([
      ['departmentId', 'NOT_ALLOWED'],
    ]);
  });

  it('V-03: consultor sem validade = CONDITIONAL_REQUIRED em expiresAt', () => {
    expect(issuesOf({ userId: USER, role: 'CONSULTANT' })).toEqual([
      ['expiresAt', 'CONDITIONAL_REQUIRED'],
    ]);
    expect(
      issuesOf({ userId: USER, role: 'CONSULTANT', expiresAt: '2027-01-31T23:59:00-03:00' }),
    ).toEqual([]);
    expect(
      issuesOf({ userId: USER, role: 'OBSERVER', expiresAt: '2027-01-31T23:59:00-03:00' }),
    ).toEqual([['expiresAt', 'NOT_ALLOWED']]);
  });

  it('campos fora do contrato e motivo longo são recusados', () => {
    expect(issuesOf({ userId: USER, role: 'OBSERVER', grantedById: USER })).toEqual([
      ['', 'unrecognized_keys'],
    ]);
    expect(issuesOf({ userId: USER, role: 'OBSERVER', reason: 'x'.repeat(501) })).toEqual([
      ['reason', 'too_big'],
    ]);
  });
});

describe('removeProcessParticipantSchema e userLookupQuerySchema', () => {
  it('motivo da remoção opcional; busca com ao menos 2 caracteres', () => {
    expect(removeProcessParticipantSchema.parse({})).toEqual({});
    expect(removeProcessParticipantSchema.parse({ revocationReason: ' fim ' })).toEqual({
      revocationReason: 'fim',
    });
    expect(userLookupQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(userLookupQuerySchema.parse({ q: ' ana ' })).toEqual({ q: 'ana' });
  });
});

describe('eventos ProcessParticipant* (events.md §4.1)', () => {
  it('routing keys e payload exclusivo usuário/unidade', () => {
    const added = ProcessParticipantAdded.resolve({
      participantId: PARTICIPANT,
      userId: USER,
      departmentId: null,
      role: 'OBSERVER',
      expiresAt: null,
      notify: true,
      grantedVia: 'FOLLOW',
    });
    expect(added.routingKey).toBe('process.participant_added');
    expect(() =>
      ProcessParticipantAdded.resolve({
        participantId: PARTICIPANT,
        userId: USER,
        departmentId: UNIT,
        role: 'OBSERVER',
        expiresAt: null,
        notify: true,
        grantedVia: 'MANAGE',
      }),
    ).toThrow();
    expect(
      ProcessParticipantRemoved.resolve({ participantId: PARTICIPANT, reason: 'EXPIRED' })
        .routingKey,
    ).toBe('process.participant_removed');
  });
});
