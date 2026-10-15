import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * Uso de um tipo de documento por outros módulos (US-061 · RN-DOC-09). O módulo `document` precisa
 * saber se um fluxo publicado exige o tipo antes de desativá-lo, mas `workflow` está no mesmo nível
 * e consome tipos de `document`: a dependência inversa vira esta porta do shared kernel, que
 * `workflow` implementa e registra no `onModuleInit` (como as projeções do outbox).
 */

/** Regra `REQUIRED_DOCUMENT` `BLOCKING` ativa de versão `PUBLISHED` que exige o tipo. */
export interface BlockingDocumentRule {
  readonly workflowName: string;
  readonly stageName: string;
}

export interface DocumentTypeUsage {
  /** Regras bloqueantes publicadas — impedem desativar o tipo (409). */
  readonly blockingRules: readonly BlockingDocumentRule[];
  /** Workflows publicados que referenciam o tipo em etapas ou regras (aviso na prévia). */
  readonly referencingWorkflows: number;
}

export const NO_DOCUMENT_TYPE_USAGE: DocumentTypeUsage = Object.freeze({
  blockingRules: [],
  referencingWorkflows: 0,
});

export interface DocumentTypeUsageProvider {
  /** Uso do tipo (por código) no tenant da transação. */
  usageOf(tx: TenantTx, documentTypeCode: string): Promise<DocumentTypeUsage>;
}

/** Soma o uso informado por todos os provedores registrados. */
@Injectable()
export class DocumentTypeUsageRegistry {
  private readonly providers: DocumentTypeUsageProvider[] = [];

  register(provider: DocumentTypeUsageProvider): void {
    if (!this.providers.includes(provider)) this.providers.push(provider);
  }

  async usageOf(tx: TenantTx, documentTypeCode: string): Promise<DocumentTypeUsage> {
    const usages = await Promise.all(
      this.providers.map((provider) => provider.usageOf(tx, documentTypeCode)),
    );
    return {
      blockingRules: usages.flatMap((usage) => usage.blockingRules),
      referencingWorkflows: usages.reduce((sum, usage) => sum + usage.referencingWorkflows, 0),
    };
  }
}

/** Importado por `document` (consumidor) e `workflow` (implementador); a instância é única. */
@Module({ providers: [DocumentTypeUsageRegistry], exports: [DocumentTypeUsageRegistry] })
export class DocumentTypeUsageModule {}
