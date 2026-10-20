import { SYSTEM_MODULE_SECTION_KEYS, TYPED_HEADER_FIELDS } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { DocumentTypeFacade } from './document-type.facade.js';
import { DOCUMENT_TRANSACTIONS, DOCUMENT_TYPE_REPOSITORY } from './ports.js';
import type { DocumentTransactions, DocumentTypeRepository } from './ports.js';
import { recordTemplateLibrarySeeded } from './template-context.js';
import { TEMPLATE_LIBRARY, TEMPLATE_REPOSITORY, TemplateNameTakenError } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { templateDocumentTypeOf } from './template.view.js';
import { publishTemplateVersion, templateNameKey } from '../domain/document-template.js';
import { setDefaultTemplate } from '../domain/document-type.js';
import type { DocumentType } from '../domain/document-type.js';
import type { TemplateValidationContext } from '../domain/template-content.validator.js';
import {
  createSystemTemplate,
  loadTemplateLibrary,
  TEMPLATE_LIBRARY_VERSION,
  TemplateLibraryInvalidError,
} from '../domain/template-library.js';
import type { LoadedTemplateLibraryEntry } from '../domain/template-library.js';

/** Corrida de duas execuções no mesmo tenant: a outra criou o template primeiro (RN-TPL-33). */
class SeedRaceLost extends Error {
  constructor() {
    super('Template semeado por outra execução.');
    this.name = 'SeedRaceLost';
  }
}

/** Template de sistema (ou com o nome reservado) já existente no tipo. */
function alreadySeeded(
  templates: readonly { readonly isSystem: boolean; readonly name: string }[],
  entry: LoadedTemplateLibraryEntry,
): boolean {
  const reserved = templateNameKey(entry.name);
  return templates.some(
    (template) => template.isSystem || templateNameKey(template.name) === reserved,
  );
}

/** Teto de templates lidos por tipo na checagem de idempotência (um tipo tem poucos modelos). */
const TEMPLATES_PER_TYPE_SCAN = 500;

/**
 * Seeder `document.templateLibrary` (US-110 · `SeedTemplateLibraryStep` · RN-TPL-28..34): para cada
 * tipo semeado com template, cria o `DocumentTemplate` `isSystem = true` com a versão 1 já
 * `PUBLISHED` — publicada pela MESMA `publishTemplateVersion` do editor (validação completa e
 * `contentHash` RFC 8785) — e o define como `defaultTemplateId` do tipo quando ele ainda não tem um.
 * Uma `TenantTransaction` por tipo: a falha a meio nunca deixa template parcial, e a reexecução só
 * semeia os tipos pendentes (idempotente pelo template de sistema do tipo e pelo índice único
 * `(tenant_id, document_type_id, lower(name))`). A biblioteca é conferida inteira ANTES de qualquer
 * escrita (V-01). Sem auditoria por item nem evento: integra `tenant.provision`/`TenantProvisioned`.
 */
@Injectable()
export class TemplateLibrarySeeder implements TenantSeeder {
  readonly key = 'document.templateLibrary';
  readonly module = 'document';
  readonly version = TEMPLATE_LIBRARY_VERSION;
  readonly dependsOn: readonly string[] = ['document.systemTypes'];
  readonly applyToExistingTenants = true;

  private readonly logger = new Logger('Templates');

  constructor(
    @Inject(TEMPLATE_LIBRARY) private readonly library: unknown,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TYPE_REPOSITORY) private readonly types: DocumentTypeRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    private readonly documentTypes: DocumentTypeFacade,
  ) {}

  async seed(ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const startedAt = performance.now();
    const { correlationId } = requireRequestContext();
    const entries = this.load(ctx, correlationId);

    let created = 0;
    let skipped = 0;
    try {
      for (const entry of entries) {
        try {
          const seeded = await this.seedOne(ctx, entry);
          if (seeded) created += 1;
          else skipped += 1;
        } catch (error) {
          this.logger.error(
            {
              event: 'template_library.seed_failed',
              tenantId: ctx.tenantId,
              documentTypeCode: entry.documentTypeCode,
              cause: error instanceof Error ? error.name : 'erro',
              correlationId,
            },
            'template_library.seed_failed',
          );
          this.logger.debug(error);
          throw error;
        }
      }
    } finally {
      // O tipo ganhou `defaultTemplateId`: o catálogo em cache precisa recarregar.
      if (created > 0) {
        recordTemplateLibrarySeeded(created);
        await this.documentTypes.invalidate();
      }
    }
    this.logger.log(
      {
        event: 'template_library.seeded',
        tenantId: ctx.tenantId,
        created,
        skipped,
        version: TEMPLATE_LIBRARY_VERSION,
        durationMs: Math.round(performance.now() - startedAt),
        correlationId,
      },
      'template_library.seeded',
    );
    return { created, skipped };
  }

  async verify(_ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const codes = new Set(this.expectedCodes());
    const found = await this.transactions.read(async (tx) => {
      let count = 0;
      for (const type of await this.types.list(tx)) {
        if (!codes.has(type.code)) continue;
        const { items } = await this.templates.list(tx, {
          documentTypeId: type.id,
          skip: 0,
          take: TEMPLATES_PER_TYPE_SCAN,
        });
        if (items.some((t) => t.isSystem && t.currentPublishedVersionId !== null)) count += 1;
      }
      return count;
    });
    return { status: found === codes.size ? 'DONE' : 'PENDING', details: { templates: found } };
  }

  /** Códigos da biblioteca (sem validar — o checklist não deve falhar por ela). */
  private expectedCodes(): string[] {
    if (!Array.isArray(this.library)) return [];
    return (this.library as unknown[]).flatMap((item) => {
      const code = (item as { documentTypeCode?: unknown } | null)?.documentTypeCode;
      return typeof code === 'string' ? [code] : [];
    });
  }

  /** V-01 / Falha de integração: biblioteca ilegível ou inválida falha a etapa sem escrever nada. */
  private load(ctx: TenantSeedContext, correlationId: string): LoadedTemplateLibraryEntry[] {
    try {
      return loadTemplateLibrary(this.library);
    } catch (error) {
      this.logger.error(
        {
          event: 'template_library.seed_failed',
          tenantId: ctx.tenantId,
          documentTypeCode:
            error instanceof TemplateLibraryInvalidError ? error.documentTypeCode : null,
          code: 'TEMPLATE_INVALID',
          correlationId,
        },
        'template_library.seed_failed',
      );
      throw error;
    }
  }

  /** Um tipo numa transação própria; `false` = já semeado (reexecução ou corrida). */
  private async seedOne(ctx: TenantSeedContext, entry: LoadedTemplateLibraryEntry) {
    try {
      return await this.transactions.run((tx) => this.create(tx, ctx, entry));
    } catch (error) {
      // A transação abortada pela violação única já foi desfeita; a outra execução venceu.
      if (error instanceof SeedRaceLost) return false;
      throw error;
    }
  }

  private async create(
    tx: TenantTx,
    ctx: TenantSeedContext,
    entry: LoadedTemplateLibraryEntry,
  ): Promise<boolean> {
    const type = await this.types.findByCode(tx, entry.documentTypeCode);
    if (!type) {
      throw new Error(
        `Tipo ${entry.documentTypeCode} ausente: rode o seeder document.systemTypes antes.`,
      );
    }
    const { items } = await this.templates.list(tx, {
      documentTypeId: type.id,
      skip: 0,
      take: TEMPLATES_PER_TYPE_SCAN,
    });
    if (alreadySeeded(items, entry)) return false;

    const { template, draft } = createSystemTemplate(entry, {
      templateId: newId(),
      versionId: newId(),
      tenantId: ctx.tenantId,
      documentTypeId: type.id,
      now: ctx.now,
    });
    // RN-TPL-34: a mesma publicação do editor (lança `TemplateContentInvalidError`).
    const publication = publishTemplateVersion(
      template,
      draft,
      await this.validationContext(tx, type),
      { now: ctx.now, userId: null },
    );
    try {
      await this.templates.insert(tx, template, draft);
    } catch (error) {
      if (error instanceof TemplateNameTakenError) throw new SeedRaceLost();
      throw error;
    }
    await this.templates.publishVersion(tx, publication.version, draft.version);
    await this.templates.updateCurrentPublishedVersion(tx, publication.template, template.version);

    // Nunca sobrescreve o padrão escolhido pelo órgão (tenant existente — `tenant:seed`).
    if (type.defaultTemplateId === null) {
      const { next } = setDefaultTemplate(type, publication.template, {
        now: ctx.now,
        userId: null,
      });
      await this.types.update(tx, next, type.version);
    }
    return true;
  }

  /**
   * Contexto da publicação: no TR, o mapeamento TR ← ETP confere com as seções da versão publicada
   * do template ETP padrão (o semeado logo antes, na ordem da biblioteca — RN-TPL-08).
   */
  private async validationContext(
    tx: TenantTx,
    type: DocumentType,
  ): Promise<TemplateValidationContext> {
    const documentType = templateDocumentTypeOf(type);
    if (type.systemModule !== 'TERM_OF_REFERENCE') return { documentType, importSources: null };
    const etp = (await this.types.list(tx)).find((other) => other.systemModule === 'ETP');
    const etpTemplate = etp?.defaultTemplateId
      ? await this.templates.findById(tx, etp.defaultTemplateId)
      : null;
    const published = etpTemplate?.currentPublishedVersionId
      ? await this.templates.findVersionById(tx, etpTemplate.currentPublishedVersionId)
      : null;
    return {
      documentType,
      importSources: {
        sectionKeys: published
          ? published.sections.map((section) => section.key)
          : SYSTEM_MODULE_SECTION_KEYS.ETP,
        fieldKeys: TYPED_HEADER_FIELDS.ETP,
      },
    };
  }
}
