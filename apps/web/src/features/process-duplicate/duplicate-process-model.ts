import {
  PROCESS_MESSAGES,
  processObjectSchema,
  processTitleSchema,
} from '@contrataflow/validation';
import type {
  DuplicateProcessInput,
  FieldError,
  ProcessDocumentDto,
  ProcessDto,
} from '@contrataflow/validation';

/*
 * Modelo do diálogo "Duplicar processo" (US-011 · SCR-113): valores iniciais copiados da origem,
 * as MESMAS regras de título/objeto do PRC-02 (V-01), o corpo do PRC-27 e a separação dos erros da
 * API entre os campos do diálogo e as referências copiadas que só a origem corrige (V-02 — FA-01).
 * Puro: sem React nem rede.
 */

export const DUPLICATE_FIELDS = [
  'title',
  'object',
  'requestingSecretariatId',
  'requestingDepartmentId',
] as const;
export type DuplicateField = (typeof DUPLICATE_FIELDS)[number];

export interface DuplicateFormValues {
  readonly title: string;
  readonly object: string;
  readonly requestingSecretariatId: string;
  readonly requestingDepartmentId: string;
  readonly copyDocuments: boolean;
  readonly copyAttachments: boolean;
}

export type DuplicateMessages = Partial<Record<DuplicateField, string>>;

const isDuplicateField = (field: string): field is DuplicateField =>
  (DUPLICATE_FIELDS as readonly string[]).includes(field);

/** Padrões do diálogo: título, objeto e unidades da origem; cópias opcionais desligadas. */
export function duplicateValuesOf(source: ProcessDto): DuplicateFormValues {
  return {
    title: source.title,
    object: source.object,
    requestingSecretariatId: source.requestingSecretariat.id,
    requestingDepartmentId: source.requestingDepartment.id,
    copyDocuments: false,
    copyAttachments: false,
  };
}

/** V-01: obrigatórios e limites (mesmos schemas da API); um erro por campo. */
export function validateDuplicate(values: DuplicateFormValues): DuplicateMessages {
  const messages: DuplicateMessages = {};
  const title = processTitleSchema.safeParse(values.title).error?.issues[0]?.message;
  if (title !== undefined) messages.title = title;
  const object = processObjectSchema.safeParse(values.object).error?.issues[0]?.message;
  if (object !== undefined) messages.object = object;
  if (values.requestingSecretariatId === '') {
    messages.requestingSecretariatId = PROCESS_MESSAGES.secretariatRequired;
  }
  if (values.requestingDepartmentId === '') {
    messages.requestingDepartmentId = PROCESS_MESSAGES.departmentRequired;
  }
  return messages;
}

/** Corpo do PRC-27: os valores do diálogo (iguais aos da origem quando não ajustados). */
export function duplicateBody(values: DuplicateFormValues): DuplicateProcessInput {
  return {
    title: values.title.trim(),
    object: values.object.trim(),
    requestingSecretariatId: values.requestingSecretariatId,
    requestingDepartmentId: values.requestingDepartmentId,
    copyDocuments: values.copyDocuments,
    copyAttachments: values.copyAttachments,
  };
}

/**
 * RN-PROC-120 · FA-03: documentos que a cópia leva — estruturados (`STRUCTURED`) e não cancelados
 * (o painel também lista os cancelados).
 */
export function eligibleDocuments(documents: readonly ProcessDocumentDto[]): ProcessDocumentDto[] {
  return documents.filter(
    (document) => document.documentType.kind === 'STRUCTURED' && document.status !== 'CANCELED',
  );
}

/**
 * 422 da API: erros dos campos do diálogo vão para os campos; os demais (referência copiada
 * inativa — `modalityId`, `contractingTypeId`… — ou regra do PCA) só se corrigem na origem.
 */
export function splitErrors(errors: readonly FieldError[]): {
  readonly fields: DuplicateMessages;
  readonly others: readonly string[];
} {
  const fields: DuplicateMessages = {};
  const others: string[] = [];
  for (const error of errors) {
    if (isDuplicateField(error.field)) fields[error.field] ??= error.message;
    else if (!others.includes(error.message)) others.push(error.message);
  }
  return { fields, others };
}
