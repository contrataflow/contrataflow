import { createHash, randomBytes } from 'node:crypto';

import {
  INVITATION_RESEND_INTERVAL_SECONDS,
  INVITATION_RESEND_LIMIT,
  INVITATION_TOKEN_PATTERN,
  INVITATION_VALIDITY_DAYS,
} from '@contrataflow/validation';
import type { FieldError } from '@contrataflow/validation';

import type { MembershipStatus } from '#shared/auth/ports.js';

/*
 * Regras puras do convite (US-091 · RN-IAM-46..53): token e hash, validade, unicidade do vínculo,
 * reenvio e aceite. Sem I/O — os casos de uso aplicam as decisões nas transações.
 */

const DAY_MS = 24 * 3_600_000;

/** RN-IAM-47: token opaco de 32 bytes do CSPRNG em base64url (43 caracteres, sem `=`). */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hexadecimal do token — a única forma persistida (`inviteTokenHash`). */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Formato do token (malformado → `INVITATION_INVALID` sem consultar o banco). */
export function isWellFormedInvitationToken(token: string): boolean {
  return INVITATION_TOKEN_PATTERN.test(token);
}

/** RN-IAM-47: o link vale 7 dias a partir do (re)envio. */
export function inviteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITATION_VALIDITY_DAYS * DAY_MS);
}

/**
 * RN-IAM-48: vínculo em `INVITED`, `ACTIVE` ou `SUSPENDED` impede outro convite
 * (`MEMBERSHIP_ALREADY_EXISTS`); `REVOKED`/`EXPIRED` podem ser convidados de novo — o mesmo
 * registro volta a `INVITED` (`UNIQUE (tenant_id, user_id)`).
 */
export function blocksNewInvitation(status: MembershipStatus): boolean {
  return status === 'INVITED' || status === 'ACTIVE' || status === 'SUSPENDED';
}

/**
 * RN-IAM-52: validade do vínculo `EXTERNAL` no futuro e até `maxDays` (padrão 180); `null` quando
 * válida. A obrigatoriedade (V-03) já foi conferida pelo schema.
 */
export function externalValidityError(
  expiresAt: Date,
  now: Date,
  maxDays: number,
): FieldError | null {
  if (expiresAt.getTime() <= now.getTime()) {
    return {
      field: 'expiresAt',
      code: 'DATE_IN_PAST',
      message: 'Informe uma validade futura para o vínculo externo.',
    };
  }
  if (expiresAt.getTime() > now.getTime() + maxDays * DAY_MS) {
    return {
      field: 'expiresAt',
      code: 'OUT_OF_RANGE',
      message: `A validade do vínculo externo é de no máximo ${String(maxDays)} dias.`,
    };
  }
  return null;
}

export interface ResendState {
  readonly status: MembershipStatus;
  /** Último envio (`invitedAt`). */
  readonly invitedAt: Date | null;
  readonly resendCount: number;
}

export type ResendDecision =
  | { readonly kind: 'allowed' }
  /** Não há convite pendente (vínculo já ativo, cancelado…) → 404 `USER_NOT_FOUND`. */
  | { readonly kind: 'not_invited' }
  /** RN-IAM-53 → 429 `RATE_LIMITED` com `Retry-After`. */
  | { readonly kind: 'limit_reached' }
  | { readonly kind: 'too_soon'; readonly retryAfterSeconds: number };

/** RN-IAM-48/53: reenvio só em `INVITED`, até 5 vezes, com 1 minuto entre tentativas. */
export function resendDecision(state: ResendState, now: Date): ResendDecision {
  if (state.status !== 'INVITED') return { kind: 'not_invited' };
  if (state.resendCount >= INVITATION_RESEND_LIMIT) return { kind: 'limit_reached' };
  if (state.invitedAt !== null) {
    const elapsedMs = now.getTime() - state.invitedAt.getTime();
    const intervalMs = INVITATION_RESEND_INTERVAL_SECONDS * 1_000;
    if (elapsedMs < intervalMs) {
      return { kind: 'too_soon', retryAfterSeconds: Math.ceil((intervalMs - elapsedMs) / 1_000) };
    }
  }
  return { kind: 'allowed' };
}

/** Convite encontrado pelo hash do token (`cf_find_invitation`, entre tenants). */
export interface PendingInvitation {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly userId: string;
  readonly status: MembershipStatus;
  readonly inviteExpiresAt: Date | null;
}

export type AcceptDecision =
  | { readonly kind: 'accept' }
  /** RN-IAM-50: inexistente, já aceito, cancelado ou de outra pessoa — sem dizer qual (404). */
  | { readonly kind: 'invalid' }
  /** 410 `INVITATION_EXPIRED`. */
  | { readonly kind: 'expired' }
  /** A instituição do convite não está ativa (403 `TENANT_SUSPENDED`). */
  | { readonly kind: 'tenant_unavailable' };

/**
 * RN-IAM-49/50: o convite vale para o usuário autenticado que é o destinatário (o `User` do
 * convite foi resolvido pelo e-mail — RN-IAM-46), em `INVITED` e dentro da validade.
 */
export function acceptDecision(
  invitation: PendingInvitation | null,
  actorUserId: string,
  now: Date,
): AcceptDecision {
  if (invitation?.status !== 'INVITED' || invitation.userId !== actorUserId) {
    return { kind: 'invalid' };
  }
  if (invitation.inviteExpiresAt === null) return { kind: 'invalid' };
  if (invitation.inviteExpiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
  if (invitation.tenantStatus !== 'ACTIVE') return { kind: 'tenant_unavailable' };
  return { kind: 'accept' };
}
