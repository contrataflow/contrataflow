import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Role` (events.md §4 · US-095): gravados no commit de ROL-03/07 (criação e
 * duplicação) e de ROL-05/06/08 (edição, matriz e desativação). Consumidor:
 * `PermissionCacheInvalidator` (routing `role.*`), que apaga o cache de permissões efetivas do
 * tenant (DEC-134).
 */

const roleKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,59}$/);
const permissionCodes = z.array(z.string().min(1).max(80)).max(200);

export const RoleCreated = defineDomainEvent({
  eventType: 'RoleCreated',
  eventVersion: 1,
  aggregateType: 'Role',
  payload: z.strictObject({
    roleId: z.uuid(),
    key: roleKey,
    /** Vazio na criação sem `permissions[]`. */
    permissionsAdded: permissionCodes,
  }),
  routingKey: 'role.created',
});

export const RoleUpdated = defineDomainEvent({
  eventType: 'RoleUpdated',
  eventVersion: 1,
  aggregateType: 'Role',
  payload: z.strictObject({
    roleId: z.uuid(),
    key: roleKey,
    /** Vazios quando a alteração é só de metadados ou de `isActive`. */
    permissionsAdded: permissionCodes,
    permissionsRemoved: permissionCodes,
  }),
  routingKey: 'role.updated',
});
