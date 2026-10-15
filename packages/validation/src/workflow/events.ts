import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/** `WorkflowCreated` (events.md §4 · US-040): commit do WF-02 (e do seeder — US-042). */
export const WorkflowCreated = defineDomainEvent({
  eventType: 'WorkflowCreated',
  eventVersion: 1,
  aggregateType: 'Workflow',
  payload: z.strictObject({ workflowId: z.uuid(), key: z.string().min(3).max(60) }),
  routingKey: 'workflow.created',
});

/**
 * `WorkflowVersionPublished` (events.md §4 · US-040/US-045): commit do `WorkflowVersionPublisher`.
 * Consumidor: invalidação dos caches de definição (`ConfigCacheInvalidator`).
 */
export const WorkflowVersionPublished = defineDomainEvent({
  eventType: 'WorkflowVersionPublished',
  eventVersion: 1,
  aggregateType: 'Workflow',
  payload: z.strictObject({
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    versionNumber: z.number().int().min(1),
    definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  routingKey: 'workflow.version_published',
});

/** `WorkflowVersionRetired`: versão supersedida na publicação (RN-WF-20) ou aposentada (WF-22). */
export const WorkflowVersionRetired = defineDomainEvent({
  eventType: 'WorkflowVersionRetired',
  eventVersion: 1,
  aggregateType: 'Workflow',
  payload: z.strictObject({ workflowId: z.uuid(), workflowVersionId: z.uuid() }),
  routingKey: 'workflow.version_retired',
});
