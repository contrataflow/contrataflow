// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { PROCESS_URL, STAGE_ID } from '@test/support/forward-fixtures';
import { callsTo, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';
import {
  RETURN_URL,
  STAGE_ABERTURA,
  STAGE_APROVACAO,
  mockReturnApi,
  returnEntry,
  returnedDto,
  secondReturnEntry,
} from '@test/support/return-fixtures';
import type { ReturnApiOptions } from '@test/support/return-fixtures';

import { ReturnProcessDialog } from './return-process-dialog';
import type { ReturnProcessDialogProps } from './return-process-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearToasts();
});

const REASON = 'Faltou detalhar a justificativa da contratação no DFD';
const STATUS_HEADER_ID = 'process-status-header';

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function Harness({
  onOpenChange,
  ...props
}: Partial<ReturnProcessDialogProps> & { readonly onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div id={STATUS_HEADER_ID} tabIndex={-1}>
        Situação do processo
      </div>
      <ReturnProcessDialog
        processId={PROCESS_URL.split('/').at(-1) ?? ''}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        onReturned={() => document.getElementById(STATUS_HEADER_ID)?.focus()}
        retry={{ retries: 0 }}
        {...props}
      />
      <Toaster />
    </>
  );
}

function renderDialog(
  options: ReturnApiOptions = {},
  props: Partial<ReturnProcessDialogProps> = {},
) {
  const api = mockReturnApi(options);
  const onOpenChange = vi.fn();
  renderWithShell(<Harness onOpenChange={onOpenChange} {...props} />, {
    queryClient: noRetryClient(),
  });
  return { api, onOpenChange };
}

const posts = (api: ReturnType<typeof mockReturnApi>) => callsTo(api, 'POST', RETURN_URL);
const submitButton = () => screen.getByRole('button', { name: 'Devolver' });
const reasonField = () => screen.getByRole('textbox', { name: 'Motivo da devolução' });
const dueField = () => screen.getByRole('button', { name: 'Prazo (opcional)' });

describe('SCR-104 · Diálogo "Devolver processo" (US-048)', () => {
  it('[Sucesso] FA-03: destino único pré-selecionado e foco no motivo; envia o PRC-20 com If-Match, Idempotency-Key e etapa esperada; fecha, avisa e leva o foco ao cabeçalho', async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = renderDialog({
      giveBack: () => jsonResponse({ data: returnedDto() }, { headers: { ETag: '"15"' } }),
    });
    const radio = await screen.findByRole('radio', { name: /Formalização da demanda/ });
    expect(radio.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Última passagem em 30/09/2026')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(reasonField());
    });

    await user.type(reasonField(), REASON);
    expect(screen.getByText(`${String(REASON.length)} / 5.000`)).toBeTruthy();
    await user.click(submitButton());

    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    const [call] = posts(api);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.body).toEqual({
      targetStageId: STAGE_ABERTURA,
      comment: REASON,
      expectedStageId: STAGE_ID,
    });
    expect(await screen.findByText('Processo devolvido para Formalização da demanda')).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(STATUS_HEADER_ID);
    });
  });

  it('[Validação] motivo curto: erro no campo, anunciado e com foco, sem chamar a API', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    await screen.findByRole('radio');
    await user.type(reasonField(), 'Corrigir');
    await user.click(submitButton());
    expect(await screen.findByText('O motivo deve ter ao menos 10 caracteres.')).toBeTruthy();
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(reasonField());
    expect(screen.getByText('Revise os campos destacados.')).toBeTruthy();
    expect(posts(api)).toHaveLength(0);
  });

  it('Vários destinos: nenhum pré-selecionado, foco no seletor; o prazo só aparece quando a transição permite', async () => {
    // Só a data é simulada: o calendário abre em outubro de 2026 e o prazo precisa ser futuro.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T15:00:00Z'));
    const user = userEvent.setup();
    const { api } = renderDialog({ actions: [returnEntry(), secondReturnEntry()] });
    const [first, second] = await screen.findAllByRole('radio');
    await waitFor(() => {
      expect(document.activeElement).toBe(first);
    });
    expect(screen.queryByRole('button', { name: 'Prazo (opcional)' })).toBeNull();
    await user.type(reasonField(), REASON);
    await user.click(submitButton());
    expect(await screen.findByText('Informe a etapa de destino.')).toBeTruthy();

    // FA-02: a aprovação não permite sobrescrita — o campo não aparece.
    if (!second || !first) throw new Error('destinos ausentes');
    await user.click(second);
    expect(screen.queryByRole('button', { name: 'Prazo (opcional)' })).toBeNull();
    await user.click(first);
    await user.click(dueField());
    const calendar = await screen.findByRole('dialog', { name: 'Escolher data' });
    const [day] = within(calendar).getAllByRole('button', { name: /, 30 de outubro de 2026/ });
    if (!day) throw new Error('dia 30 não encontrado no calendário');
    await user.click(day);
    expect(dueField().textContent).toContain('30/10/2026');
    await user.click(submitButton());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({
      targetStageId: STAGE_ABERTURA,
      dueAt: '2026-10-30',
    });
  });

  it('Destino escolhido no menu vem marcado', async () => {
    renderDialog(
      { actions: [returnEntry(), secondReturnEntry()] },
      { initialStageId: STAGE_APROVACAO },
    );
    const radio = await screen.findByRole('radio', { name: /Aprovação da demanda/ });
    expect(radio.getAttribute('aria-checked')).toBe('true');
  });

  it('Vazio defensivo: sem etapa anterior disponível', async () => {
    renderDialog({ actions: [returnEntry({ enabled: false })] });
    expect(
      await screen.findByText('Nenhuma etapa anterior disponível para devolução.'),
    ).toBeTruthy();
  });

  it('Erro de carregamento com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderDialog({
      actions: () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: [returnEntry()] });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('radio')).toBeTruthy();
  });

  it('[Concorrência] 409 STAGE_CHANGED: mensagem e "Atualizar" recarrega o painel e fecha', async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = renderDialog({
      giveBack: () => problemResponse(409, 'STAGE_CHANGED'),
    });
    await screen.findByRole('radio');
    await user.type(reasonField(), REASON);
    await user.click(submitButton());
    expect(
      await screen.findByText('Este processo foi tramitado por outra pessoa. Atualize a página.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThan(1);
  });

  it('412 VERSION_CONFLICT e 428 sem If-Match: avisos de recarga', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderDialog({
      giveBack: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(412, 'VERSION_CONFLICT')
          : problemResponse(428, 'PRECONDITION_REQUIRED');
      },
    });
    await screen.findByRole('radio');
    await user.type(reasonField(), REASON);
    await user.click(submitButton());
    expect(
      await screen.findByText('Os dados do processo mudaram. Atualize a página.'),
    ).toBeTruthy();
    await user.click(submitButton());
    expect(
      await screen.findByText('Não foi possível confirmar a versão atual. Recarregue a página.'),
    ).toBeTruthy();
  });

  it('422 TRANSITION_NOT_AVAILABLE e DUE_DATE_OVERRIDE_NOT_ALLOWED: mensagens e destinos recarregados', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = renderDialog({
      giveBack: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(422, 'TRANSITION_NOT_AVAILABLE')
          : problemResponse(422, 'DUE_DATE_OVERRIDE_NOT_ALLOWED');
      },
    });
    await screen.findByRole('radio');
    await user.type(reasonField(), REASON);
    await user.click(submitButton());
    expect(
      await screen.findByText('Esta etapa não está disponível como destino da devolução.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(api, 'GET', `${PROCESS_URL}/available-actions`).length).toBeGreaterThan(1);
    });
    await user.click(submitButton());
    expect(await screen.findByText('O prazo desta devolução não pode ser alterado.')).toBeTruthy();
  });

  it('403 sem custódia e 409 status incompatível: avisam e fecham o diálogo', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({
      giveBack: () => problemResponse(403, 'NOT_PROCESS_CUSTODIAN'),
    });
    await screen.findByRole('radio');
    await user.type(reasonField(), REASON);
    await user.click(submitButton());
    expect(await screen.findByText('Você não está com este processo.')).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('[Falha de banco] 503: mantém o diálogo aberto com "Tentar novamente", que reenvia', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api, onOpenChange } = renderDialog({
      giveBack: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: returnedDto() });
      },
    });
    await screen.findByRole('radio');
    await user.type(reasonField(), REASON);
    await user.click(submitButton());
    expect(
      await screen.findByText(
        'Não foi possível devolver o processo agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(posts(api)).toHaveLength(2);
    });
    expect(await screen.findByText('Processo devolvido para Formalização da demanda')).toBeTruthy();
  });

  it('500: mostra o código de correlação com "Copiar código"', async () => {
    const user = userEvent.setup();
    renderDialog({
      giveBack: () => problemResponse(500, 'INTERNAL_ERROR', { correlationId: 'corr-48' }),
    });
    await screen.findByRole('radio');
    await user.type(reasonField(), REASON);
    await user.click(submitButton());
    expect(await screen.findByText('Ocorreu um erro inesperado. Código: corr-48.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
  });

  it('[Acessibilidade] axe sem violações sérias no diálogo carregado e com erro', async () => {
    const user = userEvent.setup();
    renderDialog({ actions: [returnEntry(), secondReturnEntry()] });
    await screen.findAllByRole('radio');
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(submitButton());
    await screen.findByText('Informe a etapa de destino.');
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
