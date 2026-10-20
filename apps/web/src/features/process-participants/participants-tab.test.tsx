// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ProcessParticipantDto, ProcessParticipantsMeta } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  bodyOf,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import { FollowToggleButton } from './follow-toggle-button';
import { ParticipantsTab } from './participants-tab';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const LIST = `/api/v1/processes/${PROCESS_ID}/participants`;
const FOLLOW = `/api/v1/processes/${PROCESS_ID}/follow`;

type Route = (url: string, init?: RequestInit) => Response | undefined;

function participant(n: number, extra: Partial<ProcessParticipantDto> = {}): ProcessParticipantDto {
  return {
    id: ID(800 + n),
    processId: PROCESS_ID,
    principalType: 'USER',
    userId: ID(700 + n),
    departmentId: null,
    principal: { id: ID(700 + n), name: `Pessoa ${String(n)}`, isExternal: false },
    role: 'OBSERVER',
    notify: true,
    expiresAt: null,
    grantedAt: '2026-10-10T13:00:00.000Z',
    grantedBy: { id: ID(1), name: 'Carla Dias' },
    reason: null,
    ...extra,
  };
}

const DIEGO = {
  id: ID(750),
  name: 'Diego Alves',
  email: 'diego@consultoria.test',
  membershipType: 'EXTERNAL',
  membershipExpiresAt: '2099-12-31T00:00:00.000Z',
};

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderTab(
  items: readonly ProcessParticipantDto[],
  meta: ProcessParticipantsMeta,
  options: { handler?: Route; permissions?: string[]; follow?: boolean } = {},
) {
  const api = mockProcessApi({
    permissions: options.permissions ?? ['PROCESS_VIEW', 'PROCESS_MANAGE_PARTICIPANTS'],
    participants: (url, init) => {
      const handled = options.handler?.(url, init);
      if (handled) return handled;
      if (url.startsWith('/api/v1/users/lookup')) return jsonResponse({ data: [DIEGO] });
      return jsonResponse({ data: items, meta });
    },
  });
  renderWithShell(
    <>
      {options.follow ? (
        <FollowToggleButton processId={PROCESS_ID} />
      ) : (
        <ParticipantsTab processId={PROCESS_ID} />
      )}
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return api;
}

describe('SCR-006 · aba "Participantes" (US-012 · SCR-112)', () => {
  it('[Sucesso] lista com papel, validade e quem concedeu; gestão visível e sem violações de acessibilidade', async () => {
    renderTab(
      [
        participant(1, { role: 'COLLABORATOR' }),
        participant(2, {
          principalType: 'DEPARTMENT',
          userId: null,
          departmentId: ID(20),
          principal: { id: ID(20), name: 'Secretaria de Saúde', isExternal: false },
          notify: false,
        }),
      ],
      { canManage: true, me: null },
    );
    const list = await screen.findByRole('list', { name: 'Participantes' });
    expect(within(list).getByText('Pessoa 1')).toBeTruthy();
    expect(within(list).getByText('Colaborador')).toBeTruthy();
    expect(within(list).getByText('Secretaria de Saúde')).toBeTruthy();
    expect(within(list).getByText('Unidade')).toBeTruthy();
    expect(within(list).getByText('Sem notificações')).toBeTruthy();
    expect(screen.getByText('2 participantes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Adicionar participante' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remover Pessoa 1' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Permissão] sem PROCESS_MANAGE_PARTICIPANTS: modo leitura, sem Adicionar/Remover', async () => {
    renderTab([], { canManage: false, me: null });
    expect(await screen.findByText('Nenhum participante além da tramitação.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar participante' })).toBeNull();
  });

  it('[Sucesso] adicionar consultor externo: papel sugerido, validade obrigatória e Idempotency-Key', async () => {
    const user = userEvent.setup();
    const created = participant(3, { role: 'CONSULTANT' });
    const api = renderTab(
      [],
      { canManage: true, me: null },
      {
        handler: (url, init) =>
          init?.method === 'POST' && url === LIST
            ? jsonResponse({ data: created }, { status: 201 })
            : undefined,
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Adicionar participante' }));
    const dialog = await screen.findByRole('dialog');
    const search = within(dialog).getByLabelText(/^Buscar usuário/);
    // Foco no campo de busca ao abrir (story · "Acessibilidade").
    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });
    await user.type(search, 'Die');
    await user.click(await within(dialog).findByRole('button', { name: /Diego Alves/ }));
    expect(within(dialog).getByText('Selecionado: Diego Alves')).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLSelectElement>(/^Papel/).value).toBe('CONSULTANT');

    await user.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
    expect(
      await within(dialog).findByText('Informe a validade da participação do consultor.'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', LIST)).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/^Validade/), '2030-01-31T18:00');
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', LIST)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', LIST);
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(bodyOf(call?.init)).toEqual({
      userId: DIEGO.id,
      role: 'CONSULTANT',
      notify: true,
      expiresAt: new Date('2030-01-31T18:00').toISOString(),
    });
    expect(await screen.findByText('Participante adicionado.')).toBeTruthy();
  });

  it('[Duplicidade] 409: avisa o papel atual e sugere remover antes', async () => {
    const user = userEvent.setup();
    renderTab(
      [],
      { canManage: true, me: null },
      {
        handler: (url, init) =>
          init?.method === 'POST' && url === LIST
            ? problemResponse(409, 'PARTICIPANT_ALREADY_EXISTS', {
                extension: { meta: { currentRole: 'COLLABORATOR' } },
              })
            : undefined,
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Adicionar participante' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Buscar usuário/), 'Die');
    await user.click(await within(dialog).findByRole('button', { name: /Diego Alves/ }));
    await user.selectOptions(within(dialog).getByLabelText(/^Papel/), 'OBSERVER');
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
    expect(
      await within(dialog).findByText(/já participa do processo como Colaborador/),
    ).toBeTruthy();
  });

  it('[Sucesso] remover com motivo opcional (DELETE PRC-30)', async () => {
    const user = userEvent.setup();
    const elisa = participant(4);
    const api = renderTab(
      [elisa],
      { canManage: true, me: null },
      {
        handler: (_url, init) =>
          init?.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined,
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Remover Pessoa 4' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Motivo da remoção/), 'Parecer entregue');
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    const url = `/api/v1/process-participants/${elisa.id}`;
    await waitFor(() => {
      expect(callsTo(api, 'DELETE', url)).toHaveLength(1);
    });
    expect(bodyOf(callsTo(api, 'DELETE', url)[0]?.init)).toEqual({
      revocationReason: 'Parecer entregue',
    });
    expect(await screen.findByText('Participante removido.')).toBeTruthy();
  });
});

describe('Botão "Seguir" no cabeçalho (DEC-180 · FA-01)', () => {
  it('[Sucesso] "Seguir" chama PRC-31 e anuncia; já seguindo mostra "Seguindo"', async () => {
    const user = userEvent.setup();
    let me: ProcessParticipantsMeta['me'] = null;
    const api = renderTab(
      [],
      { canManage: false, me: null },
      {
        permissions: ['PROCESS_VIEW', 'PROCESS_FOLLOW'],
        follow: true,
        handler: (url, init) => {
          if (init?.method === 'POST' && url === FOLLOW) {
            me = { participantId: ID(899), role: 'OBSERVER' };
            return jsonResponse({ data: participant(99) });
          }
          if (url === LIST) return jsonResponse({ data: [], meta: { canManage: false, me } });
          return undefined;
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Seguir' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', FOLLOW)).toHaveLength(1);
    });
    expect(await screen.findByText('Você está seguindo este processo.')).toBeTruthy();
    const following = await screen.findByRole('button', { name: 'Seguindo — deixar de seguir' });
    expect(following.getAttribute('aria-pressed')).toBe('true');
  });

  it('[Duplicidade] participante em outro papel: botão com o papel atual, desabilitado', async () => {
    renderTab(
      [],
      { canManage: false, me: { participantId: ID(801), role: 'COLLABORATOR' } },
      {
        permissions: ['PROCESS_VIEW', 'PROCESS_FOLLOW'],
        follow: true,
      },
    );
    const button = await screen.findByRole('button', { name: 'Participando como Colaborador' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
