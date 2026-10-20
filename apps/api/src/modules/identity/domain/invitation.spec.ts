import { INVITATION_TOKEN_PATTERN } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  acceptDecision,
  blocksNewInvitation,
  externalValidityError,
  generateInvitationToken,
  hashInvitationToken,
  inviteExpiryFrom,
  isWellFormedInvitationToken,
  resendDecision,
} from './invitation.js';
import type { PendingInvitation } from './invitation.js';

/* US-091 — regras puras do convite (RN-IAM-46..53). */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const DAY = 24 * 3_600_000;
const USER = '0192a000-0000-7000-8000-0000000000b9';

describe('token do convite (RN-IAM-47)', () => {
  it('é opaco, de 32 bytes em base64url, e único a cada geração', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(INVITATION_TOKEN_PATTERN);
      expect(isWellFormedInvitationToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('o hash é o SHA-256 hexadecimal, determinístico e diferente do token', () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvitationToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    expect(hashInvitationToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('token malformado é recusado sem consulta', () => {
    expect(isWellFormedInvitationToken('curto')).toBe(false);
    expect(isWellFormedInvitationToken(`${'a'.repeat(42)}=`)).toBe(false);
    expect(isWellFormedInvitationToken('a'.repeat(44))).toBe(false);
  });

  it('o link vale 7 dias a partir do (re)envio', () => {
    expect(inviteExpiryFrom(NOW).toISOString()).toBe('2026-10-22T12:00:00.000Z');
  });
});

describe('unicidade do vínculo (RN-IAM-48)', () => {
  it.each([
    ['INVITED', true],
    ['ACTIVE', true],
    ['SUSPENDED', true],
    ['REVOKED', false],
    ['EXPIRED', false],
  ] as const)('%s bloqueia novo convite? %s', (status, blocks) => {
    expect(blocksNewInvitation(status)).toBe(blocks);
  });
});

describe('validade do vínculo externo (RN-IAM-52)', () => {
  it('futura e até o máximo do tenant', () => {
    expect(externalValidityError(new Date(NOW.getTime() + 30 * DAY), NOW, 180)).toBeNull();
    expect(externalValidityError(new Date(NOW.getTime() + 180 * DAY), NOW, 180)).toBeNull();
  });

  it('no passado → DATE_IN_PAST; além do máximo → OUT_OF_RANGE', () => {
    expect(externalValidityError(NOW, NOW, 180)).toMatchObject({
      field: 'expiresAt',
      code: 'DATE_IN_PAST',
    });
    expect(externalValidityError(new Date(NOW.getTime() + 181 * DAY), NOW, 180)).toMatchObject({
      field: 'expiresAt',
      code: 'OUT_OF_RANGE',
      message: 'A validade do vínculo externo é de no máximo 180 dias.',
    });
    expect(externalValidityError(new Date(NOW.getTime() + 31 * DAY), NOW, 30)).toMatchObject({
      code: 'OUT_OF_RANGE',
    });
  });
});

describe('reenvio (RN-IAM-48/53)', () => {
  const invited = { status: 'INVITED' as const, invitedAt: new Date(NOW.getTime() - 120_000) };

  it('permitido em INVITED, com menos de 5 reenvios e depois de 1 minuto', () => {
    expect(resendDecision({ ...invited, resendCount: 0 }, NOW)).toEqual({ kind: 'allowed' });
    expect(resendDecision({ ...invited, resendCount: 4 }, NOW)).toEqual({ kind: 'allowed' });
    expect(resendDecision({ ...invited, invitedAt: null, resendCount: 0 }, NOW)).toEqual({
      kind: 'allowed',
    });
  });

  it('fora de INVITED → not_invited; 5 reenvios → limit_reached', () => {
    expect(resendDecision({ ...invited, status: 'ACTIVE', resendCount: 0 }, NOW).kind).toBe(
      'not_invited',
    );
    expect(resendDecision({ ...invited, resendCount: 5 }, NOW).kind).toBe('limit_reached');
  });

  it('antes de 1 minuto → too_soon com o tempo restante', () => {
    const recent = { status: 'INVITED' as const, invitedAt: new Date(NOW.getTime() - 15_500) };
    expect(resendDecision({ ...recent, resendCount: 1 }, NOW)).toEqual({
      kind: 'too_soon',
      retryAfterSeconds: 45,
    });
  });
});

describe('aceite (RN-IAM-49/50)', () => {
  const pending: PendingInvitation = {
    membershipId: '0192a000-0000-7000-8000-0000000009a1',
    tenantId: '0192a000-0000-7000-8000-00000000000b',
    tenantName: 'Prefeitura B',
    tenantStatus: 'ACTIVE',
    userId: USER,
    status: 'INVITED',
    inviteExpiresAt: new Date(NOW.getTime() + DAY),
  };

  it('destinatário, INVITED e dentro da validade → accept', () => {
    expect(acceptDecision(pending, USER, NOW)).toEqual({ kind: 'accept' });
  });

  it('inexistente, já aceito, cancelado ou de outra pessoa → invalid (sem dizer qual)', () => {
    expect(acceptDecision(null, USER, NOW).kind).toBe('invalid');
    expect(acceptDecision({ ...pending, status: 'ACTIVE' }, USER, NOW).kind).toBe('invalid');
    expect(acceptDecision({ ...pending, status: 'REVOKED' }, USER, NOW).kind).toBe('invalid');
    expect(acceptDecision(pending, '0192a000-0000-7000-8000-0000000000a1', NOW).kind).toBe(
      'invalid',
    );
    expect(acceptDecision({ ...pending, inviteExpiresAt: null }, USER, NOW).kind).toBe('invalid');
  });

  it('validade vencida (inclusive no limite) → expired; instituição inativa → tenant_unavailable', () => {
    expect(acceptDecision({ ...pending, inviteExpiresAt: NOW }, USER, NOW).kind).toBe('expired');
    expect(acceptDecision({ ...pending, tenantStatus: 'SUSPENDED' }, USER, NOW).kind).toBe(
      'tenant_unavailable',
    );
  });
});
