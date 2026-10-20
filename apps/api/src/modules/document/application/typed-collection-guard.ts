import type { PermissionCode } from '@contrataflow/types';
import type { DocumentStatus, SystemDocumentModule } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { isProcessVisible } from '#shared/auth/process-access.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import type { DocumentProcessContext } from '#shared/document/document-process-context.js';
import { ApiError } from '#shared/errors/api-error.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import { DOCUMENT_REPOSITORY } from './document.ports.js';
import type { DocumentRepository } from './document.ports.js';
import { DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentTypeRepository } from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { typePermissionsOf } from '../domain/document-permissions.js';
import type { DocumentType } from '../domain/document-type.js';
import { DOCUMENT_EDITABLE_PROCESS_STATUSES, isEditable } from '../domain/document.js';
import type { Document } from '../domain/document.js';

/*
 * POL-02 estendida às coleções dos documentos tipados (permissions.md §6 · RN-RISK-09): `Risk`,
 * `RiskTreatment`, `EtpAlternative`, `PriceItem`… pertencem ao processo e são editados fora do
 * editor do documento. Editar a coleção exige a permissão de edição do tipo cobrindo o processo +
 * custódia ou participação `COLLABORATOR`/`CONSULTANT` + processo em `DRAFT`/`IN_PROGRESS`/
 * `RETURNED` + tipo permitido na etapa atual e, se o documento dono (ativo — não cancelado nem
 * excluído) já existir, que ele esteja em `DRAFT`/`RETURNED`. Sem documento dono, valem só as
 * condições do processo. O módulo dono da coleção (nível 4) pergunta por esta peça, pela fachada.
 */

/** O documento dono da coleção, quando já emitido. */
export interface TypedCollectionOwner {
  readonly id: string;
  readonly code: string | null;
  readonly status: DocumentStatus;
}

/** Por que a coleção não pode ser alterada pelo usuário agora (`null` = pode). */
export type TypedCollectionLockReason =
  | 'PERMISSION_DENIED'
  | 'NOT_CUSTODIAN'
  | 'INVALID_PROCESS_STATUS'
  | 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE'
  | 'DOCUMENT_NOT_EDITABLE';

export interface TypedCollectionInput {
  readonly processId: string;
  readonly systemModule: SystemDocumentModule;
  /** Mensagem do 403 de permissão (a do módulo dono — ex.: "…gerenciar riscos…"). */
  readonly deniedDetail?: string;
  /** Mensagem do 409 `DOCUMENT_NOT_EDITABLE` (FA-04 do módulo dono). */
  readonly lockedDetail?: string;
  /**
   * Permissão exigida no lugar da de edição do tipo (ex.: `PRICE_RESEARCH_EXCLUDE_QUOTATION` — US-027);
   * as demais condições da POL-02 valem iguais.
   */
  readonly permission?: PermissionCode;
}

export interface TypedCollectionState {
  readonly processId: string;
  /** Título do processo (US-036: o título padrão do TR no diálogo de criação). */
  readonly processTitle: string;
  readonly isBudgetConfidential: boolean;
  readonly owner: TypedCollectionOwner | null;
  readonly lockReason: TypedCollectionLockReason | null;
}

export interface TypedCollectionWrite {
  readonly processId: string;
  readonly owner: TypedCollectionOwner | null;
}

const ownerOf = (document: Document | null): TypedCollectionOwner | null =>
  document === null ? null : { id: document.id, code: document.code, status: document.status };

@Injectable()
export class TypedCollectionGuard {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly access: AccessFacade,
  ) {}

  /**
   * Leitura (`PROCESS_VIEW` — DEC-024): processo inexistente, de outro tenant ou não visível → 404
   * `NOT_FOUND`. Devolve o documento dono e, sem lançar nem auditar, se o usuário pode alterar a
   * coleção agora (as ações exibidas na tela).
   */
  async inspect(tx: TenantTx, input: TypedCollectionInput): Promise<TypedCollectionState> {
    const { process, type } = await this.visible(tx, input);
    const owner = await this.documents.findActiveOfType(tx, process.id, type.id);
    return {
      processId: process.id,
      processTitle: process.title,
      isBudgetConfidential: process.isBudgetConfidential,
      owner: ownerOf(owner),
      lockReason: await this.lockReasonOf({ process, type }, owner, input.permission),
    };
  }

  /**
   * Escrita (POL-02): 404 como `inspect`; 403 `PERMISSION_DENIED` (com `access.denied`) sem a
   * permissão do tipo cobrindo o processo ou sem custódia/participação; 409
   * `INVALID_PROCESS_STATUS`; 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`; 409 `DOCUMENT_NOT_EDITABLE`
   * com o documento dono fora de `DRAFT`/`RETURNED`. O documento dono fica travado
   * (`SELECT … FOR UPDATE`) até o fim do `tx`: a finalização concorrente espera ou já venceu.
   */
  async assertWritable(tx: TenantTx, input: TypedCollectionInput): Promise<TypedCollectionWrite> {
    const context = await this.visible(tx, input);
    const actor = await this.lifecycle.actorOf(context);
    await this.lifecycle.authorizePol02(
      context,
      actor,
      'edit',
      input.deniedDetail,
      undefined,
      input.permission,
    );
    const found = await this.documents.findActiveOfType(tx, context.process.id, context.type.id);
    let owner: Document | null = null;
    if (found !== null) {
      await this.documents.lockForUpdate(tx, found.id);
      owner = await this.documents.findById(tx, found.id);
    }
    if (owner !== null && owner.status !== 'CANCELED' && !isEditable(owner)) {
      throw new ApiError('DOCUMENT_NOT_EDITABLE', {
        ...(input.lockedDetail === undefined ? {} : { detail: input.lockedDetail }),
        extensions: { meta: { documentId: owner.id, status: owner.status } },
      });
    }
    return { processId: context.process.id, owner: ownerOf(owner) };
  }

  private async visible(
    tx: TenantTx,
    input: TypedCollectionInput,
  ): Promise<{ readonly process: DocumentProcessContext; readonly type: DocumentType }> {
    const process = await this.processes.load(tx, input.processId);
    const visibility = await this.access.processVisibilityScope();
    if (process === null || !isProcessVisible(visibility, process.access)) {
      throw new ApiError('NOT_FOUND', { detail: 'Processo não encontrado.' });
    }
    const type = (await this.types.list(tx)).find(
      (candidate) => candidate.systemModule === input.systemModule,
    );
    if (type === undefined) {
      throw new Error(`Tipo de sistema ${input.systemModule} ausente no tenant.`);
    }
    return { process, type };
  }

  private async lockReasonOf(
    context: { readonly process: DocumentProcessContext; readonly type: DocumentType },
    owner: Document | null,
    permission?: PermissionCode,
  ): Promise<TypedCollectionLockReason | null> {
    const edit = permission ?? typePermissionsOf(context.type.systemModule).edit;
    if (!(await this.access.canOnProcess(edit, context.process.access))) {
      return 'PERMISSION_DENIED';
    }
    const custody = await this.lifecycle.custodyOf(context.process);
    if (!custody.isCustodian && !custody.isCollaborator) return 'NOT_CUSTODIAN';
    if (!DOCUMENT_EDITABLE_PROCESS_STATUSES.has(context.process.status)) {
      return 'INVALID_PROCESS_STATUS';
    }
    if (!this.lifecycle.processStateOf(context).typeAllowedInStage) {
      return 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE';
    }
    if (owner !== null && !isEditable(owner)) return 'DOCUMENT_NOT_EDITABLE';
    return null;
  }
}
