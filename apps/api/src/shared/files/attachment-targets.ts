import type { AttachmentTargetType } from '@contrataflow/types';
import { Injectable, Module } from '@nestjs/common';

import type { ProcessAccessTarget } from '../auth/process-access.js';
import type { TenantTx } from '../database/prisma.js';

/*
 * Alvo de um anexo (US-068 · RN-DOC-71 · DEC-024). O `files` (nível 2) serve a alvos de módulos do
 * mesmo nível ou acima (`document`, `process`, `price-research`, `collaboration`, `risk`): a
 * dependência no sentido contrário vira esta porta do shared kernel — cada dono registra, no
 * `onModuleInit`, o leitor dos SEUS tipos de alvo. Sem leitor para o tipo, falha fechado: o alvo
 * não existe (404), como no `ProcessAccessRegistry`.
 */

export interface AttachmentTargetRef {
  readonly targetType: AttachmentTargetType;
  readonly targetId: string;
}

/** O alvo como o `files` o vê: o processo dele (nulo só em ativos do tenant) e a autorização. */
export interface AttachmentTarget extends AttachmentTargetRef {
  readonly processId: string | null;
  /** Processo como a autorização o vê (`ATTACHMENT_UPLOAD`/`ATTACHMENT_DELETE` cobrindo-o). */
  readonly process: ProcessAccessTarget | null;
}

export interface AttachmentTargetReader {
  readonly targetTypes: readonly AttachmentTargetType[];
  /**
   * Alvo VISÍVEL ao usuário da requisição no tenant da transação; `null` = inexistente, de outro
   * tenant ou invisível (404 — DEC-024).
   */
  load(tx: TenantTx, ref: AttachmentTargetRef): Promise<AttachmentTarget | null>;
  /**
   * Regra de edição do PRÓPRIO alvo (POL-02 no documento; processo fora de status final nos alvos
   * do processo): lança o `ApiError` do dono — 403 ou 409 `DOCUMENT_NOT_EDITABLE` /
   * `INVALID_PROCESS_STATUS` (V-04).
   */
  assertAttachable(tx: TenantTx, target: AttachmentTarget): Promise<void>;
}

/** Registro dos leitores (um por tipo de alvo). */
@Injectable()
export class AttachmentTargetRegistry {
  private readonly readers = new Map<AttachmentTargetType, AttachmentTargetReader>();

  register(reader: AttachmentTargetReader): void {
    for (const type of reader.targetTypes) this.readers.set(type, reader);
  }

  supports(targetType: AttachmentTargetType): boolean {
    return this.readers.has(targetType);
  }

  load(tx: TenantTx, ref: AttachmentTargetRef): Promise<AttachmentTarget | null> {
    const reader = this.readers.get(ref.targetType);
    return reader ? reader.load(tx, ref) : Promise.resolve(null);
  }

  async assertAttachable(tx: TenantTx, target: AttachmentTarget): Promise<void> {
    const reader = this.readers.get(target.targetType);
    if (!reader) throw new Error(`Alvo de anexo sem leitor: ${target.targetType}.`);
    await reader.assertAttachable(tx, target);
  }
}

/** Importado por `files` (consumidor) e pelos donos dos alvos; a instância é única. */
@Module({ providers: [AttachmentTargetRegistry], exports: [AttachmentTargetRegistry] })
export class AttachmentTargetModule {}
