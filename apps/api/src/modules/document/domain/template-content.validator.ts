import {
  isRenderAllowed,
  LAYOUT_TEMPLATE_VARIABLES,
  richTextPlainText,
  SECTION_KEY_PATTERN,
  SECTION_TEMPLATE_VARIABLES,
  templateVariablesIn,
  TYPED_HEADER_FIELDS,
  unknownVariableMessage,
} from '@contrataflow/validation';
import type {
  DocumentKind,
  FieldConfig,
  ImportMappings,
  LayoutDefinition,
  SectionDefinition,
  SystemDocumentModule,
  Violation,
} from '@contrataflow/validation';

/*
 * `TemplateContentValidator` (US-107 · RN-TPL-04..09): regras de conteúdo da versão de template,
 * consolidadas em `violations[]` (api.md §2.1.2) com o código estável de cada achado e a seção
 * afetada em `sectionKey`. É o mesmo serviço da publicação (US-108), que chama com o escopo
 * completo — o que o editor aceita e o que a publicação aceita não divergem. Função pura.
 */

export const TEMPLATE_VIOLATION_CODES = [
  'TEMPLATE_SECTION_KEY_INVALID',
  'TEMPLATE_SECTION_KEY_DUPLICATE',
  'TEMPLATE_SECTION_ORDER_INVALID',
  'TEMPLATE_RENDER_NOT_ALLOWED',
  'TEMPLATE_VARIABLE_UNKNOWN',
  'TEMPLATE_FIELD_CONFIG_NOT_ALLOWED',
  'TEMPLATE_FIELD_UNKNOWN',
  'TEMPLATE_IMPORT_MAPPINGS_NOT_ALLOWED',
  'TEMPLATE_IMPORT_TARGET_UNKNOWN',
  'TEMPLATE_IMPORT_TARGET_DUPLICATE',
  'TEMPLATE_IMPORT_SOURCE_UNKNOWN',
  'TEMPLATE_IMPORT_FIELD_UNKNOWN',
] as const;
export type TemplateViolationCode = (typeof TEMPLATE_VIOLATION_CODES)[number];

export interface TemplateContent {
  readonly sections: readonly SectionDefinition[];
  readonly fieldConfig: FieldConfig;
  readonly importMappings: ImportMappings | null;
  /** Layout de impressão (US-109): variáveis de cabeçalho/rodapé — RN-TPL-22. */
  readonly layout?: LayoutDefinition;
}

export interface TemplateValidationContext {
  readonly documentType: {
    readonly kind: DocumentKind;
    readonly systemModule: SystemDocumentModule | null;
  };
  /**
   * Origem do mapeamento TR ← ETP (RN-TPL-08): seções da versão publicada do template ETP padrão
   * do tenant e campos do cabeçalho do ETP. `null` quando o tipo não é TR.
   */
  readonly importSources: {
    readonly sectionKeys: readonly string[];
    readonly fieldKeys: readonly string[];
  } | null;
}

/**
 * Partes conferidas. O rascunho (TPL-08) confere as partes enviadas — um mapeamento já salvo não
 * impede de adicionar seções antes de ajustá-lo —; a publicação (US-108) confere tudo.
 */
export interface TemplateValidationScope {
  readonly sections: boolean;
  readonly fieldConfig: boolean;
  readonly importMappings: boolean;
  /** Cabeçalho/rodapé do layout (US-109); omitido = não confere. */
  readonly layout?: boolean;
}

export const FULL_VALIDATION: TemplateValidationScope = {
  sections: true,
  fieldConfig: true,
  importMappings: true,
  layout: true,
};

export const RENDER_NOT_ALLOWED_MESSAGE =
  'Este tipo de bloco não é permitido para este tipo de documento.';
export const IMPORT_SECTION_UNKNOWN_MESSAGE = 'O mapeamento referencia uma seção que não existe.';

function violation(
  code: TemplateViolationCode,
  message: string,
  at: { sectionKey?: string | null; field?: string | null; params?: Record<string, unknown> } = {},
): Violation {
  return {
    code,
    severity: 'BLOCKING',
    message,
    ruleId: null,
    sectionKey: at.sectionKey ?? null,
    field: at.field ?? null,
    itemId: null,
    params: at.params ?? {},
  };
}

const allowedVariables: ReadonlySet<string> = new Set(SECTION_TEMPLATE_VARIABLES);
const layoutVariables: ReadonlySet<string> = new Set(LAYOUT_TEMPLATE_VARIABLES);

/**
 * RN-TPL-22: cabeçalho e rodapé aceitam o catálogo completo de §5.2 — inclusive `page`, `pages`,
 * `document.hash` e `document.version`, resolvidas na renderização do PDF.
 */
function layoutViolations(layout: LayoutDefinition | undefined): Violation[] {
  if (layout === undefined) return [];
  const found: Violation[] = [];
  for (const field of ['header', 'footer'] as const) {
    for (const variable of templateVariablesIn(richTextPlainText(layout[field]))) {
      if (layoutVariables.has(variable)) continue;
      found.push(
        violation('TEMPLATE_VARIABLE_UNKNOWN', unknownVariableMessage(variable), {
          field: `layout.${field}`,
          params: { variable },
        }),
      );
    }
  }
  return found;
}

function sectionViolations(
  sections: readonly SectionDefinition[],
  context: TemplateValidationContext,
): Violation[] {
  const found: Violation[] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const section of sections) {
    const { key } = section;
    if (!SECTION_KEY_PATTERN.test(key)) {
      found.push(
        violation(
          'TEMPLATE_SECTION_KEY_INVALID',
          `A chave "${key}" deve usar letras maiúsculas, números e _ (ex.: OBJETO).`,
          { sectionKey: key, field: 'key' },
        ),
      );
    }
    if (seen.has(key) && !duplicated.has(key)) {
      duplicated.add(key);
      found.push(
        violation('TEMPLATE_SECTION_KEY_DUPLICATE', `A chave "${key}" já existe nesta versão.`, {
          sectionKey: key,
          field: 'key',
        }),
      );
    }
    seen.add(key);

    if (!isRenderAllowed(section.render, context.documentType)) {
      found.push(
        violation('TEMPLATE_RENDER_NOT_ALLOWED', RENDER_NOT_ALLOWED_MESSAGE, {
          sectionKey: key,
          field: 'render',
          params: { render: section.render },
        }),
      );
    }

    const texts: [string, string][] = [
      ['helpText', section.helpText ?? ''],
      ['defaultContent', richTextPlainText(section.defaultContent)],
    ];
    for (const [field, text] of texts) {
      for (const variable of templateVariablesIn(text)) {
        if (allowedVariables.has(variable)) continue;
        found.push(
          violation('TEMPLATE_VARIABLE_UNKNOWN', unknownVariableMessage(variable), {
            sectionKey: key,
            field,
            params: { variable },
          }),
        );
      }
    }
  }

  // RN-TPL-04: ordem sequencial a partir de 1 (sem repetição nem buracos).
  const orders = sections.map((section) => section.order).sort((a, b) => a - b);
  const firstGap = orders.findIndex((order, index) => order !== index + 1);
  if (firstGap >= 0) {
    const offending = sections.find((section) => section.order === orders[firstGap]);
    found.push(
      violation(
        'TEMPLATE_SECTION_ORDER_INVALID',
        'A ordem das seções deve ser sequencial a partir de 1, sem repetição.',
        { sectionKey: offending?.key ?? null, field: 'order' },
      ),
    );
  }
  return found;
}

function fieldConfigViolations(
  fieldConfig: FieldConfig,
  context: TemplateValidationContext,
): Violation[] {
  const keys = Object.keys(fieldConfig);
  if (keys.length === 0) return [];
  const { kind, systemModule } = context.documentType;
  if (kind !== 'STRUCTURED' || systemModule === null) {
    return [
      violation(
        'TEMPLATE_FIELD_CONFIG_NOT_ALLOWED',
        'Este tipo de documento não tem campos tipados para configurar.',
        { field: 'fieldConfig' },
      ),
    ];
  }
  const known = new Set(TYPED_HEADER_FIELDS[systemModule]);
  return keys
    .filter((key) => !known.has(key))
    .map((key) =>
      violation(
        'TEMPLATE_FIELD_UNKNOWN',
        `O campo "${key}" não existe no cabeçalho deste tipo de documento.`,
        { field: `fieldConfig.${key}`, params: { fieldKey: key } },
      ),
    );
}

function importMappingViolations(
  mappings: ImportMappings | null,
  sections: readonly SectionDefinition[],
  context: TemplateValidationContext,
): Violation[] {
  if (mappings === null) return [];
  if (context.documentType.systemModule !== 'TERM_OF_REFERENCE' || !context.importSources) {
    return [
      violation(
        'TEMPLATE_IMPORT_MAPPINGS_NOT_ALLOWED',
        'O mapeamento de importação só existe no Termo de Referência.',
        { field: 'importMappings' },
      ),
    ];
  }
  const found: Violation[] = [];
  const targets = new Set(sections.map((section) => section.key));
  const sources = new Set(context.importSources.sectionKeys);
  const mapped = new Set<string>();
  for (const mapping of mappings.sections) {
    if (!targets.has(mapping.target)) {
      found.push(
        violation('TEMPLATE_IMPORT_TARGET_UNKNOWN', IMPORT_SECTION_UNKNOWN_MESSAGE, {
          sectionKey: mapping.target,
          field: 'importMappings.sections.target',
          params: { target: mapping.target },
        }),
      );
    }
    if (mapped.has(mapping.target)) {
      found.push(
        violation(
          'TEMPLATE_IMPORT_TARGET_DUPLICATE',
          `A seção "${mapping.target}" já tem um mapeamento.`,
          { sectionKey: mapping.target, field: 'importMappings.sections.target' },
        ),
      );
    }
    mapped.add(mapping.target);
    for (const source of mapping.sources) {
      if (sources.has(source)) continue;
      found.push(
        violation('TEMPLATE_IMPORT_SOURCE_UNKNOWN', IMPORT_SECTION_UNKNOWN_MESSAGE, {
          sectionKey: mapping.target,
          field: 'importMappings.sections.sources',
          params: { source },
        }),
      );
    }
  }
  const targetFields = new Set(TYPED_HEADER_FIELDS.TERM_OF_REFERENCE);
  const sourceFields = new Set(context.importSources.fieldKeys);
  for (const field of mappings.fields) {
    if (targetFields.has(field.target) && sourceFields.has(field.source)) continue;
    found.push(
      violation(
        'TEMPLATE_IMPORT_FIELD_UNKNOWN',
        'O mapeamento referencia um campo que não existe.',
        {
          field: 'importMappings.fields',
          params: { target: field.target, source: field.source },
        },
      ),
    );
  }
  return found;
}

/** Achados de conteúdo da versão (vazio = conteúdo válido). */
export function validateTemplateContent(
  content: TemplateContent,
  context: TemplateValidationContext,
  scope: TemplateValidationScope = FULL_VALIDATION,
): Violation[] {
  return [
    ...(scope.sections ? sectionViolations(content.sections, context) : []),
    ...(scope.fieldConfig ? fieldConfigViolations(content.fieldConfig, context) : []),
    ...(scope.importMappings
      ? importMappingViolations(content.importMappings, content.sections, context)
      : []),
    ...(scope.layout === true ? layoutViolations(content.layout) : []),
  ];
}

/** Serviço único de validação de conteúdo — editor (US-107) e publicação (US-108). */
export class TemplateContentValidator {
  validate(
    content: TemplateContent,
    context: TemplateValidationContext,
    scope: TemplateValidationScope = FULL_VALIDATION,
  ): Violation[] {
    return validateTemplateContent(content, context, scope);
  }
}
