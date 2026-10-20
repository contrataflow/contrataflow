// @vitest-environment jsdom
import type { EtpDetailDto, EtpTemplateSectionDto, Violation } from '@contrataflow/validation';
import { cleanup, configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  bodyOf,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { conclusionProblemOf, pendingSummaryOf, pendingTargetOf } from './etp-conclusion-model';
import { EtpConclusionFieldset, EtpPendingSummary } from './etp-conclusion-section';
import { DocumentActionsBar } from '../documents/document-actions-bar';

configure({ asyncUtilTimeout: 8_000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-023 — conclusão do ETP na SCR-008 com a API simulada: `EtpConclusionFieldset` (ETP-04 com
 * `If-Match` da versão do ETP a cada escolha, aviso de não viabilidade, 412, somente leitura),
 * `EtpPendingSummary` ("Pendências para concluir" com links para a seção, o quadro ou o campo;
 * bloqueantes antes dos avisos), o botão "Concluir ETP" do ciclo de vida (oculto sem FINALIZE —
 * Permissão) e axe.
 */

const ETP_ID = ID(900);
const AT = '2026-10-20T17:31:00.000Z';
const NOT_VIABLE_TEXT = 'Este ETP conclui pela não viabilidade da contratação';

function etpDto(extra: Partial<EtpDetailDto> = {}): EtpDetailDto {
  return {
    id: ETP_ID,
    documentId: ETP_ID,
    processId: PROCESS_ID,
    code: 'ETP 0007/2026',
    title: 'Estudo Técnico Preliminar — 0012/2026',
    status: 'DRAFT',
    conclusion: 'PENDING',
    importedFromDfdVersionId: null,
    responsibleId: null,
    templateVersionId: ID(901),
    documentVersion: 4,
    itemsCount: 2,
    createdAt: AT,
    updatedAt: AT,
    version: 3,
    recommendedAlternativeId: null,
    parcelingDecision: null,
    estimatedValueSource: null,
    estimatedTotalValue: null,
    estimatedTotalValueMasked: false,
    priceResearchId: null,
    draftRevision: 0,
    draftContent: { sections: {} },
    ...extra,
  };
}

function section(key: string, title: string, order: number): EtpTemplateSectionDto {
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
  section('NEED_DESCRIPTION', 'Descrição da necessidade', 1),
  section('ESTIMATES', 'Estimativas das quantidades', 2),
  section('ALTERNATIVES', 'Levantamento de mercado', 3),
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

function mockApi(options: { patch?: (init?: RequestInit) => Response } = {}) {
  let etp = etpDto();
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if (url === `/api/v1/etps/${ETP_ID}` && init?.method === 'PATCH') {
      if (options.patch) return Promise.resolve(options.patch(init));
      etp = { ...etp, ...(bodyOf(init) as Partial<EtpDetailDto>), version: etp.version + 1 };
      return Promise.resolve(
        jsonResponse({ data: etp, meta: { allowedActions: ['UPDATE'], template: null } }),
      );
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const patchCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => requestUrl(input) === `/api/v1/etps/${ETP_ID}` && init?.method === 'PATCH',
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Regras de tela da conclusão do ETP (US-023)', () => {
  it('pendingTargetOf: seção, campos de conclusão e os quadros de itens/alternativas', () => {
    expect(
      pendingTargetOf(violation('SECTION_REQUIRED', { sectionKey: 'NEED_DESCRIPTION' }), SECTIONS),
    ).toEqual({ kind: 'section', key: 'NEED_DESCRIPTION' });
    expect(
      pendingTargetOf(violation('SECTION_REQUIRED', { sectionKey: 'OUTRA' }), SECTIONS),
    ).toEqual({ kind: 'none' });
    expect(pendingTargetOf(violation('FIELD_REQUIRED', { field: 'conclusion' }), SECTIONS)).toEqual(
      { kind: 'conclusion', field: 'conclusion' },
    );
    expect(
      pendingTargetOf(violation('FIELD_REQUIRED', { field: 'parcelingDecision' }), SECTIONS),
    ).toEqual({ kind: 'conclusion', field: 'parcelingDecision' });
    for (const code of ['ITEMS_REQUIRED', 'ETP_ESTIMATED_VALUE_REQUIRED']) {
      expect(pendingTargetOf(violation(code), SECTIONS)).toEqual({
        kind: 'section',
        key: 'ESTIMATES',
      });
    }
    expect(pendingTargetOf(violation('ETP_RECOMMENDED_ALTERNATIVE_REQUIRED'), SECTIONS)).toEqual({
      kind: 'section',
      key: 'ALTERNATIVES',
    });
    expect(pendingTargetOf(violation('ETP_RECOMMENDED_ALTERNATIVE_REQUIRED'), [])).toEqual({
      kind: 'none',
    });
    expect(pendingTargetOf(violation('WORKFLOW_RULE'), SECTIONS)).toEqual({ kind: 'none' });
  });

  it('pendingSummaryOf separa bloqueantes e avisos; conclusionProblemOf traduz o ETP-04', () => {
    const summary = pendingSummaryOf([
      violation('A'),
      violation('ETP_NOT_VIABLE_CONCLUSION', { severity: 'WARNING' }),
    ]);
    expect(summary.blocking.map((item) => item.code)).toEqual(['A']);
    expect(summary.warnings.map((item) => item.code)).toEqual(['ETP_NOT_VIABLE_CONCLUSION']);
    const error = (status: number, code: string) =>
      new ApiError({ status, code, detail: code, correlationId: 'c-1' });
    expect(conclusionProblemOf(error(412, 'VERSION_CONFLICT'))).toEqual({
      kind: 'message',
      key: 'conflict',
    });
    expect(conclusionProblemOf(error(403, 'PERMISSION_DENIED'))).toMatchObject({
      key: 'forbidden',
    });
    expect(conclusionProblemOf(error(409, 'DOCUMENT_NOT_EDITABLE'))).toMatchObject({
      key: 'notEditable',
    });
    expect(conclusionProblemOf(error(503, 'DEPENDENCY_UNAVAILABLE'))).toMatchObject({
      key: 'unavailable',
    });
    expect(conclusionProblemOf(error(422, 'VALIDATION_ERROR'))).toMatchObject({ key: 'invalid' });
    expect(conclusionProblemOf(error(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(conclusionProblemOf(new Error('x'))).toEqual({ kind: 'unexpected', correlationId: '—' });
  });
});

describe('Conclusão do ETP (US-023 · SCR-008)', () => {
  it('[Sucesso] definir conclusão e parcelamento: PATCH /etps com If-Match da versão; NOT_VIABLE mostra o aviso', async () => {
    const fetchMock = mockApi();
    const user = userEvent.setup();
    renderWithShell(<EtpConclusionFieldset etp={etpDto()} editable />);
    expect(screen.getByText('Conclusão ainda não definida.')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'A contratação não é viável' }));
    await waitFor(() => {
      expect(patchCalls(fetchMock)).toHaveLength(1);
    });
    const [, init] = patchCalls(fetchMock)[0] ?? [];
    expect(bodyOf(init)).toEqual({ conclusion: 'NOT_VIABLE' });
    expect(new Headers(init?.headers).get('If-Match')).toBe('"3"');

    cleanup();
    renderWithShell(
      <EtpConclusionFieldset etp={etpDto({ conclusion: 'NOT_VIABLE', version: 4 })} editable />,
    );
    expect(screen.getByText(NOT_VIABLE_TEXT)).toBeTruthy();

    await user.selectOptions(
      screen.getByLabelText(/Decisão sobre o parcelamento/),
      'Não parcelar a contratação',
    );
    await waitFor(() => {
      expect(patchCalls(fetchMock)).toHaveLength(2);
    });
    expect(bodyOf(patchCalls(fetchMock)[1]?.[1])).toEqual({ parcelingDecision: 'NOT_PARCELED' });
  });

  it('[Concorrência] 412 no ETP-04: mensagem de dados alterados por outra pessoa', async () => {
    mockApi({ patch: () => problemResponse(412, 'VERSION_CONFLICT') });
    const user = userEvent.setup();
    renderWithShell(<EtpConclusionFieldset etp={etpDto()} editable />);
    await user.click(screen.getByRole('radio', { name: 'A contratação é viável' }));
    expect(await screen.findByText(/alterados por outra pessoa/)).toBeTruthy();
  });

  it('[Permissão] somente leitura: campos desabilitados e sem "Concluir ETP" sem FINALIZE', () => {
    mockApi();
    renderWithShell(
      <>
        <EtpConclusionFieldset etp={etpDto({ conclusion: 'VIABLE' })} editable={false} />
        <DocumentActionsBar
          allowedActions={[]}
          labels={{ FINALIZE: 'Concluir ETP' }}
          onAction={() => undefined}
        />
      </>,
    );
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'A contratação é viável' }).disabled,
    ).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>(/Decisão sobre o parcelamento/).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Concluir ETP' })).toBeNull();
  });

  it('"Concluir ETP" no lugar de "Finalizar" quando FINALIZE é permitido', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    renderWithShell(
      <DocumentActionsBar
        allowedActions={['UPDATE', 'FINALIZE']}
        labels={{ FINALIZE: 'Concluir ETP' }}
        onAction={onAction}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Concluir ETP' }));
    expect(onAction).toHaveBeenCalledWith('FINALIZE', expect.anything());
    expect(screen.queryByRole('button', { name: 'Finalizar' })).toBeNull();
  });
});

describe('Pendências para concluir (US-023)', () => {
  it('lista bloqueantes e avisos com links focáveis que levam à seção, ao quadro ou ao campo; axe', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithShell(
      <EtpPendingSummary
        loaded
        sections={SECTIONS}
        onNavigate={onNavigate}
        violations={[
          violation('SECTION_REQUIRED', {
            sectionKey: 'NEED_DESCRIPTION',
            message: 'Preencha a seção "Descrição da necessidade".',
          }),
          violation('FIELD_REQUIRED', {
            field: 'parcelingDecision',
            message: 'Informe a decisão sobre o parcelamento.',
          }),
          violation('ETP_RECOMMENDED_ALTERNATIVE_REQUIRED', {
            message: 'Defina a alternativa recomendada antes de concluir.',
          }),
          violation('ETP_NOT_VIABLE_CONCLUSION', {
            severity: 'WARNING',
            field: 'conclusion',
            message: NOT_VIABLE_TEXT,
          }),
        ]}
      />,
    );
    expect(screen.getByText('3 pendências impedem a conclusão')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Preencha a seção "Descrição da necessidade".' }),
    );
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'section', key: 'NEED_DESCRIPTION' });
    await user.click(
      screen.getByRole('button', { name: 'Informe a decisão sobre o parcelamento.' }),
    );
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'conclusion', field: 'parcelingDecision' });
    await user.click(
      screen.getByRole('button', { name: 'Defina a alternativa recomendada antes de concluir.' }),
    );
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'section', key: 'ALTERNATIVES' });
    expect(screen.getByText('Aviso')).toBeTruthy();
    expect(screen.getByRole('button', { name: NOT_VIABLE_TEXT })).toBeTruthy();
    expect(await seriousA11yViolations(container)).toEqual([]);
  });

  it('sem pendências: pronto para concluir; só avisos: confirmar ao concluir; carregando', () => {
    const props = { sections: SECTIONS, onNavigate: () => undefined };
    renderWithShell(<EtpPendingSummary {...props} loaded={false} violations={[]} />);
    expect(screen.getByText('Verificando as pendências do ETP…')).toBeTruthy();
    cleanup();
    renderWithShell(<EtpPendingSummary {...props} loaded violations={[]} />);
    expect(screen.getByText(/pronto para ser concluído/)).toBeTruthy();
    cleanup();
    renderWithShell(
      <EtpPendingSummary
        {...props}
        loaded
        violations={[violation('ETP_NOT_VIABLE_CONCLUSION', { severity: 'WARNING' })]}
      />,
    );
    expect(screen.getByText(/Há aviso a confirmar ao concluir/)).toBeTruthy();
  });

  it('axe no conjunto de conclusão com o aviso de não viabilidade', async () => {
    mockApi();
    const { container } = renderWithShell(
      <EtpConclusionFieldset etp={etpDto({ conclusion: 'NOT_VIABLE' })} editable />,
    );
    expect(screen.getByText(NOT_VIABLE_TEXT)).toBeTruthy();
    expect(await seriousA11yViolations(container)).toEqual([]);
  });
});
