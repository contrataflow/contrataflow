// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ProcessDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
  processDto,
} from '@test/support/process-fixtures';
import type { ProcessApiOptions } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import { EditProcessSheet } from './edit-process-sheet';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const PATH = `/api/v1/processes/${PROCESS_ID}`;
const inProgress = (extra: Partial<ProcessDto> = {}) =>
  processDto({ status: 'IN_PROGRESS', version: 8, ...extra });

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderSheet(process: ProcessDto, options: ProcessApiOptions = {}) {
  const api = mockProcessApi({
    process: () => jsonResponse({ data: process }),
    permissions: ['PROCESS_CREATE', 'PROCESS_UPDATE'],
    ...options,
  });
  const onOpenChange = vi.fn();
  const view = renderWithShell(
    <>
      <EditProcessSheet processId={PROCESS_ID} open onOpenChange={onOpenChange} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return { api, onOpenChange, view };
}

const field = (name: string | RegExp) => screen.findByLabelText(name);
const save = () => screen.getByRole('button', { name: 'Salvar alterações' });

describe('SCR-006 · Painel "Editar dados" (US-005)', () => {
  it('[Sucesso] envia só os campos alterados com If-Match e fecha com o toast', async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = renderSheet(inProgress(), {
      update: () => jsonResponse({ data: inProgress({ version: 9, priority: 'HIGH' }) }),
    });

    const title = await field(/^Título/);
    await user.clear(title);
    await user.type(title, 'Aquisição de cimento CP-II para manutenção de vias');
    await user.selectOptions(await field(/^Prioridade/), 'HIGH');
    expect(screen.getAllByText('Alterado')).toHaveLength(2);
    await user.click(save());

    await waitFor(() => {
      expect(callsTo(api, 'PATCH', PATH)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PATCH', PATH);
    expect(call?.headers.get('If-Match')).toBe('"8"');
    expect(call?.body).toEqual({
      title: 'Aquisição de cimento CP-II para manutenção de vias',
      priority: 'HIGH',
    });
    expect(await screen.findByText('Dados do processo atualizados')).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('[Validação] campos bloqueados depois do primeiro encaminhamento com cadeado e explicação', async () => {
    renderSheet(inProgress());
    const secretariat = await field(/Secretaria solicitante/);
    expect(secretariat.getAttribute('aria-readonly')).toBe('true');
    expect(secretariat.getAttribute('readonly')).not.toBeNull();
    expect(
      screen.getAllByText(
        'Definido na abertura. Não pode ser alterado depois do primeiro encaminhamento.',
      ),
      // Órgão, secretaria e setor.
    ).toHaveLength(3);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] valor estimado com fonte de maior precedência: somente leitura com a fonte', async () => {
    renderSheet(inProgress({ estimatedValue: '92450.00', estimatedValueSource: 'PRICE_RESEARCH' }));
    const value = await field(/^Valor estimado/);
    expect(value.getAttribute('aria-readonly')).toBe('true');
    expect(
      screen.getByText(
        'Valor obtido de Pesquisa de preços. Para alterá-lo, ajuste o documento de origem.',
      ),
    ).toBeTruthy();
  });

  it('[Validação] erros por campo antes de enviar; sem alteração efetiva fecha sem PATCH (FA-08)', async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = renderSheet(inProgress());
    const title = await field(/^Título/);
    await user.clear(title);
    await user.type(title, 'abc');
    await user.click(save());
    expect(await screen.findByText('O título deve ter entre 5 e 200 caracteres.')).toBeTruthy();
    expect(screen.getByText('Revise os campos destacados.')).toBeTruthy();
    expect(callsTo(api, 'PATCH', PATH)).toHaveLength(0);

    await user.clear(title);
    await user.type(title, ` ${inProgress().title} `);
    await user.click(save());
    expect(await screen.findByText('Nenhuma alteração para salvar.')).toBeTruthy();
    expect(callsTo(api, 'PATCH', PATH)).toHaveLength(0);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[Validação] 422 da API marca o campo (código interno duplicado)', async () => {
    const user = userEvent.setup();
    renderSheet(inProgress(), {
      update: () =>
        problemResponse(409, 'DUPLICATE_INTERNAL_CODE', {
          errors: [
            {
              field: 'internalCode',
              code: 'NOT_ALLOWED',
              message: 'Já existe um processo com o código interno PROT-2026-0457.',
            },
          ],
        }),
    });
    await user.type(await field(/^Código interno/), 'PROT-2026-0457');
    await user.click(save());
    expect(
      await screen.findByText('Já existe um processo com o código interno PROT-2026-0457.'),
    ).toBeTruthy();
  });

  it('[Concorrência] 412: comparação com meta.current e "Reaplicar minhas alterações" com o ETag atual', async () => {
    const user = userEvent.setup();
    const current = {
      ...inProgress({
        version: 9,
        estimatedValue: '92450.00',
        estimatedValueSource: 'PRICE_RESEARCH',
        notes: 'Ajustada pela Juliana',
        updatedAt: '2026-10-05T15:02:10.000Z',
      }),
      updatedBy: { id: PROCESS_ID, name: 'Juliana Costa' },
    };
    let calls = 0;
    const { api } = renderSheet(inProgress(), {
      update: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(412, 'VERSION_CONFLICT', {
              extension: { currentVersion: 9, meta: { current } },
            })
          : jsonResponse({ data: { ...current, version: 10, priority: 'HIGH' } });
      },
    });
    await user.selectOptions(await field(/^Prioridade/), 'HIGH');
    await user.type(await field(/^Observações/), 'Minha observação');
    await user.click(save());

    const panel = await screen.findByRole('alert', {
      name: /Este processo foi alterado por Juliana Costa às/,
    });
    // Só as observações foram alteradas pelas duas pessoas.
    const rows = within(panel).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain('Minha observação');
    expect(rows[1]?.textContent).toContain('Ajustada pela Juliana');
    expect(within(panel).getByRole('button', { name: 'Descartar e recarregar' })).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Reaplicar minhas alterações' }));

    await waitFor(() => {
      expect(callsTo(api, 'PATCH', PATH)).toHaveLength(2);
    });
    const reapplied = callsTo(api, 'PATCH', PATH)[1];
    expect(reapplied?.headers.get('If-Match')).toBe('"9"');
    expect(reapplied?.body).toEqual({ priority: 'HIGH' });
  });

  it('[Concorrência] perda de custódia: avisa que nada foi salvo e oferece copiar os textos', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderSheet(inProgress(), {
      update: () => problemResponse(403, 'NOT_PROCESS_CUSTODIAN'),
    });
    await user.type(await field(/^Observações/), 'Texto importante');
    await user.click(save());
    expect(
      await screen.findByText(
        'O processo saiu da sua responsabilidade. Suas alterações não foram salvas.',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copiar meus textos' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Texto importante'));
  });

  it('[Falha de banco] 503 mantém os valores digitados e oferece tentar novamente', async () => {
    const user = userEvent.setup();
    renderSheet(inProgress(), {
      update: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
    });
    const notes = await field(/^Observações/);
    await user.type(notes, 'Não perder');
    await user.click(save());
    expect(
      await screen.findByText('Não foi possível salvar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect((notes as HTMLTextAreaElement).value).toBe('Não perder');
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });

  it('[Permissão] processo aguardando aprovação: 409 deixa o painel somente leitura com o motivo', async () => {
    const user = userEvent.setup();
    renderSheet(inProgress(), {
      update: () =>
        problemResponse(409, 'INVALID_PROCESS_STATUS', {
          detail: 'Não é possível editar enquanto o processo aguarda aprovação.',
        }),
    });
    await user.selectOptions(await field(/^Prioridade/), 'HIGH');
    await user.click(save());
    expect(
      await screen.findByText('Não é possível editar enquanto o processo aguarda aprovação.'),
    ).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it('[Sucesso] rascunho: troca do setor solicitante com os avisos do DFD e da custódia (FA-04)', async () => {
    const user = userEvent.setup();
    const { api } = renderSheet(processDto());
    const department = await field(/Setor solicitante/);
    await waitFor(() => {
      expect(within(department).getAllByRole('option').length).toBeGreaterThan(2);
    });
    const other = within(department)
      .getAllByRole('option')
      .find((option) => option.textContent === 'Departamento de Projetos');
    await user.selectOptions(department, other?.getAttribute('value') ?? '');
    expect(
      screen.getByText(
        'O DFD já criado não é alterado automaticamente; revise o campo Setor no DFD.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('O processo continua com Setor de Manutenção até ser encaminhado.'),
    ).toBeTruthy();
    await user.click(save());
    await waitFor(() => {
      expect(callsTo(api, 'PATCH', PATH)[0]?.body).toEqual({
        requestingDepartmentId: other?.getAttribute('value'),
      });
    });
  });

  it('[FA-07] fechar com alterações não salvas pede confirmação', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderSheet(inProgress());
    await user.type(await field(/^Observações/), 'Rascunho');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByRole('dialog', { name: 'Descartar as alterações?' })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
