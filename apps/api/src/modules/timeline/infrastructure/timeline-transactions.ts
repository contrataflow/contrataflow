import { Injectable } from '@nestjs/common';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineTransactions } from '../application/ports.js';

/** Leitura na `TenantTransaction` (RLS do tenant + extensão de isolamento — US-060). */
@Injectable()
export class PrismaTimelineTransactions implements TimelineTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

/** Modo de identidade fake (sem banco): transação simulada, como os demais módulos. */
export class InMemoryTimelineTransactions implements TimelineTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
