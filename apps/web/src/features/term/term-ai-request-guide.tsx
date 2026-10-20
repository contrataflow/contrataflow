'use client';

import type { TermDetailDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/*
 * `AiRequestForm` do TR (US-120 · SCR-117, passo 2): as entradas previstas (ETP, DFD e riscos,
 * itens, pesquisa de preços), as condições contratuais tipadas já preenchidas — as únicas fontes de
 * prazos, pagamento e garantias que a IA cita — e as ausentes, que sairão como `[a confirmar]`
 * (RN-AI-44), mais o aviso das seções já preenchidas e o consumo estimado (RN-AI-18). Montado com o
 * TR já carregado (lacuna 5 da US-118: a lista de entradas é do cliente); a API devolve os avisos
 * definitivos na proposta.
 */

/** Condições citadas pela IA, na ordem do painel "Condições contratuais". */
export const TERM_AI_CONDITIONS = [
  'contractDurationMonths',
  'executionDeadline',
  'paymentTermDays',
  'productWarrantyMonths',
  'contractGuaranteePercent',
  'deliveryLocation',
  'allowsSubcontracting',
  'selectionCriterionId',
  'awardType',
] as const satisfies readonly (keyof TermDetailDto)[];

type Conditions = Pick<TermDetailDto, (typeof TERM_AI_CONDITIONS)[number]>;

/** Preenchidas × ausentes (`null` ou texto vazio). */
export function termAiConditionsSplit(term: Conditions): {
  readonly filled: (typeof TERM_AI_CONDITIONS)[number][];
  readonly missing: (typeof TERM_AI_CONDITIONS)[number][];
} {
  const isMissing = (key: (typeof TERM_AI_CONDITIONS)[number]) => {
    const value = term[key];
    return value === null || (typeof value === 'string' && value.trim() === '');
  };
  return {
    filled: TERM_AI_CONDITIONS.filter((key) => !isMissing(key)),
    missing: TERM_AI_CONDITIONS.filter(isMissing),
  };
}

export function TermAiRequestGuide({ term }: { readonly term: Conditions }) {
  const t = useTranslations('ai.form.tr');
  const { filled, missing } = termAiConditionsSplit(term);
  return (
    <div
      data-testid="term-ai-request-guide"
      className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm"
    >
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">{t('inputsTitle')}</h3>
        <ul className="list-disc pl-5">
          {(['etp', 'dfd', 'items', 'priceResearch'] as const).map((key) => (
            <li key={key}>{t(`inputs.${key}`)}</li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="font-medium">{t('filledTitle')}</h3>
        {filled.length === 0 ? (
          <p className="text-muted-foreground">{t('noneFilled')}</p>
        ) : (
          <ul className="list-disc pl-5" data-testid="term-ai-filled">
            {filled.map((key) => (
              <li key={key}>{t(`conditions.${key}`)}</li>
            ))}
          </ul>
        )}
      </section>
      {missing.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">{t('missingTitle')}</h3>
          <ul className="list-disc pl-5" data-testid="term-ai-missing">
            {missing.map((key) => (
              <li key={key}>{t(`conditions.${key}`)}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('conditionsHint')}</p>
        </section>
      )}
      <p className="text-xs text-muted-foreground">{t('filledSections')}</p>
      <p className="text-xs text-muted-foreground">{t('estimate')}</p>
    </div>
  );
}
