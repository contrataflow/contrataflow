import type { TimelineEntryType } from './timeline.js';

/*
 * Dicionário de mensagens da timeline (US-060 · RN-TML-14 · events.md §5): `type` → texto pt-BR
 * com placeholders, renderizado no frontend a partir de `type` + `params` gravados pelo
 * `TimelineProjector` (US-059). A API nunca devolve mensagem pronta; este é o ÚNICO dicionário,
 * compartilhado pela API (fonte do registro `TimelineEntryType`) e pelo web. Tipo novo entra
 * primeiro em events.md §5, depois no registro (`timeline.ts`), aqui e num grupo (RN-TML-12).
 *
 * Placeholders derivados (não são chaves de `params`): `{actor}` (nome congelado do ator ou
 * "Sistema"), `{documentLabel}` (`documentCode` — `documentTitle`, ou `typeName`),
 * `{fieldsLabel}` (rótulos de `fields[]`), `{roleLabel}`, `{decisionLabel}`, `{levelLabel}`,
 * `{statusVerb}`, `{confidentialityLabel}`, `{generationLabel}` e `{reviewedLabel}`. Os demais vêm de `params` com o
 * mesmo nome.
 */

export const TIMELINE_MESSAGE_TEMPLATES: Readonly<Record<TimelineEntryType, string>> = {
  PROCESS_CREATED: '{actor} abriu o processo {code}',
  PROCESS_DUPLICATED_FROM: 'Processo criado a partir de {sourceCode}',
  PROCESS_DUPLICATED: '{actor} duplicou o processo em {newCode}',
  PROCESS_UPDATED: '{actor} alterou {fieldsLabel}',
  PROCESS_NUMBER_ASSIGNED: 'Processo autuado sob o nº {code}',
  ITEMS_CHANGED: '{actor} atualizou os itens ({itemsCount})',
  PROCESS_FORWARDED: '{actor} encaminhou para {toStageName} — {toDepartmentName}',
  PROCESS_RETURNED: '{actor} devolveu para {toStageName} — {toDepartmentName}',
  PROCESS_STAGE_CHANGED: 'Processo seguiu para {toStageName}',
  PROCESS_CLAIMED: '{actor} assumiu o processo',
  PROCESS_ASSIGNED: '{actor} atribuiu o processo a {toUserName}',
  PROCESS_SUSPENDED: '{actor} suspendeu o processo',
  PROCESS_RESUMED: '{actor} retomou o processo',
  PROCESS_CANCELED: '{actor} cancelou o processo',
  PROCESS_COMPLETED: 'Planejamento da contratação concluído',
  PARTICIPANT_ADDED: '{actor} adicionou {name} como {roleLabel}',
  PARTICIPANT_REMOVED: '{actor} removeu {name} ({roleLabel})',
  CONFIDENTIALITY_CHANGED: '{actor} marcou o orçamento como {confidentialityLabel}',
  STAGE_OVERDUE: 'Prazo da etapa {stageName} vencido',
  DOCUMENT_CREATED: '{actor} criou {documentLabel}',
  DOCUMENT_VERSION_CREATED: '{actor} gerou a versão {versionNumber} de {documentLabel}',
  DOCUMENT_SUBMITTED: '{actor} submeteu {documentLabel}',
  DOCUMENT_FINALIZED: '{actor} concluiu {documentLabel}',
  DOCUMENT_APPROVED: '{documentLabel} aprovado',
  DOCUMENT_RETURNED: '{documentLabel} devolvido',
  DOCUMENT_REJECTED: '{documentLabel} indeferido',
  DOCUMENT_REOPENED: '{actor} reabriu {documentLabel}',
  DOCUMENT_CANCELED: '{actor} cancelou {documentLabel}',
  DOCUMENT_WITHDRAWN: '{actor} retirou {documentLabel}',
  APPROVAL_REQUESTED: 'Aprovação solicitada a {approverLabel}',
  APPROVAL_DECIDED: '{actor} {decisionLabel} — {title}',
  APPROVAL_CANCELED: 'Aprovação cancelada — {title}',
  APPROVAL_REASSIGNED: 'Aprovação redirecionada a {toApproverLabel} — {title}',
  COMMENT_ADDED: '{actor} comentou',
  COMMENT_REMOVED: 'Comentário removido por moderação',
  ATTACHMENT_ADDED: '{actor} anexou {fileName}',
  ATTACHMENT_REMOVED: '{actor} removeu {fileName}',
  ETP_ALTERNATIVE_RECOMMENDED: '{actor} definiu a alternativa recomendada: {name}',
  QUOTATION_EXCLUDED: '{actor} desconsiderou cotação do item {itemSequence}',
  QUOTATION_RESTORED: '{actor} restaurou cotação do item {itemSequence}',
  RISK_ADDED: '{actor} registrou o risco {code} ({levelLabel})',
  RISK_LEVEL_CHANGED: '{actor} reavaliou o risco {code} ({levelLabel})',
  RISK_REMOVED: '{actor} removeu o risco {code}',
  TERM_IMPORTED_FROM_ETP: '{actor} importou dados do ETP (v{etpVersion}) para o TR',
  AI_CONTENT_GENERATED: '{actor} gerou com IA {generationLabel} de {documentLabel}',
  AI_CONTENT_REVIEWED:
    '{actor} revisou o conteúdo gerado por IA em {documentLabel} ({reviewedLabel})',
};

/** Rótulos dos campos de `PROCESS_UPDATED.fields[]` (desconhecido = "dados do processo"). */
export const TIMELINE_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: 'o título',
  object: 'o objeto',
  description: 'a descrição',
  priority: 'a prioridade',
  estimatedValue: 'o valor estimado',
  estimatedValueSource: 'a fonte do valor estimado',
  targetDate: 'a data alvo',
  contractingTypeId: 'o tipo de contratação',
  modalityId: 'a modalidade',
  originId: 'a origem',
  isPriceRegistration: 'o registro de preços',
  internalCode: 'o código interno',
  notes: 'as observações',
  pcaStatus: 'o PCA',
  pcaYear: 'o ano do PCA',
  pcaItemCode: 'o item do PCA',
  pcaJustification: 'a justificativa do PCA',
  requestingDepartmentId: 'a unidade solicitante',
  tags: 'as etiquetas',
};

const ROLE_LABELS: Readonly<Record<string, string>> = {
  OBSERVER: 'observador',
  COLLABORATOR: 'colaborador',
  CONSULTANT: 'consultor',
};

const DECISION_LABELS: Readonly<Record<string, string>> = {
  APPROVED: 'aprovou',
  RETURNED: 'devolveu',
  REJECTED: 'indeferiu',
  COMPLETED: 'concluiu',
};

const AI_ACTION_LABELS: Readonly<Record<string, string>> = {
  REWRITE: 'reescrever',
  COMPLETE: 'completar',
  SUMMARIZE: 'resumir',
};

/** Documento-alvo sem documento emitido (mapa de riscos — US-119). */
const AI_TARGET_LABELS: Readonly<Record<string, string>> = {
  DFD: 'o DFD',
  ETP: 'o ETP',
  RISK_MAP: 'o mapa de riscos',
  TERM_OF_REFERENCE: 'o TR',
};

/** `{generationLabel}` (events.md §5): rascunho completo, proposta de riscos ou ajuste de seção. */
function generationLabelOf(params: Readonly<Record<string, unknown>>): string {
  if (params.kind === 'SECTION') {
    const action = text(params.action);
    const label = (action && AI_ACTION_LABELS[action]) ?? 'ajustar';
    const section = text(params.sectionTitle) ?? text(params.sectionKey);
    return section ? `o ajuste "${label}" da seção ${section}` : `o ajuste "${label}"`;
  }
  return params.targetModule === 'RISK_MAP' ? 'a proposta de riscos' : 'o rascunho completo';
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/** `{reviewedLabel}` (events.md §5 · US-122): "2 seções", "1 risco" ou "2 seções e 1 risco". */
function reviewedLabelOf(params: Readonly<Record<string, unknown>>): string {
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
  const parts = [
    count(params.sectionsCount) > 0 ? plural(count(params.sectionsCount), 'seção', 'seções') : null,
    count(params.risksCount) > 0 ? plural(count(params.risksCount), 'risco', 'riscos') : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'nenhuma seção' : parts.join(' e ');
}

const LEVEL_LABELS: Readonly<Record<string, string>> = {
  LOW: 'baixo',
  MEDIUM: 'médio',
  HIGH: 'alto',
  EXTREME: 'extremo',
};

/** Texto exibido no lugar de um nome congelado ausente (referência não encontrada no fato). */
export const TIMELINE_UNKNOWN = '—';

/** O que a renderização precisa de uma entrada de PRC-12. */
export interface TimelineMessageInput {
  readonly type: string;
  readonly actorType: string;
  readonly actorName: string | null;
  readonly params?: Readonly<Record<string, unknown>> | null | undefined;
}

export interface RenderedTimelineEntry {
  /** Frase principal (RN-TML-14). */
  readonly message: string;
  /** Complemento opcional: trecho do comentário, justificativa ou motivo. */
  readonly detail: string | null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** "a, b e c" (pt-BR). */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} e ${parts.at(-1) ?? ''}`;
}

function actorOf(input: TimelineMessageInput): string {
  if (input.actorType === 'SYSTEM') return 'Sistema';
  return text(input.actorName) ?? 'Usuário';
}

function documentLabelOf(params: Readonly<Record<string, unknown>>): string {
  const code = text(params.documentCode);
  const title = text(params.documentTitle);
  if (code && title) return `${code} — ${title}`;
  const target = text(params.targetModule);
  return (
    code ?? title ?? text(params.typeName) ?? (target && AI_TARGET_LABELS[target]) ?? 'o documento'
  );
}

function fieldsLabelOf(params: Readonly<Record<string, unknown>>): string {
  const fields = Array.isArray(params.fields)
    ? params.fields.filter((field): field is string => typeof field === 'string')
    : [];
  const labels = [...new Set(fields.flatMap((field) => TIMELINE_FIELD_LABELS[field] ?? []))];
  if (labels.length === 0) return 'os dados do processo';
  const unknown = fields.some((field) => TIMELINE_FIELD_LABELS[field] === undefined);
  return joinList(unknown ? [...labels, 'outros dados'] : labels);
}

function derived(input: TimelineMessageInput): Record<string, string> {
  const params = input.params ?? {};
  const role = text(params.role);
  const decision = text(params.decision);
  const level = text(params.level);
  return {
    actor: actorOf(input),
    documentLabel: documentLabelOf(params),
    fieldsLabel: fieldsLabelOf(params),
    roleLabel: (role && ROLE_LABELS[role]) ?? role ?? 'participante',
    decisionLabel: (decision && DECISION_LABELS[decision]) ?? 'decidiu',
    levelLabel: (level && LEVEL_LABELS[level]) ?? level ?? TIMELINE_UNKNOWN,
    confidentialityLabel: params.isBudgetConfidential === false ? 'público' : 'sigiloso',
    generationLabel: generationLabelOf(params),
    reviewedLabel: reviewedLabelOf(params),
  };
}

function detailOf(type: string, params: Readonly<Record<string, unknown>>): string | null {
  if (type === 'COMMENT_ADDED') return text(params.excerpt);
  return text(params.reason);
}

/**
 * Renderiza a mensagem da entrada (RN-TML-14). Tipo fora do registro (entrada de tipo retirado)
 * vira uma frase neutra em vez de quebrar a timeline.
 */
export function renderTimelineEntry(input: TimelineMessageInput): RenderedTimelineEntry {
  const params = input.params ?? {};
  const template =
    (TIMELINE_MESSAGE_TEMPLATES as Readonly<Record<string, string>>)[input.type] ??
    '{actor} registrou um evento';
  const values = derived(input);
  const message = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return values[key] ?? text(params[key]) ?? TIMELINE_UNKNOWN;
  });
  return { message, detail: detailOf(input.type, params) };
}
