import { IDENTITY_REPOSITORY } from '#modules/identity/application/ports.js';
import { INBOX_READER } from '#modules/inbox/application/ports.js';
import type { InboxProcessRow } from '#modules/inbox/domain/task-inbox.js';
import { InMemoryInboxReader } from '#modules/inbox/infrastructure/task-inbox.readers.js';

import type { TestApi } from './api-test-app.js';
import { seedActiveMember } from './structure-fixtures.js';

/*
 * Apoio dos testes do dashboard (US-076): o leitor em memória das views da caixa de tarefas
 * (PENDING_ITEMS = TSK-02) e membros autenticáveis sem perfis — internos de `inbox` e `identity`
 * que a suíte do `dashboard` não importa diretamente (DEC-040).
 */

export { INBOX_READER, InMemoryInboxReader };
export type { InboxProcessRow };

/** Membro ativo sem perfis, autenticável pelo `sub` informado. */
export function seedMember(
  api: TestApi,
  member: {
    readonly id: string;
    readonly membershipId: string;
    readonly tenantId: string;
    readonly subject: string;
  },
): void {
  seedActiveMember(
    api,
    {
      id: member.id,
      name: `Pessoa ${member.subject}`,
      email: `${member.subject}@prefeitura.test`,
    },
    { id: member.membershipId, tenantId: member.tenantId },
  );
  const identity = api.app.get<{ users: Map<string, { subject: string | null }> }>(
    IDENTITY_REPOSITORY,
    { strict: false },
  );
  const user = identity.users.get(member.id);
  if (user) user.subject = member.subject;
}
