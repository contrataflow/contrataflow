import type { AttachmentStatus, AttachmentTargetType } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import type { TenantTx } from '../database/prisma.js';

/*
 * O arquivo de um anexo como os donos dos alvos o leem (US-064 · RN-DOC-33/34 · DEC-136): o
 * `document` cria a versão de um documento externo a partir de um anexo `AVAILABLE` do `files`.
 * Os dois módulos estão no mesmo nível (DEC-040): a dependência vira esta porta do shared kernel,
 * que `files` implementa e registra no `onModuleInit`. Sem leitor registrado, falha fechado — o
 * anexo não existe (422 `REFERENCE_NOT_FOUND` no chamador), nunca um arquivo sem varredura.
 * O layout de impressão do template (US-109) lê por aqui os bytes do logo `TENANT_ASSET` para
 * embutir no PDF (o Gotenberg não acessa o storage — storage.md §10).
 */

export interface AttachmentFile {
  readonly id: string;
  readonly targetType: AttachmentTargetType;
  readonly targetId: string | null;
  readonly status: AttachmentStatus;
  /** SHA-256 calculado pelo `file-scan` (nulo antes de `AVAILABLE`). */
  readonly sha256: string | null;
  readonly sizeBytes: number;
  readonly extension: string;
  /** MIME detectado pelos *magic bytes* (nulo antes da varredura). */
  readonly detectedMimeType: string | null;
}

export interface AttachmentFileReader {
  /** Anexo não excluído NO TENANT da transação (RLS); `null` = inexistente/outro tenant/excluído. */
  find(tx: TenantTx, attachmentId: string): Promise<AttachmentFile | null>;
  /**
   * Bytes do arquivo `AVAILABLE` (bucket `documents`) de até `maxBytes`; `null` = inexistente, não
   * disponível ou maior que o limite. Erro do storage propaga.
   */
  readContent(tx: TenantTx, attachmentId: string, maxBytes: number): Promise<Buffer | null>;
}

/** Registro do leitor (implementado pelo módulo `files`); instância única via `AttachmentTargetModule`. */
@Injectable()
export class AttachmentFileRegistry {
  private reader: AttachmentFileReader | null = null;

  register(reader: AttachmentFileReader): void {
    this.reader = reader;
  }

  find(tx: TenantTx, attachmentId: string): Promise<AttachmentFile | null> {
    return this.reader ? this.reader.find(tx, attachmentId) : Promise.resolve(null);
  }

  readContent(tx: TenantTx, attachmentId: string, maxBytes: number): Promise<Buffer | null> {
    return this.reader
      ? this.reader.readContent(tx, attachmentId, maxBytes)
      : Promise.resolve(null);
  }
}
