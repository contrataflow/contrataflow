import { Injectable } from '@nestjs/common';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { AccessTransactions } from '../application/ports.js';

@Injectable()
export class PrismaAccessTransactions implements AccessTransactions {
  constructor(private readonly transaction: TenantTransaction) {}

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.run(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.transaction.read(work);
  }
}

/** Testes e modo de identidade fake: o repositório em memória isola pelo tenant do contexto. */
export class InMemoryAccessTransactions implements AccessTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}
