import type { MembershipStatus } from '#shared/auth/ports.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { MembershipView } from './invitation-ports.js';
import type { MembershipType } from '../domain/tenant-membership.js';

/*
 * Porta da gestão de vínculos (US-092 · USR-07..12): leitura do estado para as regras, gravações
 * condicionais à `version` lida (If-Match — RN-IAM-63) e a trava dos administradores ativos
 * (POL-12). Implementada sobre `tenant_memberships`/`membership_departments` (RLS do tenant) e em
 * memória nos testes e no modo de identidade fake.
 */

/** Estado do vínculo para as regras de USR-08..12. */
export interface MembershipState {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly type: MembershipType;
  readonly status: MembershipStatus;
  readonly jobTitle: string | null;
  readonly registrationNumber: string | null;
  readonly expiresAt: Date | null;
  /** Principal primeiro. */
  readonly departmentIds: readonly string[];
  readonly version: number;
}

/** Detalhe (USR-07): a visão do vínculo com os dados de suspensão/revogação. */
export interface MembershipDetailView extends MembershipView {
  readonly suspendedAt: Date | null;
  readonly suspensionReason: string | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
}

interface VersionedWrite {
  readonly membershipId: string;
  /** `version` do `If-Match`: a gravação só acontece se ainda for a atual. */
  readonly expectedVersion: number;
  readonly now: Date;
  readonly actorId: string | null;
}

export interface MembershipRepository {
  /** Vínculo do usuário no tenant da transação (`null` se não existe ou é de outro tenant). */
  findStateByUser(tx: TenantTx, userId: string): Promise<MembershipState | null>;
  detail(tx: TenantTx, membershipId: string): Promise<MembershipDetailView | null>;
  /** USR-08: grava só os campos presentes; `false` se a versão mudou. */
  updateProfile(
    tx: TenantTx,
    input: VersionedWrite & {
      readonly jobTitle?: string | null;
      readonly registrationNumber?: string | null;
      readonly expiresAt?: Date;
    },
  ): Promise<boolean>;
  /** USR-09: nova versão do vínculo antes de substituir a lotação; `false` se a versão mudou. */
  bumpVersion(tx: TenantTx, input: VersionedWrite): Promise<boolean>;
  /**
   * USR-10/11/12: `from` → `to` condicional ao status e à versão. Suspensão grava
   * `suspendedAt`/`suspensionReason`; reativação os limpa (RN-IAM-58); revogação grava
   * `revokedAt`/`revokedById`/`revocationReason` e encerra qualquer convite pendente.
   */
  changeStatus(
    tx: TenantTx,
    input: VersionedWrite & {
      readonly from: readonly MembershipStatus[];
      readonly to: MembershipStatus;
      readonly reason: string | null;
    },
  ): Promise<boolean>;
  /**
   * POL-12: entre `membershipIds`, os vínculos `ACTIVE` e não vencidos, travados (`FOR UPDATE`, em
   * ordem de id) até o fim da transação — duas remoções simultâneas de administradores não passam
   * as duas.
   */
  lockActiveMemberships(
    tx: TenantTx,
    membershipIds: readonly string[],
    now: Date,
  ): Promise<string[]>;
}

export const MEMBERSHIP_REPOSITORY = Symbol('MembershipRepository');
