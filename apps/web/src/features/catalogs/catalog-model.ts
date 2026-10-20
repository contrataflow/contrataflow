import { CATALOG_TYPES, ITEM_KINDS, PCA_STATUSES } from '@contrataflow/types';
import type { CatalogType } from '@contrataflow/types';
import {
  CATALOG_CODE_MESSAGE,
  CATALOG_CODE_PATTERN,
  PRICE_SOURCE_AGE_REFERENCES,
  PRICE_SOURCE_REQUIRED_FIELDS,
  catalogMetadataSchema,
} from '@contrataflow/validation';
import type { CatalogItemDto } from '@contrataflow/validation';

import type { CatalogItemBody } from './catalogs.api';

/*
 * Modelo do formulário e da lista do SCR-109 (US-104): descritores dos campos de `metadata` por
 * `catalogType` (entities.md §5.9), conversão formulário ↔ corpo da API e validação com os MESMOS
 * schemas Zod da API (`catalogMetadataSchema`). Funções puras, testadas sem DOM.
 */

export { CATALOG_TYPES };

/** Chaves de `metadata` exibidas na tela (rótulos em `catalogs.metadata.<chave>`). */
export type MetadataName =
  | 'legalBasis'
  | 'isDirectContracting'
  | 'itemKinds'
  | 'isContinuous'
  | 'requiredFields'
  | 'maxAgeDays'
  | 'ageReference'
  | 'abbreviation'
  | 'allowsDecimal'
  | 'color'
  | 'requiresPcaStatus';

/** Chaves com lista de opções (rótulos em `catalogs.options.<chave>.<valor>`). */
export type OptionsName = 'itemKinds' | 'requiredFields' | 'ageReference' | 'requiresPcaStatus';

/** Campo de `metadata` renderizado dinamicamente no diálogo. */
export type MetadataField =
  | { readonly name: MetadataName; readonly kind: 'text'; readonly required: boolean }
  | { readonly name: MetadataName; readonly kind: 'number'; readonly required: boolean }
  | { readonly name: MetadataName; readonly kind: 'boolean'; readonly required: boolean }
  | { readonly name: MetadataName; readonly kind: 'color'; readonly required: boolean }
  | {
      readonly name: OptionsName;
      readonly kind: 'select';
      readonly required: boolean;
      readonly options: readonly string[];
    }
  | {
      readonly name: OptionsName;
      readonly kind: 'multi';
      readonly required: boolean;
      readonly options: readonly string[];
    };

/** Campos de metadata por tipo (entities.md §5.9); `pncpCodes` é do MVP 3 e fica fora da tela. */
export const METADATA_FIELDS: Readonly<Record<CatalogType, readonly MetadataField[]>> = {
  MODALITY: [
    { name: 'legalBasis', kind: 'text', required: true },
    { name: 'isDirectContracting', kind: 'boolean', required: true },
  ],
  CONTRACTING_TYPE: [
    { name: 'itemKinds', kind: 'multi', required: true, options: ITEM_KINDS },
    { name: 'isContinuous', kind: 'boolean', required: false },
  ],
  PRICE_SOURCE_TYPE: [
    { name: 'legalBasis', kind: 'text', required: true },
    {
      name: 'requiredFields',
      kind: 'multi',
      required: false,
      options: PRICE_SOURCE_REQUIRED_FIELDS,
    },
    { name: 'maxAgeDays', kind: 'number', required: false },
    {
      name: 'ageReference',
      kind: 'select',
      required: false,
      options: PRICE_SOURCE_AGE_REFERENCES,
    },
  ],
  UNIT_OF_MEASURE: [
    { name: 'abbreviation', kind: 'text', required: true },
    { name: 'allowsDecimal', kind: 'boolean', required: true },
  ],
  RISK_CATEGORY: [{ name: 'color', kind: 'color', required: false }],
  JUDGMENT_CRITERION: [{ name: 'legalBasis', kind: 'text', required: true }],
  PROCESS_ORIGIN: [
    { name: 'requiresPcaStatus', kind: 'select', required: false, options: PCA_STATUSES },
  ],
  ATTACHMENT_CATEGORY: [],
};

/** Valor de um campo de metadata no formulário (texto, marcação, lista de valores). */
export type MetadataValue = string | boolean | readonly string[];

export interface FormValues {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
}

function metadataToForm(
  type: CatalogType,
  metadata: Readonly<Record<string, unknown>>,
): Record<string, MetadataValue> {
  const values: Record<string, MetadataValue> = {};
  for (const field of METADATA_FIELDS[type]) {
    const raw = metadata[field.name];
    switch (field.kind) {
      case 'boolean':
        values[field.name] = raw === true;
        break;
      case 'multi':
        values[field.name] = Array.isArray(raw) ? raw.map(String) : [];
        break;
      default:
        values[field.name] = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
    }
  }
  return values;
}

export function initialValues(type: CatalogType, item?: CatalogItemDto): FormValues {
  return {
    code: item?.code ?? '',
    label: item?.label ?? '',
    description: item?.description ?? '',
    metadata: metadataToForm(type, item?.metadata ?? {}),
  };
}

/** Objeto de `metadata` a enviar: só campos preenchidos (vazio = ausente; booleano obrigatório vai sempre). */
export function buildMetadata(
  type: CatalogType,
  values: FormValues['metadata'],
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const field of METADATA_FIELDS[type]) {
    const value = values[field.name];
    switch (field.kind) {
      case 'boolean':
        if (field.required || value === true) metadata[field.name] = value === true;
        break;
      case 'multi':
        if (Array.isArray(value) && (field.required || value.length > 0)) {
          metadata[field.name] = [...(value as readonly string[])];
        }
        break;
      case 'number': {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text !== '') metadata[field.name] = Number(text);
        break;
      }
      default: {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text !== '') metadata[field.name] = text;
      }
    }
  }
  return metadata;
}

export function buildCreateBody(type: CatalogType, values: FormValues): CatalogItemBody {
  const description = values.description.trim();
  return {
    code: values.code.trim(),
    label: values.label.trim(),
    ...(description === '' ? {} : { description }),
    metadata: buildMetadata(type, values.metadata),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** CAT-03: só o que mudou em relação ao item lido (`code` nunca vai — RN-TEN-59/60). */
export function buildPatch(
  type: CatalogType,
  values: FormValues,
  base: CatalogItemDto,
): CatalogItemBody {
  const patch: {
    label?: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
  } = {};
  const label = values.label.trim();
  if (label !== base.label) patch.label = label;
  const description = values.description.trim();
  if (description !== (base.description ?? ''))
    patch.description = description === '' ? null : description;
  const metadata = buildMetadata(type, values.metadata);
  if (!sameJson(metadata, base.metadata)) patch.metadata = metadata;
  return patch;
}

export type FieldErrors = Readonly<Record<string, string>>;

export interface ValidationMessages {
  readonly required: (field: 'code' | 'label') => string;
  readonly invalidCode: string;
  readonly tooLong: (field: 'label' | 'description', max: number) => string;
  readonly metadata: string;
}

/**
 * Validação do formulário com as mesmas regras da API: obrigatórios, `code` em SCREAMING_SNAKE_CASE
 * (só na criação), tamanhos e `metadata` pelo schema do tipo. A chave do erro é o campo
 * (`code`, `label`, `description`) ou `metadata.<chave>`.
 */
export function validateForm(
  type: CatalogType,
  values: FormValues,
  mode: 'create' | 'edit',
  messages: ValidationMessages,
): FieldErrors {
  const errors: Record<string, string> = {};
  if (mode === 'create') {
    const code = values.code.trim();
    if (code === '') errors.code = messages.required('code');
    else if (code.length > 60 || !CATALOG_CODE_PATTERN.test(code)) {
      errors.code = messages.invalidCode;
    }
  }
  const label = values.label.trim();
  if (label === '') errors.label = messages.required('label');
  else if (label.length > 150) errors.label = messages.tooLong('label', 150);
  if (values.description.trim().length > 1000) {
    errors.description = messages.tooLong('description', 1000);
  }
  const parsed = catalogMetadataSchema(type).safeParse(buildMetadata(type, values.metadata));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      errors[typeof key === 'string' ? `metadata.${key}` : 'metadata'] = messages.metadata;
    }
  }
  return errors;
}

/** Mensagem do padrão do `code` (a mesma da API — V-02). */
export const CODE_PATTERN_MESSAGE = CATALOG_CODE_MESSAGE;

/** Move o item de `from` para `to` na lista de IDs (reordenar por arrastar ou por teclado). */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** FA-04: o catálogo tem itens, mas nenhum ativo. */
export function hasNoActiveItems(items: readonly CatalogItemDto[]): boolean {
  return items.length > 0 && items.every((item) => !item.isActive);
}
