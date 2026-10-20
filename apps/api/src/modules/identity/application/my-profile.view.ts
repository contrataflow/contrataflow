import type { MyProfileDto } from '@contrataflow/validation';

import type { MembershipReferences } from '#shared/auth/membership-references.js';
import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { MembershipRepository } from './membership-ports.js';
import { interfacePreferences } from '../domain/user.js';
import type { User } from '../domain/user.js';

/**
 * Perfil de ME-01/ME-02: o `User` (identidade global — DEC-012) mais o cargo e as lotações do
 * vínculo no tenant do `tx` (somente leitura aqui — RN-IAM-109). Sem vínculo legível no tenant,
 * `membership` vem vazio. `mfaVerified` diz só se a sessão comprova o segundo fator (US-090 ·
 * RN-IAM-44): o ContrataFlow não guarda nem detalha os dispositivos, que vivem no Authentik.
 */
export async function toMyProfile(
  tx: TenantTx,
  user: User,
  memberships: MembershipRepository,
  references: MembershipReferences,
): Promise<MyProfileDto> {
  const membership = await memberships.findStateByUser(tx, user.id);
  const departments: ReadonlyMap<string, { readonly name: string }> = membership
    ? await references.departmentsByIds(tx, membership.departmentIds)
    : new Map();
  return {
    id: user.id,
    name: user.name,
    socialName: user.socialName,
    email: user.email,
    phone: user.phone,
    preferences: interfacePreferences(user),
    membership: {
      jobTitle: membership?.jobTitle ?? null,
      departments: (membership?.departmentIds ?? []).flatMap((id) => {
        const name = departments.get(id)?.name;
        return name === undefined ? [] : [name];
      }),
    },
    mfaVerified: hasSecondFactor(requireRequestContext().amr),
    version: user.version,
  };
}
