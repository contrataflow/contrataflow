import type { BranchSiblingDto } from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

/*
 * Contexto de ramo de uma etapa (US-125 · RN-WF2-37 · DEC-194) para quem está ABAIXO do `process`
 * na hierarquia de módulos (a `approval` lê o ramo da etapa da aprovação para APV-01/APV-02). O
 * `process` implementa e registra no `onModuleInit`; sem leitor registrado, nenhuma etapa tem ramo
 * (as respostas ficam as do MVP 1).
 */

export interface StageBranchContext {
  readonly branchKey: string;
  readonly branchLabel: string;
  /** Os outros ramos do mesmo split (até 3, sem pessoas nem valores — POL-09). */
  readonly siblings: readonly BranchSiblingDto[];
  readonly siblingsMore: number;
}

export interface ProcessBranchContextReader {
  /** Por `processStageId`: só as etapas de ramo entram no mapa. */
  forStages(
    tx: TenantTx,
    stages: readonly { readonly processId: string; readonly processStageId: string }[],
  ): Promise<Map<string, StageBranchContext>>;
}

@Injectable()
export class ProcessBranchContextRegistry {
  private reader: ProcessBranchContextReader | null = null;

  register(reader: ProcessBranchContextReader): void {
    this.reader = reader;
  }

  forStages(
    tx: TenantTx,
    stages: readonly { readonly processId: string; readonly processStageId: string }[],
  ): Promise<Map<string, StageBranchContext>> {
    if (this.reader === null || stages.length === 0) {
      return Promise.resolve(new Map<string, StageBranchContext>());
    }
    return this.reader.forStages(tx, stages);
  }
}

/** Importado por `approval` (consumidor) e `process` (implementador). */
@Module({ providers: [ProcessBranchContextRegistry], exports: [ProcessBranchContextRegistry] })
export class ProcessBranchContextModule {}
