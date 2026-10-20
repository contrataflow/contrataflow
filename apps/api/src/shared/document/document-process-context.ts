import type { ProcessStatus } from '@contrataflow/validation';
import { Injectable, Module } from '@nestjs/common';

import type { ProcessAccessTarget } from '../auth/process-access.js';
import type { TenantTx } from '../database/prisma.js';

/*
 * O processo visto pelo ciclo de vida do documento (US-065 · POL-01/02/11 · entities.md §5.3.2). O
 * agregado é do módulo `process` (nível 3), que depende de `document` (nível 2): a dependência no
 * sentido contrário vira esta porta do shared kernel — o `process` registra o leitor no
 * `onModuleInit` (mesmo arranjo do `ProcessAccessRegistry`). Sem leitor, falha fechado: nenhum
 * processo existe e todo documento responde 404.
 */

/** Etapa atual do processo (snapshot da versão de workflow fixada — DEC-015). */
export interface DocumentProcessStage {
  readonly processStageId: string | null;
  readonly workflowStageId: string;
  readonly key: string;
  readonly name: string;
  readonly type: string;
  /** Tipos editáveis na etapa (vazio = todos — POL-02). */
  readonly documentTypeCodes: readonly string[];
  /** Tipos cobertos pela aprovação da etapa `APPROVAL` (DEC-015 · RN-DOC-44). */
  readonly approvalDocumentTypeCodes: readonly string[];
}

export interface DocumentProcessContext {
  readonly id: string;
  readonly status: ProcessStatus;
  readonly code: string | null;
  readonly title: string;
  readonly object: string;
  readonly organizationId: string;
  readonly organizationName: string | null;
  readonly organizationCnpj: string | null;
  readonly requestingSecretariatId: string;
  readonly requestingSecretariatName: string | null;
  readonly requestingDepartmentId: string;
  readonly requestingDepartmentName: string | null;
  readonly isBudgetConfidential: boolean;
  /** Custódia (POL-01): responsável atual ou, na fila, a unidade atual. */
  readonly currentDepartmentId: string;
  readonly currentResponsibleId: string | null;
  readonly currentStage: DocumentProcessStage | null;
  /** O processo como a autorização o vê: escopo, visibilidade (DEC-024) e participações. */
  readonly access: ProcessAccessTarget;
}

export interface DocumentProcessContextReader {
  /** `null` = inexistente no tenant da transação (RLS), descartado ou de outro tenant. */
  load(tx: TenantTx, processId: string): Promise<DocumentProcessContext | null>;
}

/** Registro do leitor (implementado pelo módulo `process`). */
@Injectable()
export class DocumentProcessContextRegistry {
  private reader: DocumentProcessContextReader | null = null;

  register(reader: DocumentProcessContextReader): void {
    this.reader = reader;
  }

  load(tx: TenantTx, processId: string): Promise<DocumentProcessContext | null> {
    return this.reader ? this.reader.load(tx, processId) : Promise.resolve(null);
  }
}

/** Importado por `document` (consumidor) e `process` (implementador); a instância é única. */
@Module({
  providers: [DocumentProcessContextRegistry],
  exports: [DocumentProcessContextRegistry],
})
export class DocumentProcessContextModule {}
