import type { PermissionCode } from '@contrataflow/types';
import type {
  DocumentAction,
  DocumentSnapshot,
  VersionReason,
  Violation,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { isProcessVisible } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DocumentProcessContextRegistry } from '#shared/document/document-process-context.js';
import type { DocumentProcessContext } from '#shared/document/document-process-context.js';

import {
  documentAlreadyExists,
  documentNotFound,
  documentVersionConflict,
  invalidProcessStatus,
  notCustodianNorCollaborator,
  notProcessCustodian,
  transitionRefused,
  typeNotAllowedInStage,
} from './document.errors.js';
import {
  DOCUMENT_REPOSITORY,
  DocumentAlreadyExistsError,
  DocumentValidatorRegistry,
} from './document.ports.js';
import type {
  DocumentRepository,
  DocumentValidationSubject,
  TypedSnapshotParts,
} from './document.ports.js';
import { DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentTypeRepository } from './ports.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { maskConfidentialSnapshot } from '../domain/confidential-snapshot.js';
import { composeViolations, evaluateGenericCompleteness } from '../domain/document-completeness.js';
import type { CompletenessResult } from '../domain/document-completeness.js';
import { typePermissionsOf } from '../domain/document-permissions.js';
import { buildDocumentSnapshot, snapshotHash } from '../domain/document-snapshot.js';
import type { DocumentVersionRecord } from '../domain/document-snapshot.js';
import type { DocumentTemplateVersion } from '../domain/document-template.js';
import type { DocumentType } from '../domain/document-type.js';
import {
  allowedDocumentActions,
  DOCUMENT_EDITABLE_PROCESS_STATUSES,
  DocumentTransitionError,
} from '../domain/document.js';
import type { Document, DocumentActor, DocumentProcessState } from '../domain/document.js';

/*
 * `DocumentLifecycleService` (US-065 · DEC-018 · RN-DOC-41..55): o padrão de máquina de estados de
 * documento reutilizado por todo o produto — validar → autorizar (POL-01/02/11) → checar completude
 * (genérica + `DocumentValidator` do módulo tipado) → transicionar (domínio puro) → gravar o
 * documento condicionado à `version` → criar a versão (snapshot + SHA-256) → auditar → outbox
 * (timeline síncrona) → commit. Os comandos (`document.commands.ts`) e a fachada (aprovação de
 * etapa — US-051/052) usam estas peças no `tx` do caso de uso.
 */

/** Tudo o que uma transição lê do documento, do tipo, do template e do processo. */
export interface DocumentContext {
  readonly document: Document;
  readonly type: DocumentType;
  readonly template: DocumentTemplateVersion | null;
  readonly process: DocumentProcessContext;
}

/** O que a autorização lê do contexto (vale também sem documento — mapa de riscos da IA). */
export type DocumentAuthorizationContext = Pick<DocumentContext, 'type' | 'process'>;

/** O usuário da requisição diante do documento (permissões cobrindo o processo + POL-01/02). */
export interface ResolvedDocumentActor extends DocumentActor {
  readonly userId: string;
}

/** Completude avaliada (DOC-08) com o que o serviço precisa para a versão. */
export interface DocumentCompleteness extends CompletenessResult {
  readonly violations: readonly Violation[];
}

const NOT_CUSTODIAN_CANCEL =
  'Apenas o responsável atual pelo processo pode cancelar este documento.';
const NOT_CUSTODIAN_REOPEN =
  'Apenas o responsável atual pelo processo pode reabrir este documento.';

@Injectable()
export class DocumentLifecycleService {
  private readonly logger = new Logger('Documents');

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    private readonly processes: DocumentProcessContextRegistry,
    private readonly validators: DocumentValidatorRegistry,
    private readonly access: AccessFacade,
  ) {}

  // --- Leitura ---------------------------------------------------------------------------------

  /**
   * Documento, tipo, template e processo no `tx`; documento inexistente, excluído, de outro tenant
   * ou de processo não visível ao usuário (DEC-024) → 404 indistinguível.
   */
  async load(tx: TenantTx, documentId: string): Promise<DocumentContext> {
    const document = await this.documents.findById(tx, documentId);
    if (document === null) throw documentNotFound();
    const context = await this.loadFor(tx, document);
    const visibility = await this.access.processVisibilityScope();
    if (!isProcessVisible(visibility, context.process.access)) throw documentNotFound();
    return context;
  }

  /** Como `load`, para um documento já lido (sem a checagem de visibilidade — chamadas internas). */
  async loadFor(tx: TenantTx, document: Document): Promise<DocumentContext> {
    const process = await this.processes.load(tx, document.processId);
    if (process === null) throw documentNotFound();
    const type = await this.types.findById(tx, document.documentTypeId);
    if (type === null) throw new Error(`Documento ${document.id} sem tipo no tenant.`);
    const template =
      document.templateVersionId === null
        ? null
        : await this.templates.findVersionById(tx, document.templateVersionId);
    return { document, type, template, process };
  }

  // --- Autorização ----------------------------------------------------------------------------

  /** Permissões do tipo e de ciclo de vida cobrindo o processo, custódia e participação. */
  async actorOf(context: DocumentAuthorizationContext): Promise<ResolvedDocumentActor> {
    const userId = requireRequestContext().actor.userId ?? '';
    const permissions = await this.access.effectivePermissions();
    const target = context.process.access;
    const { edit, submit } = typePermissionsOf(context.type.systemModule);
    const can = (permission: PermissionCode) => this.access.canOnProcess(permission, target);
    const now = Date.now();
    const { process } = context;
    return {
      userId,
      canEditType: await can(edit),
      canSubmitType: await can(submit),
      canReopen: await can('DOCUMENT_REOPEN'),
      canCancel: await can('DOCUMENT_CANCEL'),
      isCustodian:
        process.currentResponsibleId === null
          ? permissions.snapshot.ownDepartmentIds.includes(process.currentDepartmentId)
          : process.currentResponsibleId === userId,
      isCollaborator: target.participations.some(
        (participation) =>
          participation.userId === userId &&
          participation.role !== 'OBSERVER' &&
          (participation.expiresAt === null || participation.expiresAt.getTime() > now),
      ),
    };
  }

  processStateOf(context: DocumentAuthorizationContext): DocumentProcessState {
    const stage = context.process.currentStage;
    return {
      status: context.process.status,
      typeAllowedInStage:
        stage === null ||
        stage.documentTypeCodes.length === 0 ||
        stage.documentTypeCodes.includes(context.type.code),
    };
  }

  /** `meta.allowedActions` (RN-DOC-18): a função pura do domínio sobre o contexto. */
  allowedActions(context: DocumentContext, actor: ResolvedDocumentActor): DocumentAction[] {
    return allowedDocumentActions(
      context.document,
      context.type,
      actor,
      this.processStateOf(context),
    );
  }

  private assertProcessEditable(context: DocumentAuthorizationContext): void {
    if (!DOCUMENT_EDITABLE_PROCESS_STATUSES.has(context.process.status)) {
      throw invalidProcessStatus(context.process.status);
    }
  }

  private assertTypeInStage(context: DocumentAuthorizationContext): void {
    if (!this.processStateOf(context).typeAllowedInStage) throw typeNotAllowedInStage();
  }

  /**
   * POL-02 (editar — DOC-04/14 — e finalizar/submeter — DOC-09/10): permissão do tipo cobrindo o
   * processo (403 + MFA) + custódia ou participação (403) + processo editável (409) + tipo na etapa
   * (422). O status do documento é conferido pela transição.
   */
  async authorizePol02(
    context: DocumentAuthorizationContext,
    actor: ResolvedDocumentActor,
    kind: 'edit' | 'submit',
  ): Promise<void> {
    const permissions = typePermissionsOf(context.type.systemModule);
    await this.access.assertCanOnProcess(
      kind === 'edit' ? permissions.edit : permissions.submit,
      context.process.access,
    );
    if (!actor.isCustodian && !actor.isCollaborator) throw notCustodianNorCollaborator();
    this.assertProcessEditable(context);
    this.assertTypeInStage(context);
  }

  /** POL-11 (DOC-12): `DOCUMENT_REOPEN` + custódia + processo editável + tipo na etapa. */
  async authorizeReopen(context: DocumentContext, actor: ResolvedDocumentActor): Promise<void> {
    await this.access.assertCanOnProcess('DOCUMENT_REOPEN', context.process.access);
    if (!actor.isCustodian) throw notProcessCustodian('POL-11', NOT_CUSTODIAN_REOPEN);
    this.assertProcessEditable(context);
    this.assertTypeInStage(context);
  }

  /** DOC-13: `DOCUMENT_CANCEL` + custódia atual do processo (POL-01, não basta participar). */
  async authorizeCancel(context: DocumentContext, actor: ResolvedDocumentActor): Promise<void> {
    await this.access.assertCanOnProcess('DOCUMENT_CANCEL', context.process.access);
    if (!actor.isCustodian) throw notProcessCustodian('POL-01', NOT_CUSTODIAN_CANCEL);
    this.assertProcessEditable(context);
  }

  /**
   * POL-09 sobre o processo do documento (RN-DOC-61): `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o
   * processo (sem o 2º fator exigido não conta — POL-14/FA-12) ou a custódia atual. Mesma regra de
   * `canViewConfidentialBudget` do módulo `process` (lista e timeline), avaliada sobre o contexto
   * já carregado. Quem decide SE mascarar (processo sigiloso agora ou no momento da versão) é quem
   * chama.
   */
  async canViewConfidentialBudget(context: DocumentAuthorizationContext): Promise<boolean> {
    const { scope, custodyDepartmentIds } = await this.access.confidentialBudgetAccess();
    const { process } = context;
    if (scope.tenantWide) return true;
    if (scope.organizationIds.includes(process.organizationId)) return true;
    if (process.currentResponsibleId === scope.userId) return true;
    if (
      process.currentResponsibleId === null &&
      custodyDepartmentIds.includes(process.currentDepartmentId)
    ) {
      return true;
    }
    return process.access.departmentIds.some((id) => scope.departmentIds.includes(id));
  }

  /**
   * O snapshot como o usuário pode vê-lo (RN-DOC-61): mascara quando o processo é sigiloso agora OU
   * era quando alguma das versões foi gravada (tornar o orçamento público depois não revela o
   * retrato antigo) e o usuário não atende POL-09. Nas duas versões de uma comparação, igual.
   */
  async confidentialMasker(
    context: DocumentAuthorizationContext,
    versions: readonly DocumentVersionRecord[],
  ): Promise<(content: DocumentSnapshot | null) => DocumentSnapshot | null> {
    const confidential =
      context.process.isBudgetConfidential ||
      versions.some((version) => version.content?.process.isBudgetConfidential === true);
    const mask = confidential && !(await this.canViewConfidentialBudget(context));
    return (content) => (content === null || !mask ? content : maskConfidentialSnapshot(content));
  }

  /** `If-Match` divergente da versão lida → 412 com a versão atual (V-09). */
  assertVersion(context: DocumentContext, expectedVersion: number): void {
    if (context.document.version !== expectedVersion) {
      throw documentVersionConflict(context.document.version);
    }
  }

  /** Executa a transição pura do domínio, traduzindo a recusa em 409 (V-04/V-05/V-07). */
  transition<T>(apply: () => T): T {
    try {
      return apply();
    } catch (error) {
      if (error instanceof DocumentTransitionError) throw transitionRefused(error);
      throw error;
    }
  }

  // --- Completude (DOC-08 · RN-DOC-51) ---------------------------------------------------------

  private subjectOf(context: DocumentContext): DocumentValidationSubject {
    return { document: context.document, type: context.type, template: context.template };
  }

  /** Cabeçalho e coleções do módulo tipado (vazios sem validador ou sem `snapshotParts`). */
  private async typedParts(
    tx: TenantTx,
    context: DocumentContext,
  ): Promise<TypedSnapshotParts | null> {
    const validator = this.validators.find(context.type.systemModule);
    if (!validator?.snapshotParts) return null;
    return validator.snapshotParts(tx, this.subjectOf(context));
  }

  /**
   * Regras genéricas + as do `DocumentValidator` do módulo tipado, num único `violations[]`. Tipo
   * sem validador registrado usa só as genéricas (nunca falha por ausência de registro); campos de
   * cabeçalho obrigatórios só são conferidos quando o módulo informa o cabeçalho.
   */
  async evaluate(tx: TenantTx, context: DocumentContext): Promise<DocumentCompleteness> {
    const parts = await this.typedParts(tx, context);
    const fieldConfig = context.template?.fieldConfig ?? {};
    const generic = evaluateGenericCompleteness({
      document: context.document,
      kind: context.type.kind,
      sections: context.template?.sections ?? [],
      requiredHeaderFields:
        parts === null
          ? []
          : Object.entries(fieldConfig)
              .filter(([, entry]) => entry.required === true)
              .map(([field, entry]) => ({ field, label: entry.label ?? field })),
      header: parts?.header ?? {},
    });
    const validator = this.validators.find(context.type.systemModule);
    const typed = validator ? await validator.validate(tx, this.subjectOf(context)) : [];
    return { sections: generic.sections, violations: composeViolations(generic.violations, typed) };
  }

  /** `typedSummary` do evento `DocumentFinalized` (RN-DOC-52); só `STRUCTURED` com validador. */
  async typedSummary(
    tx: TenantTx,
    context: DocumentContext,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    if (context.type.kind !== 'STRUCTURED') return null;
    const validator = this.validators.find(context.type.systemModule);
    if (!validator?.typedSummary) return null;
    return validator.typedSummary(tx, this.subjectOf(context));
  }

  logCompletenessBlocked(documentId: string, violations: readonly Violation[]): void {
    this.logger.warn(
      {
        event: 'document.completeness_blocked',
        documentId,
        blocking: violations.filter((item) => item.severity === 'BLOCKING').length,
        correlationId: requireRequestContext().correlationId,
      },
      'document.completeness_blocked',
    );
  }

  // --- Escrita ---------------------------------------------------------------------------------

  /**
   * Grava o documento transicionado com `version + 1`, condicionado à versão lida; perdedor da
   * corrida → 412 `VERSION_CONFLICT` com a versão vencedora (nada mais é gravado).
   */
  async save(tx: TenantTx, next: Document, expectedVersion: number): Promise<Document> {
    try {
      await this.documents.update(tx, next, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const fresh = await this.documents.findById(tx, next.id);
        throw documentVersionConflict(fresh?.version ?? expectedVersion + 1);
      }
      if (error instanceof DocumentAlreadyExistsError) throw documentAlreadyExists(null);
      throw error;
    }
    return { ...next, version: expectedVersion + 1 };
  }

  /**
   * Versão imutável do documento já transicionado (RN-DOC-53): snapshot (cabeçalho, seções e
   * coleções) com `contentHash` SHA-256 do JSON canônico; `UPLOADED` congela o arquivo da versão
   * corrente (conteúdo nulo, hash do arquivo — US-064).
   */
  async createVersion(
    tx: TenantTx,
    context: DocumentContext,
    input: {
      readonly document: Document;
      readonly versionId: string;
      readonly versionNumber: number;
      readonly reason: VersionReason;
      readonly actorId: string;
      readonly now: Date;
      /** Resumo da alteração (só `MANUAL` — RN-DOC-62); texto simples, nunca logado. */
      readonly changeSummary?: string | null;
    },
  ): Promise<DocumentVersionRecord> {
    const { document } = input;
    let content: DocumentVersionRecord['content'] = null;
    let contentHash: string;
    let attachmentId: string | null = null;
    if (context.type.kind === 'UPLOADED') {
      const previousId = context.document.currentVersionId;
      const previous =
        previousId === null ? null : await this.documents.findVersion(tx, previousId);
      if (previous === null) throw new Error(`Documento externo ${document.id} sem arquivo.`);
      contentHash = previous.contentHash;
      attachmentId = previous.attachmentId;
    } else {
      const parts = await this.typedParts(tx, context);
      const { process, template } = context;
      content = buildDocumentSnapshot({
        document,
        type: { code: context.type.code, kind: context.type.kind },
        template:
          template === null
            ? null
            : {
                templateId: template.templateId,
                versionId: template.id,
                versionNumber: template.versionNumber,
              },
        process: {
          id: process.id,
          code: process.code,
          title: process.title,
          object: process.object,
          organizationName: process.organizationName,
          organizationCnpj: process.organizationCnpj,
          requestingSecretariatName: process.requestingSecretariatName,
          requestingDepartmentName: process.requestingDepartmentName,
          isBudgetConfidential: process.isBudgetConfidential,
        },
        versionNumber: input.versionNumber,
        header: parts?.header ?? {},
        collections: parts?.collections ?? {},
        generatedAt: input.now,
      });
      contentHash = snapshotHash(content);
    }
    const version: DocumentVersionRecord = {
      id: input.versionId,
      tenantId: document.tenantId,
      documentId: document.id,
      processId: document.processId,
      versionNumber: input.versionNumber,
      reason: input.reason,
      statusAtCreation: document.status,
      content,
      contentHash,
      attachmentId,
      templateVersionId: document.templateVersionId,
      changeSummary: input.changeSummary ?? null,
      createdById: input.actorId,
      createdAt: input.now,
    };
    await this.documents.insertVersion(tx, version);
    this.logger.log(
      {
        event: 'document.version_create',
        documentId: document.id,
        documentVersionId: version.id,
        versionNumber: version.versionNumber,
        reason: version.reason,
      },
      'document.version_create',
    );
    return version;
  }

  nextVersionNumber(tx: TenantTx, documentId: string): Promise<number> {
    return this.documents.nextVersionNumber(tx, documentId);
  }

  /** Trava a linha do documento até o fim do `tx` (RN-DOC-58 — "Salvar versão" concorrente). */
  lockForVersioning(tx: TenantTx, documentId: string): Promise<void> {
    return this.documents.lockForUpdate(tx, documentId);
  }

  listVersions(
    tx: TenantTx,
    documentId: string,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ readonly items: DocumentVersionRecord[]; readonly total: number }> {
    return this.documents.listVersions(tx, documentId, window);
  }

  findVersion(tx: TenantTx, versionId: string): Promise<DocumentVersionRecord | null> {
    return this.documents.findVersion(tx, versionId);
  }
}
