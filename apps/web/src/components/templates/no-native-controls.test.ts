// Repaginação (prd-5 · §3): cada tela migrada troca os controles nativos pelos do kit
// (`Select`, `Checkbox`, `RadioGroup`, `DatePicker` de `@contrataflow/ui`), que têm o mesmo visual
// nos dois temas e em todos os navegadores. Este teste impede controle nativo novo em
// `apps/web/src/features`.
import { describe, expect, it } from 'vitest';

import { filesMatching } from './source-scan';

const NATIVE_CONTROL = /<select\b|type="(checkbox|radio|date)"/;

/**
 * Arquivos ainda não migrados, com o card que os migra (prd-5 · §4). A lista só encolhe e chega a
 * zero no card 11 (varredura final); o teste reprova entrada que já não tem controle nativo.
 */
const NOT_MIGRATED: Readonly<Record<string, string>> = {
  // Card 6 — pesquisa de preços, riscos, documentos, versões e anexos.
  'price-research/create-price-research-dialog.tsx': 'card 6',
  'price-research/exclude-quotation-dialog.tsx': 'card 6',
  'price-research/parameters-panel.tsx': 'card 6',
  'price-research/price-item-calculation.tsx': 'card 6',
  'price-research/price-source-form-dialog.tsx': 'card 6',
  'risks/risk-ai-review.tsx': 'card 6',
  'risks/risk-filter-bar.tsx': 'card 6',
  'risks/risk-form-drawer.tsx': 'card 6',
  'risks/treatment-status-select.tsx': 'card 6',
  // Card 9 — administração B.
  'catalogs/catalog-form-dialog.tsx': 'card 9',
  'document-types/document-type-form.tsx': 'card 9',
  'templates/default-template-select.tsx': 'card 9',
  'templates/template-editor.tsx': 'card 9',
  'templates/template-form-dialog.tsx': 'card 9',
  'templates/template-layout-tab.tsx': 'card 9',
  'templates/templates-view.tsx': 'card 9',
  'workflows/condition-builder.tsx': 'card 9',
  'workflows/stage-properties-panel.tsx': 'card 9',
  'workflows/workflow-diagram.tsx': 'card 9',
  'workflows/workflow-rules.tsx': 'card 9',
  'workflows/workflow-transitions.tsx': 'card 9',
  // Card 10 — assistente de IA.
  'ai/ai-proposal-section-list.tsx': 'card 10',
  'ai/ai-risk-proposal-list.tsx': 'card 10',
  'ai/ai-section-assistant.tsx': 'card 10',
  'ai/ai-terms-dialog.tsx': 'card 10',
  'ai/ai-usage-card.tsx': 'card 10',
};

const FEATURES = 'apps/web/src/features';
const found = new Map(
  [...filesMatching([FEATURES], NATIVE_CONTROL)].map(([file, lines]) => [
    file.slice(FEATURES.length + 1),
    lines,
  ]),
);

describe('prd-5 · controles de formulário do kit', () => {
  it('nenhum <select>, checkbox, radio ou date nativo fora dos arquivos ainda não migrados', () => {
    const offenders = [...found]
      .filter(([file]) => !(file in NOT_MIGRATED))
      .map(([file, lines]) => `${file}:${lines.join(',')}`);
    expect(
      offenders,
      'Use Select, Checkbox, RadioGroup ou DatePicker de @contrataflow/ui.',
    ).toEqual([]);
  });

  it('a lista de não migrados só guarda arquivos que ainda têm controle nativo', () => {
    const migrated = Object.keys(NOT_MIGRATED).filter((file) => !found.has(file));
    expect(migrated, 'Tire a entrada: o arquivo já usa os controles do kit.').toEqual([]);
  });
});
