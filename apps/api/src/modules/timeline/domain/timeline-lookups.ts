/*
 * Leituras auxiliares do `TimelineProjector` (US-059 · RN-TML-04): o payload de um evento traz só
 * IDs (events.md §1), e a entrada da timeline guarda os nomes e rótulos CONGELADOS no momento do
 * fato. Cada tipo de referência é resolvido por uma fonte do módulo dono (pela fachada dele), em
 * lote e no mesmo `tx` do caso de uso. Os registros abaixo são o contrato dessas fontes.
 */

export interface TimelineLookupRecords {
  /** `identity`: nome exibido (social, se houver). */
  readonly USER: { readonly name: string };
  /** `organization`: nome da unidade. */
  readonly DEPARTMENT: { readonly name: string };
  /** `access`: nome do perfil (aprovador por perfil). */
  readonly ROLE: { readonly name: string };
  /** `process`: código (nulo em rascunho sem número) e sigilo do orçamento (POL-09). */
  readonly PROCESS: { readonly code: string | null; readonly isBudgetConfidential: boolean };
  /** `process`: nome da etapa da instância do processo. */
  readonly PROCESS_STAGE: { readonly name: string };
  /** `process`: participante (usuário ou unidade) e papel. */
  readonly PROCESS_PARTICIPANT: { readonly name: string; readonly role: string };
  /** `document`: rótulo do documento (`documentLabel`). */
  readonly DOCUMENT: {
    readonly code: string | null;
    readonly title: string;
    readonly typeName: string;
  };
  /** `document`: número da versão. */
  readonly DOCUMENT_VERSION: { readonly versionNumber: number };
  /** `approval`: título da aprovação. */
  readonly APPROVAL: { readonly title: string };
  /** `collaboration`: trecho do comentário (até 140 caracteres). */
  readonly COMMENT: { readonly excerpt: string };
  /** `files`: nome do arquivo e tipo do alvo. */
  readonly ATTACHMENT: { readonly fileName: string; readonly targetType: string };
  /** `etp`: nome da alternativa. */
  readonly ETP_ALTERNATIVE: { readonly name: string };
  /** `price-research`: sequência do item. */
  readonly PRICE_ITEM: { readonly sequence: number };
  /** `price-research`: rótulo da fonte da cotação. */
  readonly QUOTATION: { readonly sourceLabel: string };
  /** `risk`: código e título do risco. */
  readonly RISK: { readonly code: string; readonly title: string };
}

export type TimelineLookupKind = keyof TimelineLookupRecords;

export const TIMELINE_LOOKUP_KINDS = [
  'USER',
  'DEPARTMENT',
  'ROLE',
  'PROCESS',
  'PROCESS_STAGE',
  'PROCESS_PARTICIPANT',
  'DOCUMENT',
  'DOCUMENT_VERSION',
  'APPROVAL',
  'COMMENT',
  'ATTACHMENT',
  'ETP_ALTERNATIVE',
  'PRICE_ITEM',
  'QUOTATION',
  'RISK',
] as const satisfies readonly TimelineLookupKind[];

export interface TimelineLookupRef {
  readonly kind: TimelineLookupKind;
  readonly id: string;
}

/** Referência a resolver; `null`/`undefined` (campo opcional ausente) não gera leitura. */
export function lookupRef(
  kind: TimelineLookupKind,
  id: string | null | undefined,
): TimelineLookupRef[] {
  return id ? [{ kind, id }] : [];
}

/** Registros resolvidos, por tipo e ID. */
export type TimelineLookupResults = {
  readonly [K in TimelineLookupKind]?: ReadonlyMap<string, TimelineLookupRecords[K]>;
};

/** Consulta aos registros resolvidos; entidade não encontrada → `null` (nome congelado nulo). */
export class TimelineLookups {
  constructor(private readonly results: TimelineLookupResults = {}) {}

  get<K extends TimelineLookupKind>(
    kind: K,
    id: string | null | undefined,
  ): TimelineLookupRecords[K] | null {
    if (!id) return null;
    return this.results[kind]?.get(id) ?? null;
  }
}
