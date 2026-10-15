import { matchesAnyRoutingKey } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import {
  SYNC_EVENT_HANDLER_NAMES,
  SyncEventHandlerNotAllowedError,
} from '#shared/outbox/outbox-writer.js';
import type {
  RecordedDomainEvent,
  SyncEventHandler,
  SyncEventHandlerRegistryPort,
} from '#shared/outbox/outbox-writer.js';

const ALLOWED: ReadonlySet<string> = new Set(SYNC_EVENT_HANDLER_NAMES);

/**
 * Handlers síncronos in-process (DEC-161 · RN-FND-52): lista fechada (`TimelineProjector`,
 * `ProcessAccessProjector`), registrados pelos módulos donos na subida. Executados pelo
 * `OutboxWriter` no mesmo `tx` do caso de uso, na ordem de registro.
 */
@Injectable()
export class SyncEventHandlerRegistry implements SyncEventHandlerRegistryPort {
  private readonly handlers: SyncEventHandler[] = [];

  register(handler: SyncEventHandler): void {
    if (!ALLOWED.has(handler.name)) {
      throw new SyncEventHandlerNotAllowedError(handler.name, 'NOT_ALLOWED');
    }
    if (this.handlers.some((registered) => registered.name === handler.name)) {
      throw new SyncEventHandlerNotAllowedError(handler.name, 'DUPLICATE');
    }
    this.handlers.push(handler);
  }

  /** Executa, em sequência, os handlers que assinam a routing key do evento. */
  async dispatch(tx: TenantTx, event: RecordedDomainEvent): Promise<void> {
    for (const handler of this.handlers) {
      if (matchesAnyRoutingKey(handler.routingKeys, event.routingKey)) {
        await handler.handle(tx, event);
      }
    }
  }
}
