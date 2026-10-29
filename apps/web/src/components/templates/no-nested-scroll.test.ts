// Regra 8 da repaginação (prd-5 · §2): só a página rola. Abas, passo a passo, chips e barras de
// ferramentas quebram linha; rolagem interna só onde o conteúdo não cabe por natureza. No Windows a
// barra com setas aparece mesmo quando o conteúdo cabe, então cada rolagem própria precisa de motivo.
import { describe, expect, it } from 'vitest';

import { filesMatching } from './source-scan';

/** `overflow-auto`, `overflow-x-scroll`, `md:overflow-y-auto`… e `overflowY: 'auto'` em estilo. */
const NESTED_SCROLL = /overflow(-[xy])?-(auto|scroll)\b|overflow[XY]?:\s*['"](auto|scroll)['"]/;

const TABLE = 'tabela mais larga que a tela';
const DIALOG = 'corpo de diálogo (Dialog/BottomSheet)';
const DRAWER = 'gaveta ou painel lateral (Sheet)';
const LISTBOX = 'lista suspensa de busca ou seleção';
const CODE = 'bloco de pré-visualização ou código';

/** Rolagens internas permitidas para sempre, com o motivo. */
const ALLOWED: Readonly<Record<string, string>> = {
  'packages/ui/src/components/command.tsx': LISTBOX,
  'packages/ui/src/components/conflict-dialog.tsx': DIALOG,
  'packages/ui/src/components/data-table.tsx': `TableContainer: ${TABLE}`,
  'packages/ui/src/components/dialog.tsx': DIALOG,
  'packages/ui/src/components/sheet.tsx': `SheetBody: ${DRAWER}`,
  'apps/web/src/components/shell/mobile-nav.tsx': `gaveta móvel do menu: ${DRAWER}`,
  'apps/web/src/features/ai/ai-assistant-panel.tsx': DRAWER,
  'apps/web/src/features/ai/ai-section-assistant.tsx': DRAWER,
  'apps/web/src/features/ai/ai-terms-dialog.tsx': DIALOG,
  'apps/web/src/features/approval-decision/approval-pending-actions.tsx': DIALOG,
  'apps/web/src/features/audit/audit-detail-panel.tsx': DRAWER,
  'apps/web/src/features/audit/audit-results-table.tsx': TABLE,
  'apps/web/src/features/audit/seal-list.tsx': TABLE,
  'apps/web/src/features/audit/seal-verification-result.tsx': TABLE,
  'apps/web/src/features/calendar/holiday-form-dialog.tsx': DIALOG,
  'apps/web/src/features/calendar/holiday-table.tsx': TABLE,
  'apps/web/src/features/catalogs/catalog-form-dialog.tsx': DIALOG,
  'apps/web/src/features/catalogs/catalog-item-table.tsx': TABLE,
  'apps/web/src/features/comments/mention-autocomplete.tsx': LISTBOX,
  'apps/web/src/features/departments/department-form-dialog.tsx': DIALOG,
  'apps/web/src/features/dfd-duplicate/duplicate-dfd-dialog.tsx': DIALOG,
  'apps/web/src/features/document-types/document-type-form.tsx': DIALOG,
  'apps/web/src/features/document-types/document-types-view.tsx': TABLE,
  'apps/web/src/features/documents/ai-review.tsx': DIALOG,
  'apps/web/src/features/etp/create-etp-dialog.tsx': DIALOG,
  'apps/web/src/features/etp/etp-alternatives-section.tsx': DRAWER,
  'apps/web/src/features/organizations/organization-form-dialog.tsx': DIALOG,
  'apps/web/src/features/organizations/organization-list.tsx': TABLE,
  'apps/web/src/features/price-research/create-price-research-dialog.tsx': DIALOG,
  'apps/web/src/features/price-research/import-preview-table.tsx': CODE,
  'apps/web/src/features/price-research/price-source-form-dialog.tsx': DIALOG,
  'apps/web/src/features/price-research/quotation-grid.tsx': TABLE,
  'apps/web/src/features/process-assign/assign-process-dialog.tsx': DIALOG,
  'apps/web/src/features/process-cancellation/cancellation-dialogs.tsx': DIALOG,
  'apps/web/src/features/process-completion/complete-process-dialog.tsx': DIALOG,
  'apps/web/src/features/process-duplicate/duplicate-process-dialog.tsx': DIALOG,
  'apps/web/src/features/process-edit/edit-process-sheet.tsx': DRAWER,
  'apps/web/src/features/process-forward/forward-panel.tsx': DRAWER,
  'apps/web/src/features/process-items/process-item-form.tsx': DRAWER,
  'apps/web/src/features/process-list/manage-views-dialog.tsx': DIALOG,
  'apps/web/src/features/process-list/process-filters-panel.tsx': DIALOG,
  'apps/web/src/features/process-participants/add-participant-dialog.tsx': LISTBOX,
  'apps/web/src/features/process-return/return-process-dialog.tsx': DIALOG,
  'apps/web/src/features/process-suspension/suspension-dialogs.tsx': DIALOG,
  'apps/web/src/features/risks/delete-risk-dialog.tsx': DIALOG,
  'apps/web/src/features/risks/owner-lookup.tsx': LISTBOX,
  'apps/web/src/features/risks/probability-impact-grid.tsx': TABLE,
  'apps/web/src/features/risks/risk-ai-review.tsx': DIALOG,
  'apps/web/src/features/risks/risk-form-drawer.tsx': DRAWER,
  'apps/web/src/features/risks/risk-heatmap-grid.tsx': TABLE,
  'apps/web/src/features/roles/roles-view.tsx': TABLE,
  'apps/web/src/features/suppliers/supplier-form-dialog.tsx': DIALOG,
  'apps/web/src/features/suppliers/supplier-list.tsx': TABLE,
  'apps/web/src/features/tags/process-tags.tsx': DIALOG,
  'apps/web/src/features/tags/tag-picker.tsx': LISTBOX,
  'apps/web/src/features/tags/tags-admin-panel.tsx': TABLE,
  'apps/web/src/features/task-inbox/task-bulk-actions.tsx': DIALOG,
  'apps/web/src/features/templates/template-editor.tsx': TABLE,
  'apps/web/src/features/templates/template-versions-view.tsx': TABLE,
  'apps/web/src/features/templates/templates-view.tsx': TABLE,
  'apps/web/src/features/term/create-term-dialog.tsx': DIALOG,
  'apps/web/src/features/term/import-etp-panel.tsx': `${DIALOG}; ${CODE}`,
  'apps/web/src/features/users/department-multi-select.tsx': LISTBOX,
  'apps/web/src/features/users/invite-user-form.tsx': DIALOG,
  'apps/web/src/features/users/user-list.tsx': TABLE,
  'apps/web/src/features/users/users-view.tsx': TABLE,
  'apps/web/src/features/workflows/workflow-editor.tsx': TABLE,
  'apps/web/src/features/workflows/workflow-rules.tsx': TABLE,
  'apps/web/src/features/workflows/workflow-versions.tsx': TABLE,
};

/**
 * Rolagens internas que ainda violam a regra e somem no card da tela (prd-5 · §4). Esta lista só
 * encolhe: quem migrar a tela tira a entrada; o teste reprova entrada que já não tem ocorrência.
 */
const PENDING: Readonly<Record<string, string>> = {
  'apps/web/src/features/price-research/comparative-map-grid.tsx':
    'card 6 — mapa comparativo com altura máxima e rolagem nos dois eixos',
  'apps/web/src/features/risks/risks-screen.tsx': 'card 6 — abas roláveis',
  'apps/web/src/features/roles/permission-matrix.tsx':
    'card 8 — matriz com altura máxima e rolagem nos dois eixos',
};

const found = filesMatching(['apps/web/src', 'packages/ui/src'], NESTED_SCROLL);

describe('prd-5 · regra 8 — só a página rola', () => {
  it('nenhuma rolagem interna fora da lista permitida', () => {
    const offenders = [...found]
      .filter(([file]) => !(file in ALLOWED) && !(file in PENDING))
      .map(([file, lines]) => `${file}:${lines.join(',')}`);
    expect(
      offenders,
      'Troque a rolagem própria por quebra de linha (flex-wrap), menu "Mais" ou TableContainer. ' +
        'Só entra em ALLOWED o que é tabela larga, corpo de diálogo/gaveta, lista suspensa ou bloco de código.',
    ).toEqual([]);
  });

  it('as listas não guardam arquivos que já não rolam por dentro', () => {
    const stale = [...Object.keys(ALLOWED), ...Object.keys(PENDING)].filter(
      (file) => !found.has(file),
    );
    expect(stale, 'Tire a entrada: o arquivo não tem mais rolagem interna.').toEqual([]);
  });

  it('o menu lateral, as abas e o passo a passo do processo não rolam por dentro', () => {
    for (const file of [
      'apps/web/src/components/shell/main-nav.tsx',
      'apps/web/src/features/process-panel/process-panel.tsx',
      'apps/web/src/features/process-panel/stage-stepper.tsx',
      'apps/web/src/features/dashboard/dashboard-page.tsx',
    ]) {
      expect(found.has(file), file).toBe(false);
    }
  });
});
