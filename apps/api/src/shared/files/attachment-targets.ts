import type { AttachmentTargetType } from '@contrataflow/types';
import { Injectable, Module } from '@nestjs/common';

import { AttachmentFileRegistry } from './attachment-files.js';
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

/**
 * Sigilo do alvo para o acesso ao ARQUIVO (US-069 · RN-DOC-86 · POL-09): `restricted` = alvo com
 * `confidentiality = RESTRICTED`; `allowed` = o usuário da requisição atende POL-09 sobre o processo
 * dele. O arquivo não é mascarado: sem a política, detalhe e download respondem 403.
 */
export interface AttachmentConfidentiality {
  readonly restricted: boolean;
  readonly allowed: boolean;
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
  /**
   * Sigilo do alvo e POL-09 do usuário (US-069). Omitido = alvo sem sigilo próprio (ex.: `PROCESS`);
   * `null` = alvo inexistente (404).
   */
  confidentiality?(
    tx: TenantTx,
    ref: AttachmentTargetRef,
  ): Promise<AttachmentConfidentiality | null>;
}

/**
 * Registro dos leitores. Um tipo pode ter mais de um dono quando o `targetId` aponta para
 * entidades diferentes — `TENANT_ASSET` é o ativo do tenant enviado a partir do rascunho de um
 * template (US-109, `document`) ou do órgão (US-101): o primeiro leitor que reconhece o alvo o
 * carrega, e é ele quem confere a regra de edição.
 */
@Injectable()
export class AttachmentTargetRegistry {
  private readonly readers = new Map<AttachmentTargetType, AttachmentTargetReader[]>();
  private readonly owners = new WeakMap<AttachmentTarget, AttachmentTargetReader>();

  register(reader: AttachmentTargetReader): void {
    for (const type of reader.targetTypes) {
      const current = this.readers.get(type) ?? [];
      if (!current.includes(reader)) this.readers.set(type, [...current, reader]);
    }
  }

  supports(targetType: AttachmentTargetType): boolean {
    return this.readers.has(targetType);
  }

  async load(tx: TenantTx, ref: AttachmentTargetRef): Promise<AttachmentTarget | null> {
    for (const reader of this.readers.get(ref.targetType) ?? []) {
      const target = await reader.load(tx, ref);
      if (target === null) continue;
      this.owners.set(target, reader);
      return target;
    }
    return null;
  }

  async assertAttachable(tx: TenantTx, target: AttachmentTarget): Promise<void> {
    const reader = this.owners.get(target) ?? this.readers.get(target.targetType)?.[0];
    if (!reader) throw new Error(`Alvo de anexo sem leitor: ${target.targetType}.`);
    await reader.assertAttachable(tx, target);
  }

  /**
   * Sigilo do alvo (US-069). Sem leitor para o tipo falha fechado (restrito e não permitido): um
   * anexo cujo dono não se registrou nunca é entregue sem a política.
   */
  async confidentiality(
    tx: TenantTx,
    ref: AttachmentTargetRef,
  ): Promise<AttachmentConfidentiality | null> {
    const reader = this.readers.get(ref.targetType)?.[0];
    if (!reader) return { restricted: true, allowed: false };
    if (!reader.confidentiality) return { restricted: false, allowed: true };
    return await reader.confidentiality(tx, ref);
  }
}

/**
 * Importado por `files` e pelos donos dos alvos; as instâncias são únicas. Leva também o
 * `AttachmentFileRegistry` (o sentido inverso: `files` serve o arquivo do anexo — US-064).
 */
@Module({
  providers: [AttachmentTargetRegistry, AttachmentFileRegistry],
  exports: [AttachmentTargetRegistry, AttachmentFileRegistry],
})
export class AttachmentTargetModule {}
