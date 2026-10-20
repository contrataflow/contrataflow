import type { EtpConclusion, ParcelingDecision } from './etp.js';
import type { Violation } from '../http/problem.js';

/*
 * Completude do ETP (US-023 · RN-ETP-34..36 · api.md §2.1.2): função PURA, sem I/O. O servidor
 * (`EtpDocumentValidator`) a alimenta com o cabeçalho, os itens e as alternativas atuais e o
 * `document` a compõe com as regras genéricas de seção (RN-ETP-33 — `SECTION_REQUIRED`/
 * `SECTION_JUSTIFICATION_REQUIRED`, pela configuração semeada do template, DEC-016) num único
 * `violations[]` — o DOC-08 e a revalidação do DOC-10 (RN-ETP-37) usam o mesmo registro. A SCR-008
 * usa os códigos e as mensagens daqui para o resumo "Pendências para concluir".
 */

/** Mensagens da US-023 (Validações V-03..V-08 e "Casos de erro"). */
export const ETP_COMPLETENESS_MESSAGES = Object.freeze({
  conclusionRequired: 'Defina a conclusão do ETP (viável ou não viável).',
  parcelingRequired: 'Informe a decisão sobre o parcelamento.',
  itemsRequired: 'Informe ao menos um item com quantidade.',
  recommendedAlternativeRequired: 'Defina a alternativa recomendada antes de concluir.',
  estimatedValueRequired: 'Informe o valor estimado (manual ou pesquisa de preços).',
  notViableConclusion: 'Este ETP conclui pela não viabilidade da contratação',
  warningsNotAcknowledged: 'Confirme que está ciente da conclusão pela não viabilidade.',
  incomplete: 'Resolva as pendências destacadas para concluir.',
  notEditable: 'Este ETP já foi concluído ou não pode ser concluído agora.',
  permissionDenied: 'Você não tem permissão para concluir este ETP.',
});

/** Códigos específicos do ETP (estáveis — a UI usa para ícones e atalhos). */
export const ETP_VIOLATION_CODES = [
  'ETP_RECOMMENDED_ALTERNATIVE_REQUIRED',
  'ETP_ESTIMATED_VALUE_REQUIRED',
  'ETP_NOT_VIABLE_CONCLUSION',
] as const;
export type EtpViolationCode = (typeof ETP_VIOLATION_CODES)[number];

export interface EtpCompletenessInput {
  readonly conclusion: EtpConclusion;
  readonly parcelingDecision: ParcelingDecision | null;
  /** Decimal(18,2) como string; `null` = sem valor (inclusive pesquisa vinculada ainda sem cálculo). */
  readonly estimatedTotalValue: string | null;
  /** Itens do ETP (`DocumentItem`). */
  readonly items: readonly { readonly quantity: string | null }[];
  /** Alternativas não excluídas com `decision = RECOMMENDED`. */
  readonly recommendedAlternatives: number;
}

function violation(
  code: string,
  message: string,
  field: string | null,
  severity: Violation['severity'] = 'BLOCKING',
): Violation {
  return {
    code,
    severity,
    message,
    ruleId: null,
    sectionKey: null,
    field,
    itemId: null,
    params: {},
  };
}

const hasQuantity = (quantity: string | null) =>
  quantity !== null && quantity.trim() !== '' && Number(quantity) > 0;

/**
 * As pendências próprias do ETP, bloqueantes antes dos avisos:
 * - RN-ETP-34 (sempre): conclusão definida, parcelamento informado e ao menos um item com quantidade;
 * - RN-ETP-35 (`VIABLE`): exatamente uma alternativa recomendada e o valor estimado presente;
 * - RN-ETP-36 (`NOT_VIABLE`): o aviso `ETP_NOT_VIABLE_CONCLUSION`, que não bloqueia, mas precisa
 *   ser reconhecido no DOC-10 (`acknowledgedWarnings`).
 */
export function evaluateEtpCompleteness(input: EtpCompletenessInput): Violation[] {
  const blocking: Violation[] = [];
  const warnings: Violation[] = [];
  if (input.conclusion === 'PENDING') {
    blocking.push(
      violation('FIELD_REQUIRED', ETP_COMPLETENESS_MESSAGES.conclusionRequired, 'conclusion'),
    );
  }
  if (input.parcelingDecision === null) {
    blocking.push(
      violation('FIELD_REQUIRED', ETP_COMPLETENESS_MESSAGES.parcelingRequired, 'parcelingDecision'),
    );
  }
  if (!input.items.some((item) => hasQuantity(item.quantity))) {
    blocking.push(violation('ITEMS_REQUIRED', ETP_COMPLETENESS_MESSAGES.itemsRequired, 'items'));
  }
  if (input.conclusion === 'VIABLE') {
    if (input.recommendedAlternatives !== 1) {
      blocking.push(
        violation(
          'ETP_RECOMMENDED_ALTERNATIVE_REQUIRED',
          ETP_COMPLETENESS_MESSAGES.recommendedAlternativeRequired,
          'recommendedAlternativeId',
        ),
      );
    }
    if (input.estimatedTotalValue === null || input.estimatedTotalValue.trim() === '') {
      blocking.push(
        violation(
          'ETP_ESTIMATED_VALUE_REQUIRED',
          ETP_COMPLETENESS_MESSAGES.estimatedValueRequired,
          'estimatedTotalValue',
        ),
      );
    }
  }
  if (input.conclusion === 'NOT_VIABLE') {
    warnings.push(
      violation(
        'ETP_NOT_VIABLE_CONCLUSION',
        ETP_COMPLETENESS_MESSAGES.notViableConclusion,
        'conclusion',
        'WARNING',
      ),
    );
  }
  return [...blocking, ...warnings];
}
