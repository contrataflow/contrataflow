// @vitest-environment jsdom
import type { SummaryDocument } from '@contrataflow/validation';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ID, summaryDto } from '@test/support/process-fixtures';
import { renderWithShell } from '@test/support/render';

import { CancelSuggestionCallout, suggestsCancellation } from './cancel-suggestion-callout';
import { EstimatedValueBadge } from './estimated-value-badge';

const dfd = (status: SummaryDocument['status']): SummaryDocument => ({
  id: ID(500),
  typeCode: 'DFD',
  typeName: 'Documento de Formalização da Demanda',
  code: 'DFD 0005/2026',
  title: 'DFD — cimento',
  status,
  versionNumber: 1,
  confidentiality: 'PUBLIC',
  restricted: false,
  inApproval: false,
});

const returned = (status: SummaryDocument['status']) => {
  const base = summaryDto();
  return summaryDto({ where: { ...base.where, status: 'RETURNED' }, documents: [dfd(status)] });
};

describe('CancelSuggestionCallout (US-017 · RN-DFD-68 · PEND-02)', () => {
  it('só com o processo RETURNED e o DFD REJECTED', () => {
    expect(suggestsCancellation(returned('REJECTED'))).toBe(true);
    expect(suggestsCancellation(returned('RETURNED'))).toBe(false);
    expect(suggestsCancellation(summaryDto({ documents: [dfd('REJECTED')] }))).toBe(false);
  });

  it('exibe "Considere cancelar este processo" anunciado por aria-live, sem cancelar sozinho', () => {
    const { container } = renderWithShell(
      <CancelSuggestionCallout summary={returned('REJECTED')} />,
    );
    expect(screen.getByText('Considere cancelar este processo')).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('sem indeferimento, nada aparece', () => {
    const { container } = renderWithShell(<CancelSuggestionCallout summary={returned('DRAFT')} />);
    expect(container.textContent).toBe('');
  });
});

describe('EstimatedValueBadge (US-017)', () => {
  it('valor com a origem DFD', () => {
    renderWithShell(<EstimatedValueBadge value="15000.00" masked={false} source="DFD" />);
    expect(screen.getByText('R$ 15.000,00')).toBeTruthy();
    expect(screen.getByText('Origem: DFD')).toBeTruthy();
  });

  it('sigiloso (POL-09): mascarado, a origem continua visível; sem origem, só o valor', () => {
    const { unmount } = renderWithShell(<EstimatedValueBadge value={null} masked source="DFD" />);
    expect(screen.queryByText(/R\$/)).toBeNull();
    expect(screen.getByText('Origem: DFD')).toBeTruthy();
    unmount();
    renderWithShell(<EstimatedValueBadge value="10.00" masked={false} source={null} />);
    expect(screen.queryByText(/Origem/)).toBeNull();
  });
});
