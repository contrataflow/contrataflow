import { SYSTEM_MODULE_SECTION_KEYS, TYPED_HEADER_FIELDS } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import type { TenantTx } from '#shared/database/prisma.js';

import { DocumentTypeFacade } from './document-type.facade.js';
import { DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentTransactions } from './ports.js';
import { TEMPLATE_REPOSITORY } from './template.ports.js';
import type { TemplateRepository } from './template.ports.js';
import { templateDocumentTypeOf, toDefaultTemplateView } from './template.view.js';
import type { DefaultTemplateView } from './template.view.js';
import type { DocumentTemplate, TemplateDocumentType } from '../domain/document-template.js';
import type { DocumentType } from '../domain/document-type.js';
import type { TemplateValidationContext } from '../domain/template-content.validator.js';

/** Tipos do tenant como os templates os veem, lidos uma vez (do cache) antes da transação. */
export interface TemplateTypeCatalog {
  readonly byId: ReadonlyMap<string, TemplateDocumentType>;
  /** Template padrão do tipo ETP (origem do mapeamento TR ← ETP — RN-TPL-08). */
  readonly etpDefaultTemplateId: string | null;
  /** Templates padrão de tipos ativos (`isDefault` — DTY-04). */
  readonly defaultTemplateIds: ReadonlySet<string>;
}

/**
 * Contexto dos casos de uso de template (US-107): o tipo de documento do template (do catálogo em
 * cache — `DocumentTypeFacade`) e a origem do mapeamento TR ← ETP (RN-TPL-08).
 */
@Injectable()
export class TemplateContext {
  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    private readonly documentTypes: DocumentTypeFacade,
  ) {}

  /** Uma leitura do catálogo de tipos (cache por tenant), fora de qualquer transação. */
  async catalog(): Promise<TemplateTypeCatalog> {
    const types = await this.documentTypes.listAll();
    const etp = types.find((type) => type.systemModule === 'ETP');
    return {
      byId: new Map(types.map((type) => [type.id, templateDocumentTypeOf(type)])),
      etpDefaultTemplateId: etp?.defaultTemplateId ?? null,
      defaultTemplateIds: new Set(
        types.flatMap((type) =>
          type.isActive && type.defaultTemplateId ? [type.defaultTemplateId] : [],
        ),
      ),
    };
  }

  /** O template é o padrão do seu tipo ativo. */
  isDefault(catalog: TemplateTypeCatalog, template: DocumentTemplate): boolean {
    return catalog.defaultTemplateIds.has(template.id);
  }

  /** `defaultTemplate` de cada tipo com template padrão (DTY-01/03/04), numa leitura. */
  async defaultTemplatesOf(
    types: readonly DocumentType[],
  ): Promise<ReadonlyMap<string, DefaultTemplateView>> {
    const ids = [
      ...new Set(types.flatMap((type) => (type.defaultTemplateId ? [type.defaultTemplateId] : []))),
    ];
    if (ids.length === 0) return new Map();
    return this.transactions.read(async (tx) => {
      const views = new Map<string, DefaultTemplateView>();
      for (const id of ids) {
        const template = await this.templates.findById(tx, id);
        if (!template) continue;
        const published = template.currentPublishedVersionId
          ? await this.templates.findVersionById(tx, template.currentPublishedVersionId)
          : null;
        views.set(id, toDefaultTemplateView(template, published));
      }
      return views;
    });
  }

  /** Tipo do template no catálogo (a FK composta garante o tipo no mesmo tenant). */
  typeOf(catalog: TemplateTypeCatalog, template: DocumentTemplate): TemplateDocumentType {
    const type = catalog.byId.get(template.documentTypeId);
    if (!type)
      throw new Error(`Tipo ${template.documentTypeId} do template ${template.id} ausente.`);
    return type;
  }

  /**
   * RN-TPL-08: seções da versão publicada corrente do template ETP padrão do tenant e campos do
   * cabeçalho do ETP. Sem template ETP padrão publicado (antes da US-108/US-110), valem as seções
   * de referência do ETP (entities.md §4.8). `null` fora do TR.
   */
  async importSourcesFor(
    tx: TenantTx,
    catalog: TemplateTypeCatalog,
    type: TemplateDocumentType,
  ): Promise<TemplateValidationContext['importSources']> {
    if (type.systemModule !== 'TERM_OF_REFERENCE') return null;
    const defaultTemplate = catalog.etpDefaultTemplateId
      ? await this.templates.findById(tx, catalog.etpDefaultTemplateId)
      : null;
    const published = defaultTemplate?.currentPublishedVersionId
      ? await this.templates.findVersionById(tx, defaultTemplate.currentPublishedVersionId)
      : null;
    return {
      sectionKeys: published
        ? published.sections.map((section) => section.key)
        : SYSTEM_MODULE_SECTION_KEYS.ETP,
      fieldKeys: TYPED_HEADER_FIELDS.ETP,
    };
  }
}

interface TemplateInstruments {
  readonly created: Counter;
  readonly contentUpdates: Counter;
  readonly lifecycle: Counter;
}

let instruments: TemplateInstruments | undefined;

/** Métricas de templates (US-107 · DoD: criação e atualização). */
function templateInstruments(): TemplateInstruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('contrataflow-api');
  instruments = {
    created: meter.createCounter('cf_template_created_total', {
      description: 'Templates de documento criados (com a versão 1 em rascunho).',
    }),
    contentUpdates: meter.createCounter('cf_template_content_updates_total', {
      description:
        'Atualizações de conteúdo de rascunho de template por resultado (updated/invalid).',
    }),
    lifecycle: meter.createCounter('cf_template_version_lifecycle_total', {
      description:
        'Ciclo de vida de versões de template por ação (created/published/publish_invalid/retired).',
    }),
  };
  return instruments;
}

export function recordTemplateCreated(): void {
  templateInstruments().created.add(1);
}

export function recordTemplateContentUpdate(result: 'updated' | 'invalid'): void {
  templateInstruments().contentUpdates.add(1, { result });
}

/** Métrica de publicação/aposentadoria (US-108 · DoD). */
export function recordTemplateVersionLifecycle(
  action: 'created' | 'published' | 'publish_invalid' | 'retired',
): void {
  templateInstruments().lifecycle.add(1, { action });
}
