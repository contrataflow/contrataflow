// @vitest-environment jsdom
import type { TermDetailDto, TermTemplateSectionDto, Violation } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { stubWithRoutes } from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import { ID, PROCESS_ID, mockProcessApi, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { completionSummaryOf, completionTargetOf } from './term-completion-model';
import { TermCompletionPanel } from './term-completion-panel';
import { DocumentActionsBar } from '../documents/document-actions-bar';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-039 — painel "Completude do TR" da SCR-012 com a API simulada: DOC-08 com as pendências
 * bloqueantes (link para a seção ou para o campo no painel que o edita) e os avisos de consistência
 * com o ETP; 0 pendências em destaque; erro ao calcular com "Tentar novamente"; TR concluído
 * somente leitura; os rótulos "Concluir TR"/"Submeter para aprovação" do ciclo de vida; axe.
 */

const TERM_ID = ID(850);
const URL_VALIDATION = `/api/v1/documents/${TERM_ID}/validation`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function termDto(extra: Partial<TermDetailDto> = {}): TermDetailDto {
  return {
    id: TERM_ID,
    documentId: TERM_ID,
    processId: PROCESS_ID,
    code: 'TR 0003/2026',
    title: 'Termo de Referência',
    status: 'DRAFT',
    inApproval: false,
    templateVersion: null,
    responsibleId: null,
    objectDefinition: 'Aquisição de materiais de construção',
    contractDurationMonths: null,
    executionDeadline: null,
    executionDeadlineType: null,
    deliveryLocation: null,
    paymentTermDays: null,
    productWarrantyMonths: null,
    contractGuaranteePercent: null,
    allowsSubcontracting: null,
    selectionCriterionId: null,
    awardType: null,
    estimatedTotalValue: null,
    estimatedTotalValueMasked: false,
    estimatedValueSource: null,
    priceResearchId: null,
    importedFromEtpId: null,
    importedFromEtpVersionId: null,
    importedAt: null,
    importedById: null,
    documentVersion: 4,
    createdAt: '2026-10-20T12:00:00.000Z',
    updatedAt: '2026-10-20T12:00:00.000Z',
    version: 2,
    draftRevision: 0,
    draftContent: { sections: {} },
    completeness: { required: 0, satisfied: 0, percent: 0, sections: [] },
    priceResearch: null,
    completedPriceResearch: null,
    etpChangedSinceImport: false,
    ...extra,
  };
}

function section(key: string, title: string, order: number): TermTemplateSectionDto {
  return {
    key,
    title,
    order,
    requirement: 'REQUIRED',
    helpText: null,
    legalBasis: null,
    minChars: null,
    maxChars: 20_000,
    render: 'TEXT',
    allowNarrative: true,
  };
}

const SECTIONS = [
  section('OBJECT', 'Definição do objeto', 1),
  section('ESTIMATED_VALUE', 'Estimativa do valor da contratação', 2),
];

function violation(code: string, extra: Partial<Violation> = {}): Violation {
  return {
    code,
    severity: 'BLOCKING',
    message: code,
    ruleId: null,
    sectionKey: null,
    field: null,
    itemId: null,
    params: {},
    ...extra,
  };
}

const DIVERGENT = violation('TR_ITEM_QUANTITY_DIVERGENT', {
  severity: 'WARNING',
  message: 'A quantidade do item 3 no TR (50) diverge da quantidade no ETP (40).',
  field: 'items',
  itemId: ID(851),
  params: { etpQuantity: '40', trQuantity: '50' },
});

function validationRoute(responses: (() => Response)[]): Route {
  let call = 0;
  return (url) => {
    if (url !== URL_VALIDATION) return undefined;
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return response?.();
  };
}

const withViolations = (violations: Violation[]) => () => jsonResponse({ data: { violations } });

function stub(responses: (() => Response)[]) {
  return stubWithRoutes(
    mockProcessApi({ permissions: ['PROCESS_VIEW'] }),
    validationRoute(responses),
  );
}

describe('Regras de tela da completude do TR', () => {
  it('pendência de seção leva à seção; de campo, ao painel que o edita; sem destino, só o texto', () => {
    expect(completionTargetOf({ sectionKey: 'ESTIMATED_VALUE', field: null }, SECTIONS)).toEqual({
      kind: 'section',
      key: 'ESTIMATED_VALUE',
    });
    expect(completionTargetOf({ sectionKey: 'OUTRA', field: null }, SECTIONS)).toEqual({
      kind: 'none',
    });
    expect(completionTargetOf({ sectionKey: null, field: 'items' }, SECTIONS)).toEqual({
      kind: 'panel',
      panel: 'items',
      field: 'items',
    });
    expect(completionTargetOf({ sectionKey: null, field: 'awardType' }, SECTIONS)).toEqual({
      kind: 'panel',
      panel: 'conditions',
      field: 'awardType',
    });
    expect(
      completionTargetOf({ sectionKey: null, field: 'estimatedTotalValue' }, SECTIONS),
    ).toMatchObject({ panel: 'general' });
    expect(completionTargetOf({ sectionKey: null, field: 'desconhecido' }, SECTIONS)).toEqual({
      kind: 'none',
    });
    expect(completionTargetOf({ sectionKey: null, field: null }, SECTIONS)).toEqual({
      kind: 'none',
    });
  });

  it('resumo separa bloqueantes e avisos', () => {
    const summary = completionSummaryOf([violation('TR_ITEMS_REQUIRED'), DIVERGENT]);
    expect(summary.blocking.map((item) => item.code)).toEqual(['TR_ITEMS_REQUIRED']);
    expect(summary.warnings.map((item) => item.code)).toEqual(['TR_ITEM_QUANTITY_DIVERGENT']);
  });
});

describe('TermCompletionPanel (US-039 · SCR-012)', () => {
  it('[Sucesso] 0 pendências: destaque de pronto para concluir', async () => {
    stub([withViolations([])]);
    renderWithShell(
      <TermCompletionPanel
        term={termDto()}
        sections={SECTIONS}
        revision={0}
        onSelectSection={() => undefined}
      />,
    );
    expect(
      await screen.findByText('Nenhuma pendência: o TR está pronto para ser concluído.'),
    ).toBeTruthy();
    expect(screen.queryByText('Pendências bloqueantes')).toBeNull();
  });

  it('[Validação] FA-01: bloqueantes com resumo e links; a seção abre no editor e o campo no painel', async () => {
    const user = userEvent.setup();
    stub([
      withViolations([
        violation('TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED', {
          message: 'Justifique o valor manual na seção.',
          sectionKey: 'ESTIMATED_VALUE',
        }),
        violation('TR_AWARD_TYPE_REQUIRED', {
          message: 'Defina o tipo de adjudicação.',
          field: 'awardType',
        }),
        violation('TR_ITEMS_REQUIRED', { message: 'Informe ao menos um item com quantidade.' }),
        DIVERGENT,
      ]),
    ]);
    const onSelectSection = vi.fn();
    renderWithShell(
      <>
        <section data-term-panel="conditions">
          <button type="button" aria-expanded="false">
            Condições contratuais
          </button>
          <select id="term-awardType" aria-label="Tipo de adjudicação" />
        </section>
        <TermCompletionPanel
          term={termDto()}
          sections={SECTIONS}
          revision={0}
          onSelectSection={onSelectSection}
        />
      </>,
    );
    expect(await screen.findByText('3 pendências impedem a conclusão')).toBeTruthy();
    expect(screen.getByText('Pendências bloqueantes')).toBeTruthy();
    expect(screen.getByText('Aviso de consistência')).toBeTruthy();
    expect(
      screen.getByText('A quantidade do item 3 no TR (50) diverge da quantidade no ETP (40).'),
    ).toBeTruthy();
    // Pendência sem destino conhecido: texto, sem link.
    expect(screen.queryByRole('button', { name: /Informe ao menos um item/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Justifique o valor manual na seção.' }));
    expect(onSelectSection).toHaveBeenCalledWith('ESTIMATED_VALUE');

    await user.click(screen.getByRole('button', { name: /Defina o tipo de adjudicação/ }));
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('term-awardType');
    });
  });

  it('[Validação] FA-02: só avisos — nenhuma bloqueante e a orientação de reconhecer ao concluir', async () => {
    stub([withViolations([DIVERGENT])]);
    renderWithShell(
      <TermCompletionPanel
        term={termDto()}
        sections={SECTIONS}
        revision={0}
        onSelectSection={() => undefined}
      />,
    );
    expect(
      await screen.findByText(
        'Nenhuma pendência bloqueante. Reconheça os avisos ao concluir o TR.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/precisam ser reconhecidos em "Concluir TR"/)).toBeTruthy();
  });

  it('recalcula a cada gravação (a revisão muda → DOC-08 de novo)', async () => {
    const fetchMock = stub([
      withViolations([violation('TR_ITEMS_REQUIRED', { message: 'Sem itens.' })]),
      withViolations([]),
    ]);
    const user = userEvent.setup();
    function Harness() {
      const [revision, setRevision] = useState(1);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setRevision((value) => value + 1);
            }}
          >
            Gravar seção
          </button>
          <TermCompletionPanel
            term={termDto()}
            sections={SECTIONS}
            revision={revision}
            onSelectSection={() => undefined}
          />
        </>
      );
    }
    renderWithShell(<Harness />);
    expect(await screen.findByText('1 pendência impede a conclusão')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Gravar seção' }));
    expect(
      await screen.findByText('Nenhuma pendência: o TR está pronto para ser concluído.'),
    ).toBeTruthy();
    const calls = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).includes('/validation'),
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('[Falha de banco] erro ao calcular: mensagem e "Tentar novamente"', async () => {
    const user = userEvent.setup();
    stub([() => problemResponse(503, 'DEPENDENCY_UNAVAILABLE'), withViolations([])]);
    renderWithShell(
      <TermCompletionPanel
        term={termDto()}
        sections={SECTIONS}
        revision={0}
        onSelectSection={() => undefined}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByText('Nenhuma pendência: o TR está pronto para ser concluído.'),
    ).toBeTruthy();
  });

  it('[Sucesso] TR concluído: sem consulta de pendências e o aviso de edição bloqueada', () => {
    const fetchMock = stub([withViolations([])]);
    renderWithShell(
      <TermCompletionPanel
        term={termDto({ status: 'FINALIZED' })}
        sections={SECTIONS}
        revision={0}
        onSelectSection={() => undefined}
      />,
    );
    expect(
      screen.getByText('TR concluído. A edição está bloqueada até a reabertura.'),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes('/validation')),
    ).toHaveLength(0);
  });

  it('[Acessibilidade] painel com pendências sem violações sérias (axe)', async () => {
    stub([withViolations([violation('TR_ITEMS_REQUIRED', { field: 'items' }), DIVERGENT])]);
    const { container } = renderWithShell(
      <TermCompletionPanel
        term={termDto()}
        sections={SECTIONS}
        revision={0}
        onSelectSection={() => undefined}
      />,
    );
    await screen.findByText('1 pendência impede a conclusão');
    expect(await seriousA11yViolations(container)).toEqual([]);
  });
});

describe('Ação de conclusão do TR (ciclo de vida)', () => {
  it('[Permissão] o botão só aparece com a ação permitida pela API', () => {
    renderWithShell(
      <DocumentActionsBar
        allowedActions={['FINALIZE']}
        labels={{ FINALIZE: 'Concluir TR' }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Concluir TR' })).toBeTruthy();
  });

  it('FA-03: com aprovação avulsa, "Submeter para aprovação"; sem permissão, nenhum botão', () => {
    const { unmount } = renderWithShell(
      <DocumentActionsBar
        allowedActions={['SUBMIT']}
        labels={{ SUBMIT: 'Submeter para aprovação' }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Submeter para aprovação' })).toBeTruthy();
    unmount();
    renderWithShell(
      <DocumentActionsBar
        allowedActions={[]}
        labels={{ FINALIZE: 'Concluir TR' }}
        onAction={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Concluir TR' })).toBeNull();
  });
});
