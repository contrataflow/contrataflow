import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Department` (events.md §4 · US-102), gravados no commit de DEP-03 (criação),
 * DEP-05/08 (edição e ativação), DEP-06 (movimentação) e DEP-07 (desativação). Consumidor:
 * `PermissionCacheInvalidator` (`department.moved`, `.updated`, `.deactivated`), que apaga o cache
 * de permissões efetivas do tenant — escopos `DEPARTMENT`/`OWN_DEPARTMENTS` e titular/substituto
 * (POL-03/POL-05) passam a valer na próxima requisição.
 */

const departmentPayload = z.strictObject({ departmentId: z.uuid() });

export const DepartmentCreated = defineDomainEvent({
  eventType: 'DepartmentCreated',
  eventVersion: 1,
  aggregateType: 'Department',
  payload: departmentPayload,
  routingKey: 'department.created',
});

export const DepartmentUpdated = defineDomainEvent({
  eventType: 'DepartmentUpdated',
  eventVersion: 1,
  aggregateType: 'Department',
  payload: z.strictObject({
    departmentId: z.uuid(),
    changedFields: z.array(z.string().min(1).max(60)).max(20),
  }),
  routingKey: 'department.updated',
});

export const DepartmentMoved = defineDomainEvent({
  eventType: 'DepartmentMoved',
  eventVersion: 1,
  aggregateType: 'Department',
  payload: z.strictObject({
    departmentId: z.uuid(),
    /** `null` = a unidade era raiz do órgão. */
    fromParentId: z.uuid().nullable(),
    /** `null` = a unidade passou a ser raiz do órgão. */
    toParentId: z.uuid().nullable(),
  }),
  routingKey: 'department.moved',
});

export const DepartmentDeactivated = defineDomainEvent({
  eventType: 'DepartmentDeactivated',
  eventVersion: 1,
  aggregateType: 'Department',
  payload: departmentPayload,
  routingKey: 'department.deactivated',
});
