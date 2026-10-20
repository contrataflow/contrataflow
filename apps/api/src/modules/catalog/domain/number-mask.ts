import { localDateOf } from '@contrataflow/types';
import {
  DOCUMENT_SETTING_MASK_RULES,
  DOCUMENT_TYPE_MASK_RULES,
  maskHasOrganization,
  numberingMaskProblem,
  PROCESS_MASK_RULES,
  renderNumberingMask,
} from '@contrataflow/validation';
import type {
  NumberingMaskProblem,
  NumberingMaskRules,
  NumberingScope,
} from '@contrataflow/validation';

/*
 * Numeração configurável (US-105 · DEC-028 · RN-TEN-67..73): máscara, chave da sequência e escopo
 * do exercício. Funções puras; o incremento transacional fica no repositório e a orquestração na
 * `NumberingFacade`.
 */

/**
 * Origem da máscara: `PROCESS` (`numbering.process.mask`), `DOCUMENT` (`numbering.document.*` —
 * `{seq:1..6}`) ou `DOCUMENT_TYPE` (`DocumentType.numberingMask`, US-061 — `{seq:1..8}`).
 */
export type NumberMaskKind = 'PROCESS' | 'DOCUMENT' | 'DOCUMENT_TYPE';

const RULES: Readonly<Record<NumberMaskKind, NumberingMaskRules>> = {
  PROCESS: PROCESS_MASK_RULES,
  DOCUMENT: DOCUMENT_SETTING_MASK_RULES,
  DOCUMENT_TYPE: DOCUMENT_TYPE_MASK_RULES,
};

/** Motivo da recusa: o do formato (RN-TEN-67) ou `{org}` ausente com escopo `ORGANIZATION` (V-02). */
export type NumberMaskProblem = NumberingMaskProblem | 'MISSING_ORG';

/** RN-TEN-67: máscara inválida — vira 422 `NUMBERING_MASK_INVALID` na API. */
export class InvalidNumberMaskError extends Error {
  constructor(
    readonly mask: string,
    readonly problem: NumberMaskProblem,
  ) {
    super('Máscara de numeração inválida.');
    this.name = 'InvalidNumberMaskError';
  }
}

export interface NumberMaskTokens {
  /** Valor da sequência (`{seq:N}`, com zeros à esquerda até `N`). */
  readonly sequence: number;
  readonly year: number;
  /** Sigla do órgão (`{org}`). */
  readonly organization?: string | null;
  /** Código do tipo de documento (`{type}`). */
  readonly type?: string | null;
}

/** VO `NumberMask`: máscara já validada para a sua origem (e, no processo, para o escopo). */
export class NumberMask {
  private constructor(
    readonly value: string,
    readonly kind: NumberMaskKind,
  ) {}

  /** Motivo da recusa, ou `null`. O escopo só pesa na máscara do processo (V-02 · RN-TEN-67). */
  static problemOf(
    mask: string,
    kind: NumberMaskKind,
    scope: NumberingScope = 'TENANT',
  ): NumberMaskProblem | null {
    const problem = numberingMaskProblem(mask, RULES[kind]);
    if (problem !== null) return problem;
    if (kind === 'PROCESS' && scope === 'ORGANIZATION' && !maskHasOrganization(mask)) {
      return 'MISSING_ORG';
    }
    return null;
  }

  /** @throws InvalidNumberMaskError */
  static parse(mask: string, kind: NumberMaskKind, scope: NumberingScope = 'TENANT'): NumberMask {
    const problem = NumberMask.problemOf(mask, kind, scope);
    if (problem !== null) throw new InvalidNumberMaskError(mask, problem);
    return new NumberMask(mask, kind);
  }

  /** A máscara usa `{org}` (quem formata precisa da sigla do órgão). */
  get usesOrganization(): boolean {
    return maskHasOrganization(this.value);
  }

  format(tokens: NumberMaskTokens): string {
    return formatNumberMask(this.value, tokens);
  }
}

/** Aplica a máscara aos valores (`"{org}-{seq:4}/{year}"` → `"SEMED-0012/2026"`). */
export function formatNumberMask(mask: string, tokens: NumberMaskTokens): string {
  return renderNumberingMask({
    mask,
    sequence: tokens.sequence,
    year: tokens.year,
    organization: tokens.organization ?? '',
    typeCode: tokens.type ?? '',
  });
}

/** Parte do órgão na chave quando a sequência é única no tenant. */
export const ANY_ORGANIZATION = '*';

/**
 * RN-TEN-68: `PROCESS:<orgId|*>:<ano>`. Com escopo `TENANT` a sequência é única no tenant; com
 * `ORGANIZATION`, uma por órgão.
 */
export function processSequenceKey(
  scope: NumberingScope,
  organizationId: string,
  year: number,
): string {
  const organization = scope === 'ORGANIZATION' ? organizationId : ANY_ORGANIZATION;
  return `PROCESS:${organization}:${String(year)}`;
}

/**
 * RN-TEN-68 · RN-DOC-24: `DOCUMENT:<TYPE>:*:<ano>`. Documentos numeram por tipo e ano no tenant: o
 * escopo por órgão (`numbering.process.scope`) vale só para processos, porque as máscaras de
 * documento semeadas não têm `{org}` e o `code` do documento é único no tenant.
 */
export function documentSequenceKey(documentTypeCode: string, year: number): string {
  return `DOCUMENT:${documentTypeCode}:${ANY_ORGANIZATION}:${String(year)}`;
}

/** Escopo de uma chave de processo já aberta (`PROCESS:*:2026` → `TENANT`). */
export function scopeOfProcessKey(sequenceKey: string): NumberingScope {
  return sequenceKey.split(':')[1] === ANY_ORGANIZATION ? 'TENANT' : 'ORGANIZATION';
}

/**
 * RN-TEN-68: mudar `numbering.process.scope` só vale a partir do próximo exercício. O escopo do ano
 * é o da primeira sequência de processo aberta nele; sem nenhuma (primeiro número do ano), vale o
 * configurado. Sequências já abertas no ano nunca são migradas.
 */
export function effectiveProcessScope(
  configured: NumberingScope,
  openedKeyOfYear: string | null,
): NumberingScope {
  return openedKeyOfYear === null ? configured : scopeOfProcessKey(openedKeyOfYear);
}

/** RN-TEN-70: ano corrente no fuso do tenant no instante da numeração. */
export function numberingYear(now: Date, timezone: string): number {
  return Number(localDateOf(now, timezone).slice(0, 4));
}

export interface DocumentMaskSources {
  /** `DocumentType.numberingMask` (`null` = sem máscara própria). */
  readonly typeMask: string | null;
  /** `numbering.document.<TYPE>.mask` gravada, se houver. */
  readonly settingMask: string | null;
  /** `numbering.document.defaultMask`. */
  readonly defaultMask: string;
}

/**
 * RN-TEN-72: a máscara própria do tipo (`DocumentType.numberingMask` — `RISK_MAP`,
 * `PRICE_RESEARCH`…) vale primeiro; sem ela, o override `numbering.document.<TYPE>.mask`; sem
 * nenhum dos dois, `numbering.document.defaultMask`.
 */
export function resolveDocumentMask(sources: DocumentMaskSources): {
  readonly mask: string;
  readonly kind: NumberMaskKind;
} {
  if (sources.typeMask !== null) return { mask: sources.typeMask, kind: 'DOCUMENT_TYPE' };
  if (sources.settingMask !== null) return { mask: sources.settingMask, kind: 'DOCUMENT' };
  return { mask: sources.defaultMask, kind: 'DOCUMENT' };
}
