import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { IDENTITY_REPOSITORY } from './ports.js';
import type { IdentityRepository } from './ports.js';

/**
 * API pública do módulo `identity` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class IdentityFacade {
  constructor(@Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityRepository) {}

  /**
   * Nome exibido (social, se houver) dos usuários com vínculo no tenant da transação, lidos no `tx`
   * do caso de uso — os nomes congelados da timeline (US-059). Usuário fora do tenant não volta.
   */
  userDisplayNames(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, string>> {
    return this.identity.displayNamesInTenant(tx, userIds);
  }
}
