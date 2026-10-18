import { DFD_MESSAGES, dfdRequiredFields, dfdRequiredMessage } from './dfd.js';
import type { DfdFieldConfig, DfdHeaderValues, DfdWizardStep } from './dfd.js';
import { richTextPlainText } from '../document/rich-text.js';
import type { SectionRequirement } from '../document/template.js';
import type { Violation } from '../http/problem.js';

/*
 * Completude do DFD (US-014 · RN-DFD-18/19 · api.md §2.1.2): função PURA, sem I/O, usada no
 * cliente (checklist instantâneo do wizard) e no servidor (`DfdDocumentValidator`, que injeta os
 * dados atuais — itens, vínculo do responsável, setor e anexos). A mesma avaliação alimenta o DOC-08,
 * a conclusão (US-016) e o `RuleContext.documents.DFD.isComplete` da saída de `ABERTURA`:
 * `isComplete` sse não houver violação `BLOCKING`.
 */

/** Seção do rascunho como a completude a lê (`DraftContent.sections[k]`). */
export interface DfdCompletenessSection {
  readonly state: 'EMPTY' | 'FILLED' | 'NOT_APPLICABLE';
  readonly content: unknown;
}

/** Seção do template (`SectionDefinition` — só o que a regra usa). */
export interface DfdCompletenessSectionDefinition {
  readonly key: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  readonly minChars?: number | undefined;
}

export interface DfdCompletenessInput {
  readonly header: DfdHeaderValues;
  readonly sections: Readonly<Record<string, DfdCompletenessSection | undefined>>;
  readonly sectionDefinitions: readonly DfdCompletenessSectionDefinition[];
  readonly fieldConfig: DfdFieldConfig;
  /** Itens do DFD (`DocumentItem`). */
  readonly items: readonly { readonly processItemId: string; readonly quantity: string | null }[];
  /** Anexos do documento ainda em verificação (`UPLOADED`/`SCANNING`). */
  readonly pendingAttachments: number;
  /** `responsibleId` com vínculo `ACTIVE` e não vencido (RN-DFD-10). */
  readonly responsibleActive: boolean;
  /** `requestingDepartmentId` ainda ativo (RN-DFD-09). */
  readonly departmentActive: boolean;
  /** Hoje no fuso do tenant (`AAAA-MM-DD`). */
  readonly today: string;
}

/** Códigos específicos do DFD (RN-DFD-18 — estáveis; a UI usa para ícones e atalhos). */
export const DFD_VIOLATION_CODES = [
  'DFD_ITEMS_REQUIRED',
  'DFD_PCA_INCOMPLETE',
  'DFD_EXPECTED_DATE_PAST',
  'DFD_RESPONSIBLE_INACTIVE',
  'DFD_DEPARTMENT_INACTIVE',
  'DFD_ATTACHMENTS_PENDING',
] as const;
export type DfdViolationCode = (typeof DFD_VIOLATION_CODES)[number];

function violation(
  code: string,
  message: string,
  location: { readonly sectionKey?: string; readonly field?: string },
  params: Record<string, unknown> = {},
  severity: Violation['severity'] = 'BLOCKING',
): Violation {
  return {
    code,
    severity,
    message,
    ruleId: null,
    sectionKey: location.sectionKey ?? null,
    field: location.field ?? null,
    itemId: null,
    params,
  };
}

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

function sectionText(section: DfdCompletenessSection | undefined): string {
  if (section?.state !== 'FILLED' || !section.content) return '';
  return richTextPlainText(section.content as Parameters<typeof richTextPlainText>[0]).trim();
}

const hasQuantity = (quantity: string | null) =>
  quantity !== null && quantity.trim() !== '' && Number(quantity) > 0;

/**
 * As pendências do DFD (RN-DFD-18), bloqueantes antes dos avisos. As seções seguem a mesma regra
 * da completude genérica do `document` (`SECTION_REQUIRED`/`SECTION_TOO_SHORT` — o servidor compõe
 * as duas sem repetir a mesma pendência).
 */
export function evaluateDfdCompleteness(input: DfdCompletenessInput): Violation[] {
  const { header } = input;
  const blocking: Violation[] = [];

  for (const field of dfdRequiredFields(input.fieldConfig)) {
    if (field === 'estimatedValue' && header.estimatedValueMasked === true) continue;
    if (isBlank(header[field])) {
      blocking.push(violation('FIELD_REQUIRED', dfdRequiredMessage(field), { field }));
    }
  }

  for (const definition of [...input.sectionDefinitions]) {
    if (definition.requirement === 'OPTIONAL') continue;
    const section = input.sections[definition.key];
    if (section?.state === 'NOT_APPLICABLE' && definition.requirement === 'REQUIRED_OR_JUSTIFY') {
      continue;
    }
    const text = sectionText(section);
    if (text === '') {
      blocking.push(
        violation('SECTION_REQUIRED', `Preencha a seção "${definition.title}".`, {
          sectionKey: definition.key,
        }),
      );
    } else if (definition.minChars !== undefined && text.length < definition.minChars) {
      blocking.push(
        violation(
          'SECTION_TOO_SHORT',
          `A seção "${definition.title}" deve ter ao menos ${definition.minChars} caracteres.`,
          { sectionKey: definition.key },
          { minChars: definition.minChars, length: text.length },
        ),
      );
    }
  }

  if (!input.items.some((item) => hasQuantity(item.quantity))) {
    blocking.push(violation('DFD_ITEMS_REQUIRED', DFD_MESSAGES.itemsRequired, { field: 'items' }));
  }

  if (header.pcaStatus === 'PLANNED') {
    const currentYear = Number(input.today.slice(0, 4));
    if (header.pcaYear === null) {
      blocking.push(
        violation('DFD_PCA_INCOMPLETE', DFD_MESSAGES.pcaYearRequired, { field: 'pcaYear' }),
      );
    } else if (header.pcaYear !== currentYear && header.pcaYear !== currentYear + 1) {
      blocking.push(
        violation('DFD_PCA_INCOMPLETE', DFD_MESSAGES.pcaYearRange, { field: 'pcaYear' }),
      );
    }
  } else if (header.pcaStatus === 'NOT_PLANNED') {
    if ((header.pcaJustification?.trim().length ?? 0) < 20) {
      blocking.push(
        violation('DFD_PCA_INCOMPLETE', DFD_MESSAGES.pcaJustificationRequired, {
          field: 'pcaJustification',
        }),
      );
    }
  }

  if (header.expectedDate && header.expectedDate < input.today) {
    blocking.push(
      violation('DFD_EXPECTED_DATE_PAST', DFD_MESSAGES.expectedDatePast, { field: 'expectedDate' }),
    );
  }
  if (!isBlank(header.responsibleId) && !input.responsibleActive) {
    blocking.push(
      violation('DFD_RESPONSIBLE_INACTIVE', DFD_MESSAGES.responsibleInactive, {
        field: 'responsibleId',
      }),
    );
  }
  if (!isBlank(header.requestingDepartmentId) && !input.departmentActive) {
    blocking.push(
      violation('DFD_DEPARTMENT_INACTIVE', DFD_MESSAGES.departmentInactive, {
        field: 'requestingDepartmentId',
      }),
    );
  }

  const warnings: Violation[] = [];
  if (input.pendingAttachments > 0) {
    warnings.push(
      violation(
        'DFD_ATTACHMENTS_PENDING',
        DFD_MESSAGES.attachmentsPending(input.pendingAttachments),
        { field: 'attachments' },
        { count: input.pendingAttachments },
        'WARNING',
      ),
    );
  }
  return [...blocking, ...warnings];
}

/** `true` sse não houver violação bloqueante (RN-DFD-19). */
export function isDfdComplete(violations: readonly Violation[]): boolean {
  return !violations.some((item) => item.severity === 'BLOCKING');
}

const IDENTIFICATION_FIELDS = new Set([
  'requestDate',
  'requestingDepartmentId',
  'responsibleId',
  'objectSummary',
  'priority',
]);

/**
 * Passo do wizard de uma violação (RN-DFD-19 · tabela de RN-DFD-18): pelo `field` ou pela
 * `sectionKey`. Observações (`NOTES`) ficam no Planejamento; demais seções na Justificativa.
 */
export function dfdStepOfViolation(
  item: Pick<Violation, 'field' | 'sectionKey'>,
): Exclude<DfdWizardStep, 'REVIEW' | 'CONCLUSION'> {
  if (item.sectionKey !== null) return item.sectionKey === 'NOTES' ? 'PLANNING' : 'JUSTIFICATION';
  if (item.field === 'attachments') return 'JUSTIFICATION';
  if (item.field !== null && IDENTIFICATION_FIELDS.has(item.field)) return 'IDENTIFICATION';
  return 'PLANNING';
}
