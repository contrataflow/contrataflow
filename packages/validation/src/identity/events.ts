import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `TenantMembership` (events.md §4.6 · US-091). `UserInvited` é gravado no
 * commit de USR-03 (convite), de USR-04 (reenvio — `resend = true`) e do envio do convite do
 * primeiro administrador (US-099): o worker o consome para enfileirar o e-mail do convite na fila
 * `email` (`InvitationEmailEnqueuer`) — o link é gerado pelo `EmailSender` no envio (queues.md
 * §4.3). `MembershipActivated` sai do commit de USR-06. Os dois também chegam ao
 * `PermissionCacheInvalidator` (`membership.*`).
 */

export const UserInvited = defineDomainEvent({
  eventType: 'UserInvited',
  eventVersion: 1,
  aggregateType: 'TenantMembership',
  payload: z.strictObject({
    membershipId: z.uuid(),
    userId: z.uuid(),
    type: z.enum(['INTERNAL', 'EXTERNAL']),
    /** Fim do vínculo `EXTERNAL`; ausente/nulo no `INTERNAL`. */
    expiresAt: z.iso.datetime().nullish(),
    /** Fim da validade do link (geração do convite: o e-mail só vale para ela). */
    inviteExpiresAt: z.iso.datetime(),
    /** Reenvio (USR-04): o link anterior já não vale. */
    resend: z.boolean(),
  }),
  routingKey: 'membership.invited',
});

export const MembershipActivated = defineDomainEvent({
  eventType: 'MembershipActivated',
  eventVersion: 1,
  aggregateType: 'TenantMembership',
  payload: z.strictObject({ membershipId: z.uuid(), userId: z.uuid() }),
  routingKey: 'membership.activated',
});
