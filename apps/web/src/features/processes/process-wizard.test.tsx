// @vitest-environment jsdom
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { chooseOption, optionLabels, pickDate } from '@test/support/kit';
import {
  AQUISICAO,
  CANDIDATE,
  DEPARTMENTS,
  FARMACIA,
  MANUTENCAO,
  NAO_PREVISTA,
  OBRAS,
  ORG_FUND,
  ORG_MAIN,
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
  processDto,
  unit,
} from '@test/support/process-fixtures';
import {
  TENANT_A,
  jsonResponse,
  renderWithShell,
  requestUrl,
  shellSession,
} from '@test/support/render';

import { NewProcessButton } from './new-process-button';
import { NewProcessPage } from './new-process-page';
import { draftStorageKey, initialValues } from './process-form-model';
import type { ProcessFormValues, WizardStep } from './process-form-model';
import { ProcessWizard } from './process-wizard';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/processos/novo',
}));

const DRAFT_KEY = draftStorageKey(TENANT_A.id, shellSession().user.id);
const POST_URL = '/api/v1/processes';
const TITLE = 'Aquisição de cimento para manutenção de vias';
const OBJECT = 'Aquisição de cimento Portland para a manutenção das vias do município.';
const NOT_PLANNED_MESSAGE =
  'Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres).';
const WORKFLOW_TEXT =
  'Este processo seguirá o fluxo Fase preparatória — Lei 14.133/2021, começando em Formalização da demanda.';

beforeEach(() => {
  sessionStorage.clear();
  nav.push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const stepHeading = (name: string) => screen.findByRole('heading', { level: 2, name });
const combobox = (label: string) => screen.getByRole('combobox', { name: label });
/** Texto escolhido no Select do kit; vazio quando o gatilho mostra o placeholder. */
const shown = (label: string) => {
  const trigger = combobox(label);
  return trigger.hasAttribute('data-placeholder') ? '' : trigger.textContent.trim();
};
/** Grupos (rótulo e opções) do Select aberto de nome `label`; fecha com Esc. */
async function groupsOf(user: UserEvent, label: string) {
  await user.click(combobox(label));
  const groups = (await screen.findAllByRole('group')).map((group) => {
    const labelId = group.getAttribute('aria-labelledby') ?? '';
    return {
      label: document.getElementById(labelId)?.textContent ?? '',
      options: within(group)
        .getAllByRole('option')
        .map((option) => option.textContent),
    };
  });
  await user.keyboard('{Escape}');
  return groups;
}
/** Escolhe a opção num Select que pode ainda estar carregando. */
async function choose(user: UserEvent, label: string, option: string) {
  await screen.findByRole('combobox', { name: label });
  await chooseOption(user, label, option);
}

async function paste(user: UserEvent, element: HTMLElement, text: string) {
  await user.click(element);
  await user.paste(text);
}

async function fillIdentification(user: UserEvent) {
  await user.type(await screen.findByLabelText('Título *'), TITLE);
  await paste(user, screen.getByLabelText('Objeto *'), OBJECT);
  await choose(user, 'Tipo de contratação *', 'Aquisição de bens');
}

async function toStep2(user: UserEvent) {
  await fillIdentification(user);
  await user.click(button('Continuar'));
  await stepHeading('Origem e planejamento');
  await waitFor(() => {
    expect(shown('Setor solicitante *')).toBe(MANUTENCAO.name);
  });
}

async function toReview(user: UserEvent) {
  await toStep2(user);
  await choose(user, 'Origem *', 'Demanda não prevista');
  await user.click(screen.getByRole('radio', { name: 'Não se aplica' }));
  await user.click(button('Continuar'));
  await stepHeading('Revisão');
}

function validValues(overrides: Partial<ProcessFormValues> = {}): ProcessFormValues {
  return {
    ...initialValues(new Date().getFullYear()),
    title: TITLE,
    object: OBJECT,
    contractingTypeId: AQUISICAO.id,
    organizationId: ORG_MAIN.id,
    requestingSecretariatId: OBRAS.id,
    requestingDepartmentId: MANUTENCAO.id,
    originId: NAO_PREVISTA.id,
    pcaStatus: 'NOT_APPLICABLE',
    ...overrides,
  };
}

function seedDraft(step: WizardStep, values: ProcessFormValues) {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, step, values }));
}

const created = () =>
  jsonResponse(
    { data: processDto() },
    { status: 201, headers: { Location: `/api/v1/processes/${PROCESS_ID}`, ETag: '"1"' } },
  );

describe('[Validação] passo 1 · Identificação', () => {
  it('sem título: "Informe o título." junto ao campo e NÃO avança', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await stepHeading('Identificação');
    await user.click(await screen.findByRole('button', { name: 'Continuar' }));

    expect(await screen.findByText('Informe o título.')).toBeTruthy();
    expect(screen.getByText('Informe o objeto.')).toBeTruthy();
    expect(screen.getByText('Informe o tipo de contratação.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Identificação' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Origem e planejamento' })).toBeNull();
    // Foco no primeiro campo com erro; erro ligado ao campo e banner anunciado.
    const title = screen.getByLabelText('Título *');
    expect(document.activeElement).toBe(title);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.getAttribute('aria-describedby')).toContain('error');
    expect(screen.getByRole('alert').textContent).toContain('Revise os campos destacados.');
  });

  it('o erro some ao corrigir o campo e o passo avança com foco no título do passo seguinte', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await user.click(await screen.findByRole('button', { name: 'Continuar' }));
    await screen.findByText('Informe o título.');
    await fillIdentification(user);
    expect(screen.queryByText('Informe o título.')).toBeNull();
    await user.click(button('Continuar'));
    const heading = await stepHeading('Origem e planejamento');
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it('tipo de contratação sem itens ativos: estado vazio com orientação', async () => {
    mockProcessApi({ catalogs: { CONTRACTING_TYPE: [] } });
    renderWithShell(<ProcessWizard />);
    expect(
      await screen.findByText('Nenhum tipo de contratação ativo. Fale com o administrador.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Tipo de contratação *')).toBeNull();
  });

  it('skeleton enquanto carrega e erro de carregamento com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockProcessApi({
      catalogs: {
        CONTRACTING_TYPE: () => {
          calls += 1;
          return calls === 1
            ? problemResponse(403, 'PERMISSION_DENIED')
            : jsonResponse({ data: [AQUISICAO], meta: { page: 1 } });
        },
        MODALITY: () => new Promise<Response>(() => undefined),
      },
    });
    renderWithShell(<ProcessWizard />);
    // O catálogo de modalidades nunca responde: o skeleton continua anunciado.
    expect(screen.getAllByText('Carregando…').length).toBeGreaterThan(0);
    expect(
      await screen.findByText('Não foi possível carregar as opções do formulário.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByLabelText('Tipo de contratação *')).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('modalidade vazia significa "A definir"', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    const modality = await screen.findByRole('combobox', { name: 'Modalidade prevista' });
    // Sem escolha o gatilho mostra "A definir" como placeholder (valor vazio).
    expect(modality.hasAttribute('data-placeholder')).toBe(true);
    expect(modality.textContent).toBe('A definir');
    expect(shown('Modalidade prevista')).toBe('');
    // A primeira opção da lista devolve o campo a "A definir" depois de uma escolha.
    const labels = await optionLabels(user, 'Modalidade prevista');
    expect(labels[0]).toBe('A definir');
    await chooseOption(user, 'Modalidade prevista', labels[1] ?? '');
    expect(shown('Modalidade prevista')).toBe(labels[1]);
    await chooseOption(user, 'Modalidade prevista', 'A definir');
    expect(shown('Modalidade prevista')).toBe('');
  });
});

describe('passo 2 · Origem e planejamento', () => {
  it('pré-preenche secretaria e setor pela lotação principal, prioridade Média e exercício corrente; órgão único fica oculto', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await fillIdentification(user);
    await user.click(button('Continuar'));
    await stepHeading('Origem e planejamento');

    await waitFor(() => {
      expect(shown('Secretaria solicitante *')).toBe(OBRAS.name);
    });
    expect(shown('Setor solicitante *')).toBe(MANUTENCAO.name);
    expect(shown('Prioridade *')).toBe('Média');
    expect(screen.queryByLabelText('Órgão/entidade *')).toBeNull();
    // FA-05: as lotações do usuário no topo da lista de setores.
    const groups = await groupsOf(user, 'Setor solicitante *');
    expect(groups.map((group) => group.label)).toEqual(['Suas lotações', 'Demais unidades']);
    expect(groups[0]?.options).toEqual(['Setor de Manutenção']);
    // Exercício do PCA = ano corrente.
    await user.click(screen.getByRole('radio', { name: 'Previsto no PCA' }));
    expect(screen.getByLabelText<HTMLInputElement>('Exercício do PCA *').value).toBe(
      String(new Date().getFullYear()),
    );
  });

  it('usa os rótulos configurados da instituição para secretaria e setor', async () => {
    const user = userEvent.setup();
    mockProcessApi({
      settings: { 'labels.secretariat': 'Diretoria', 'labels.department': 'Divisão' },
    });
    renderWithShell(<ProcessWizard />);
    await fillIdentification(user);
    await user.click(button('Continuar'));
    await stepHeading('Origem e planejamento');
    expect(await screen.findByLabelText('Diretoria solicitante *')).toBeTruthy();
    expect(screen.getByLabelText('Divisão solicitante *')).toBeTruthy();
  });

  it('trocar a secretaria limpa um setor que não pertence a ela', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await toStep2(user);
    await chooseOption(user, 'Secretaria solicitante *', 'Secretaria de Saúde');
    expect(shown('Setor solicitante *')).toBe('');
    expect(await optionLabels(user, 'Setor solicitante *')).not.toContain('Setor de Manutenção');
    await chooseOption(user, 'Setor solicitante *', FARMACIA.name);
    expect(shown('Setor solicitante *')).toBe(FARMACIA.name);
  });

  it('FA-04: com vários órgãos, trocar o órgão limpa secretaria e setor e recarrega as opções', async () => {
    const user = userEvent.setup();
    const fundUnit = unit(30, 'Secretaria do Fundo', null, { organizationId: ORG_FUND.id });
    const api = mockProcessApi({
      organizations: [ORG_MAIN, ORG_FUND],
      departments: [...DEPARTMENTS, fundUnit],
    });
    renderWithShell(<ProcessWizard />);
    await toStep2(user);
    expect(shown('Órgão/entidade *')).toBe(ORG_MAIN.name);
    await chooseOption(user, 'Órgão/entidade *', 'Fundo Municipal de Saúde');

    await waitFor(async () => {
      expect(await optionLabels(user, 'Secretaria solicitante *')).toContain('Secretaria do Fundo');
    });
    expect(shown('Secretaria solicitante *')).toBe('');
    expect(shown('Setor solicitante *')).toBe('');
    expect(await optionLabels(user, 'Secretaria solicitante *')).not.toContain(
      'Secretaria de Obras',
    );
    expect(
      api.mock.calls.filter(([url]) => requestUrl(url).includes(`organizationId=${ORG_FUND.id}`)),
    ).toHaveLength(1);
  });

  it('FA-08: o escopo OWN_DEPARTMENTS só oferece as unidades das lotações do usuário', async () => {
    const user = userEvent.setup();
    mockProcessApi({ scopes: [{ type: 'OWN_DEPARTMENTS', includeSubtree: false }] });
    renderWithShell(<ProcessWizard />);
    await toStep2(user);
    expect(await optionLabels(user, 'Secretaria solicitante *')).toEqual(['Secretaria de Obras']);
    expect(await optionLabels(user, 'Setor solicitante *')).toEqual(['Setor de Manutenção']);
  });

  it('sem nenhuma unidade coberta pelo escopo: mensagem de estado vazio', async () => {
    const user = userEvent.setup();
    mockProcessApi({
      scopes: [{ type: 'DEPARTMENT', departmentId: ORG_FUND.id, includeSubtree: true }],
    });
    renderWithShell(<ProcessWizard />);
    await fillIdentification(user);
    await user.click(button('Continuar'));
    await stepHeading('Origem e planejamento');
    expect(
      await screen.findByText(
        'Nenhuma unidade disponível para você abrir processos. Fale com o administrador.',
      ),
    ).toBeTruthy();
  });

  it('sem lotações no ME-03 o wizard continua e só deixa de pré-preencher', async () => {
    const user = userEvent.setup();
    mockProcessApi({ lotations: [] });
    renderWithShell(<ProcessWizard />);
    await fillIdentification(user);
    await user.click(button('Continuar'));
    await stepHeading('Origem e planejamento');
    await screen.findByLabelText('Secretaria solicitante *');
    await waitFor(() => {
      expect(shown('Secretaria solicitante *')).toBe('');
    });
  });

  it('PCA "Não previsto": mostra a justificativa com a mensagem exata e não deixa continuar', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await toStep2(user);
    await choose(user, 'Origem *', 'Demanda não prevista');
    await user.click(screen.getByRole('radio', { name: 'Não previsto no PCA' }));

    const justification = screen.getByLabelText('Justificativa *');
    expect(screen.getByText(NOT_PLANNED_MESSAGE)).toBeTruthy();
    expect(justification.getAttribute('aria-invalid')).toBe('true');

    await user.click(button('Continuar'));
    expect(screen.getByRole('heading', { level: 2, name: 'Origem e planejamento' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Revisão' })).toBeNull();

    await paste(user, justification, 'Curta demais');
    expect(screen.getByText(NOT_PLANNED_MESSAGE)).toBeTruthy();
    await user.clear(justification);
    await paste(user, justification, 'Demanda surgida após a aprovação do plano anual.');
    expect(screen.queryByText(NOT_PLANNED_MESSAGE)).toBeNull();
    await user.click(button('Continuar'));
    await stepHeading('Revisão');
  });

  it('prazo alvo anterior a hoje e valor inválido são recusados no passo', async () => {
    const user = userEvent.setup();
    // O calendário não deixa escolher dia passado; a regra continua valendo para o rascunho.
    seedDraft('origin', validValues({ targetDate: '2020-01-01' }));
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await stepHeading('Origem e planejamento');
    await paste(user, await screen.findByLabelText('Valor estimado'), '10,555');
    await user.click(button('Continuar'));
    expect(await screen.findByText('O prazo alvo não pode ser anterior a hoje.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prazo alvo' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(
      screen.getByText('Informe um valor válido, com até 2 casas decimais.', { selector: 'p' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Origem e planejamento' })).toBeTruthy();
  });

  it('prazo alvo: escolhe a data no calendário, grava no rascunho e não oferece dias passados', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await toStep2(user);
    const next = new Date();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    next.setDate(28);
    const iso = `${String(next.getFullYear())}-${String(next.getMonth() + 1).padStart(2, '0')}-28`;

    await pickDate(user, 'Prazo alvo', iso);
    expect(screen.getByRole('button', { name: 'Prazo alvo' }).textContent).toContain(
      `28/${iso.slice(5, 7)}/${iso.slice(0, 4)}`,
    );
    await waitFor(() => {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as {
        values: { targetDate: string };
      } | null;
      expect(saved?.values.targetDate).toBe(iso);
    });
    // Reabre no mês escolhido; dois meses antes (anterior a hoje) todos os dias ficam desabilitados.
    await user.click(screen.getByRole('button', { name: 'Prazo alvo' }));
    const calendar = await screen.findByRole('dialog', { name: /^Escolher/ });
    const previous = within(calendar).getByRole('button', { name: /anterior|previous/i });
    await user.click(previous);
    await user.click(previous);
    const days = within(calendar)
      .getAllByRole('gridcell')
      .filter((cell) => !cell.hasAttribute('data-outside'))
      .map((cell) => cell.querySelector('button'));
    expect(days.length).toBeGreaterThan(27);
    expect(days.every((day) => day?.disabled === true)).toBe(true);
  });

  it('valor em reais é normalizado ao sair do campo', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await toStep2(user);
    const value = screen.getByLabelText<HTMLInputElement>('Valor estimado');
    await paste(user, value, '15000,5');
    await user.tab();
    expect(value.value).toBe('15.000,50');
  });
});

describe('[Sucesso] passo 3 · Revisão e criação', () => {
  it('jornada completa: resumo, fluxo aplicável, POST com Idempotency-Key, rascunho limpo e navegação', async () => {
    const user = userEvent.setup();
    const api = mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await toReview(user);

    // Resumo e cartão do fluxo (WF-06).
    const summary = screen.getByRole('heading', { level: 3, name: 'Resumo' }).parentElement;
    expect(summary?.textContent).toContain(TITLE);
    expect(summary?.textContent).toContain('Aquisição de bens');
    expect(summary?.textContent).toContain('Setor de Manutenção');
    expect(summary?.textContent).toContain('Não se aplica');
    await waitFor(() => {
      expect(document.body.textContent).toContain(WORKFLOW_TEXT);
    });
    expect(callsTo(api, 'POST', '/api/v1/workflows/resolve')[0]?.body).toEqual({
      contractingTypeId: AQUISICAO.id,
      originId: NAO_PREVISTA.id,
      organizationId: ORG_MAIN.id,
      isPriceRegistration: false,
    });
    expect(callsTo(api, 'POST', '/api/v1/processes/check-duplicates')[0]?.body).toEqual({
      title: TITLE,
      object: OBJECT,
      requestingDepartmentId: MANUTENCAO.id,
    });
    // "Mais informações" recolhida.
    const more = screen.getByRole('button', { name: /Mais informações/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(sessionStorage.getItem(DRAFT_KEY)).toContain(TITLE);

    await user.click(button('Criar processo'));
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    const [post] = callsTo(api, 'POST', POST_URL);
    expect(callsTo(api, 'POST', POST_URL)).toHaveLength(1);
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toEqual({
      title: TITLE,
      object: OBJECT,
      contractingTypeId: AQUISICAO.id,
      isPriceRegistration: false,
      organizationId: ORG_MAIN.id,
      requestingSecretariatId: OBRAS.id,
      requestingDepartmentId: MANUTENCAO.id,
      priority: 'MEDIUM',
      originId: NAO_PREVISTA.id,
      pcaStatus: 'NOT_APPLICABLE',
    });
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('botão fica desabilitado como "Criando processo…" durante o envio e as consultas do tenant são invalidadas', async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    mockProcessApi({
      create: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    const { queryClient } = renderWithShell(<ProcessWizard />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await toReview(user);
    await user.click(button('Criar processo'));

    const busy = await screen.findByRole('button', { name: 'Criando processo…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    release(created());
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(['t', TENANT_A.id, 'processes']),
        JSON.stringify(['t', TENANT_A.id, 'tasks']),
        JSON.stringify(['t', TENANT_A.id, 'dashboard']),
      ]),
    );
    // Depois do sucesso o botão não volta a aceitar cliques enquanto a navegação acontece.
    expect(screen.getByRole('button', { name: 'Criando processo…' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('wizard sem violações sérias de acessibilidade nos três passos', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await stepHeading('Identificação');
    await screen.findByLabelText('Tipo de contratação *');
    expect(await seriousA11yViolations()).toEqual([]);
    await fillIdentification(user);
    await user.click(button('Continuar'));
    await stepHeading('Origem e planejamento');
    await user.click(await screen.findByRole('radio', { name: 'Não previsto no PCA' }));
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(screen.getByRole('radio', { name: 'Não se aplica' }));
    await choose(user, 'Origem *', 'Plano anual');
    await user.click(button('Continuar'));
    await stepHeading('Revisão');
    await waitFor(() => {
      expect(document.body.textContent).toContain(WORKFLOW_TEXT);
    });
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('o stepper volta a passos concluídos e "Editar" leva ao passo do dado', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(screen.getByRole('button', { name: 'Editar Identificação' }));
    await stepHeading('Identificação');
    expect(screen.getByLabelText<HTMLInputElement>('Título *').value).toBe(TITLE);
    await user.click(button('Continuar'));
    await stepHeading('Origem e planejamento');
  });
});

describe('[Duplicidade] FA-02', () => {
  it('PRC-03 com candidatos mostra o painel com links e "Criar mesmo assim" reenvia com confirmDuplicate e a MESMA chave', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockProcessApi({
      duplicates: () => jsonResponse({ data: { candidates: [CANDIDATE] } }),
      create: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(409, 'POSSIBLE_DUPLICATE_PROCESS', {
              extension: { candidates: [CANDIDATE] },
            })
          : created();
      },
    });
    renderWithShell(<ProcessWizard />);
    await toReview(user);

    expect(
      await screen.findByText('Encontramos processos parecidos criados recentemente.'),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: '0011/2026' });
    expect(link.getAttribute('href')).toBe(`/processos/${CANDIDATE.id}`);
    expect(
      screen.getByRole('link', { name: 'Abrir processo existente 0011/2026' }).getAttribute('href'),
    ).toBe(`/processos/${CANDIDATE.id}`);
    expect(screen.getByText(/Rascunho · criado por Ana Souza em/)).toBeTruthy();

    // 1º envio sem confirmação → 409 (salvaguarda da API) → o painel continua e pede a decisão.
    await user.click(button('Criar processo'));
    await waitFor(() => {
      expect(callsTo(api, 'POST', POST_URL)).toHaveLength(1);
    });
    expect(callsTo(api, 'POST', POST_URL)[0]?.body).not.toHaveProperty('confirmDuplicate');
    expect(nav.push).not.toHaveBeenCalled();

    await user.click(button('Criar mesmo assim'));
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    const posts = callsTo(api, 'POST', POST_URL);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toMatchObject({ confirmDuplicate: true, title: TITLE });
    expect(posts[1]?.headers.get('Idempotency-Key')).toBe(posts[0]?.headers.get('Idempotency-Key'));
  });

  it('409 do POST (sem aviso prévio do PRC-03) mostra o painel com os candidatos do corpo', async () => {
    const user = userEvent.setup();
    mockProcessApi({
      create: () =>
        problemResponse(409, 'POSSIBLE_DUPLICATE_PROCESS', {
          extension: { candidates: [CANDIDATE] },
        }),
    });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    expect(screen.queryByText('Encontramos processos parecidos criados recentemente.')).toBeNull();
    await user.click(button('Criar processo'));
    expect(
      await screen.findByText('Encontramos processos parecidos criados recentemente.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: '0011/2026' })).toBeTruthy();
    expect(button('Criar mesmo assim')).toBeTruthy();
  });

  it('código interno duplicado: erro no campo, seção aberta e nada é criado', async () => {
    const user = userEvent.setup();
    mockProcessApi({ create: () => problemResponse(409, 'DUPLICATE_INTERNAL_CODE') });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(button(/Mais informações/));
    await user.type(screen.getByLabelText('Código interno'), 'PROT-2026-0457');
    await user.click(button('Criar processo'));
    expect(
      await screen.findByText('Já existe um processo com o código interno PROT-2026-0457.'),
    ).toBeTruthy();
    expect(button(/Mais informações/).getAttribute('aria-expanded')).toBe('true');
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('FA-09 · código interno exigido', () => {
  it('sai de "Mais informações" e passa a ser obrigatório no passo 3', async () => {
    const user = userEvent.setup();
    seedDraft('review', validValues());
    const api = mockProcessApi({ settings: { 'process.requireInternalCode': true } });
    renderWithShell(<ProcessWizard />);
    await stepHeading('Revisão');
    const field = await screen.findByLabelText('Código interno *');
    const more = document.getElementById(
      button(/Mais informações/).getAttribute('aria-controls') ?? '',
    );
    expect(more?.contains(field)).toBe(false);

    await user.click(button('Criar processo'));
    expect(await screen.findByText('Informe o código interno.')).toBeTruthy();
    expect(document.activeElement).toBe(field);
    expect(callsTo(api, 'POST', POST_URL)).toHaveLength(0);

    await user.type(field, 'PROT-1');
    await user.click(button('Criar processo'));
    await waitFor(() => {
      expect(callsTo(api, 'POST', POST_URL)[0]?.body).toMatchObject({ internalCode: 'PROT-1' });
    });
  });
});

describe('[Fluxo] FA-06 · sem workflow aplicável', () => {
  it('mostra a orientação e desabilita "Criar processo", mantendo os dados', async () => {
    const user = userEvent.setup();
    const api = mockProcessApi({ resolve: () => problemResponse(422, 'NO_APPLICABLE_WORKFLOW') });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    expect(
      await screen.findByText(
        'Não há fluxo configurado para este tipo de contratação. Fale com o administrador do órgão.',
      ),
    ).toBeTruthy();
    expect(button('Criar processo').hasAttribute('disabled')).toBe(true);
    await user.click(button('Criar processo'));
    expect(callsTo(api, 'POST', POST_URL)).toHaveLength(0);
    expect(document.body.textContent).toContain(TITLE);
  });

  it('NO_APPLICABLE_WORKFLOW devolvido pelo POST também bloqueia a criação', async () => {
    const user = userEvent.setup();
    mockProcessApi({ create: () => problemResponse(422, 'NO_APPLICABLE_WORKFLOW') });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(button('Criar processo'));
    await waitFor(() => {
      expect(button('Criar processo').hasAttribute('disabled')).toBe(true);
    });
    expect(
      screen.getAllByText(
        'Não há fluxo configurado para este tipo de contratação. Fale com o administrador do órgão.',
      ),
    ).not.toHaveLength(0);
  });

  it('falha ao consultar o fluxo não impede a criação (a API resolve)', async () => {
    const user = userEvent.setup();
    const api = mockProcessApi({ resolve: () => problemResponse(403, 'PERMISSION_DENIED') });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    expect(await screen.findByText(/Não foi possível verificar o fluxo agora/)).toBeTruthy();
    expect(button('Criar processo').hasAttribute('disabled')).toBe(false);
    await user.click(button('Criar processo'));
    await waitFor(() => {
      expect(callsTo(api, 'POST', POST_URL)).toHaveLength(1);
    });
  });
});

describe('[Falhas] criação', () => {
  it('503: mantém os dados, mostra a mensagem com o correlationId e reenvia com a mesma chave', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockProcessApi({
      create: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-503-xyz' })
          : created();
      },
    });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(button('Criar processo'));

    expect(
      await screen.findByText(
        'Não foi possível criar o processo agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Código: c-503-xyz')).toBeTruthy();
    // Dados mantidos: continua na revisão, com o resumo e o rascunho.
    expect(screen.getByRole('heading', { level: 2, name: 'Revisão' })).toBeTruthy();
    expect(document.body.textContent).toContain(TITLE);
    expect(sessionStorage.getItem(DRAFT_KEY)).toContain(TITLE);
    expect(nav.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    const posts = callsTo(api, 'POST', POST_URL);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers.get('Idempotency-Key')).toBe(posts[0]?.headers.get('Idempotency-Key'));
    expect(posts[1]?.body).toEqual(posts[0]?.body);
  });

  it('IDEMPOTENCY_IN_PROGRESS: aguarda e repete com a mesma chave', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockProcessApi({
      create: () => {
        calls += 1;
        return calls === 1 ? problemResponse(409, 'IDEMPOTENCY_IN_PROGRESS') : created();
      },
    });
    renderWithShell(<ProcessWizard inProgressDelayMs={5} />);
    await toReview(user);
    await user.click(button('Criar processo'));
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    const posts = callsTo(api, 'POST', POST_URL);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers.get('Idempotency-Key')).toBe(posts[0]?.headers.get('Idempotency-Key'));
  });

  it('IDEMPOTENCY_KEY_REUSED: avisa, gera nova chave e pede nova confirmação', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockProcessApi({
      create: () => {
        calls += 1;
        return calls === 1 ? problemResponse(422, 'IDEMPOTENCY_KEY_REUSED') : created();
      },
    });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(button('Criar processo'));
    expect(
      await screen.findByText(
        'Esta solicitação já foi enviada com outros dados. Revise os dados e confirme novamente.',
      ),
    ).toBeTruthy();
    expect(nav.push).not.toHaveBeenCalled();
    await user.click(button('Criar processo'));
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    const posts = callsTo(api, 'POST', POST_URL);
    expect(posts[1]?.headers.get('Idempotency-Key')).not.toBe(
      posts[0]?.headers.get('Idempotency-Key'),
    );
  });

  it('403 PERMISSION_DENIED: mensagem do setor e atalho para escolher outro', async () => {
    const user = userEvent.setup();
    mockProcessApi({ create: () => problemResponse(403, 'PERMISSION_DENIED') });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(button('Criar processo'));
    expect(
      await screen.findByText('Você não tem permissão para abrir processos para este setor.'),
    ).toBeTruthy();
    await user.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Origem e planejamento' }),
    );
    await stepHeading('Origem e planejamento');
    await waitFor(() => {
      expect(document.activeElement).toBe(combobox('Setor solicitante *'));
    });
  });

  it('422 de validação: volta ao passo do campo, marca o erro e recarrega opções em referência inválida', async () => {
    const user = userEvent.setup();
    const api = mockProcessApi({
      create: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'contractingTypeId',
              code: 'REFERENCE_INACTIVE',
              message: 'Selecione um tipo de contratação válido.',
            },
          ],
        }),
    });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(button('Criar processo'));
    await stepHeading('Identificação');
    expect(await screen.findByText('Selecione um tipo de contratação válido.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Tipo de contratação *'));
    expect(screen.getByText(/Alguma opção escolhida não está mais disponível/)).toBeTruthy();
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).includes('/catalogs/CONTRACTING_TYPE/'))
          .length,
      ).toBeGreaterThan(1);
    });
  });

  it('erro inesperado (500) mantém os dados e mostra o código', async () => {
    const user = userEvent.setup();
    mockProcessApi({
      create: () => problemResponse(500, 'INTERNAL_ERROR', { correlationId: 'c-500-abc' }),
    });
    renderWithShell(<ProcessWizard />);
    await toReview(user);
    await user.click(button('Criar processo'));
    expect(await screen.findByText('Ocorreu um erro inesperado.')).toBeTruthy();
    expect(screen.getByText('Código: c-500-abc')).toBeTruthy();
    expect(document.body.textContent).toContain(TITLE);
  });
});

describe('FA-01 · rascunho local e abandono', () => {
  it('grava o que foi digitado em sessionStorage por usuário + instituição', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await user.type(await screen.findByLabelText('Título *'), 'Meu rascunho');
    await waitFor(() => {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as {
        step: string;
        values: { title: string };
      } | null;
      expect(saved?.values.title).toBe('Meu rascunho');
      expect(saved?.step).toBe('identification');
    });
  });

  it('ao recarregar mostra "Recuperamos o que você estava preenchendo" e restaura passo e dados', async () => {
    const user = userEvent.setup();
    seedDraft('origin', validValues({ title: 'Título recuperado do rascunho' }));
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    expect(await screen.findByText('Recuperamos o que você estava preenchendo')).toBeTruthy();
    await stepHeading('Origem e planejamento');
    await screen.findByRole('combobox', { name: 'Origem *' });
    expect(shown('Origem *')).toBe(NAO_PREVISTA.label);
    // A secretaria/o setor escolhidos no rascunho não são sobrescritos pelo pré-preenchimento.
    await waitFor(() => {
      expect(shown('Setor solicitante *')).toBe(MANUTENCAO.name);
    });
    await user.click(button('Voltar'));
    await stepHeading('Identificação');
    expect(screen.getByLabelText<HTMLInputElement>('Título *').value).toBe(
      'Título recuperado do rascunho',
    );
  });

  it('rascunho de outro usuário ou instituição não é recuperado', async () => {
    sessionStorage.setItem(
      draftStorageKey('outro-tenant', shellSession().user.id),
      JSON.stringify({ version: 1, step: 'origin', values: validValues() }),
    );
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await stepHeading('Identificação');
    expect(screen.queryByText('Recuperamos o que você estava preenchendo')).toBeNull();
  });

  it('"Começar do zero" descarta o rascunho', async () => {
    const user = userEvent.setup();
    seedDraft('review', validValues());
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await user.click(await screen.findByRole('button', { name: 'Começar do zero' }));
    await stepHeading('Identificação');
    expect(screen.queryByText('Recuperamos o que você estava preenchendo')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Título *').value).toBe('');
    await waitFor(() => {
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    });
  });

  it('rascunho que chega à revisão com dados inválidos mantém "Criar processo" desabilitado', async () => {
    const user = userEvent.setup();
    seedDraft('review', validValues({ pcaStatus: 'NOT_PLANNED', pcaJustification: '' }));
    const api = mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await stepHeading('Revisão');
    expect(button('Criar processo').hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText(
        'Há campos a corrigir em “Origem e planejamento”. Volte a esse passo para continuar.',
      ),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', POST_URL)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Ir para “Origem e planejamento”' }));
    await stepHeading('Origem e planejamento');
    expect(screen.getByText(NOT_PLANNED_MESSAGE)).toBeTruthy();
  });

  it('"Cancelar" sem alterações sai direto; com alterações pede confirmação e descarta', async () => {
    const user = userEvent.setup();
    mockProcessApi();
    const { unmount } = renderWithShell(<ProcessWizard />);
    await user.click(await screen.findByRole('button', { name: 'Cancelar' }));
    expect(nav.push).toHaveBeenCalledWith('/processos');
    unmount();

    nav.push.mockClear();
    mockProcessApi();
    renderWithShell(<ProcessWizard />);
    await user.type(await screen.findByLabelText('Título *'), 'Algo digitado');
    await user.click(button('Cancelar'));
    const dialog = await screen.findByRole('dialog', { name: 'Descartar o que você preencheu?' });
    expect(nav.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Continuar preenchendo' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sessionStorage.getItem(DRAFT_KEY)).toContain('Algo digitado');

    await user.click(button('Cancelar'));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Descartar e sair' }),
    );
    expect(nav.push).toHaveBeenCalledWith('/processos');
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('sair por um link do shell com alterações pede confirmação; link do painel de duplicidade não', async () => {
    const user = userEvent.setup();
    mockProcessApi({ duplicates: () => jsonResponse({ data: { candidates: [CANDIDATE] } }) });
    renderWithShell(
      <>
        <a href="/painel">Ir ao painel</a>
        <ProcessWizard />
      </>,
    );
    await user.type(await screen.findByLabelText('Título *'), 'Algo digitado');
    await user.click(screen.getByRole('link', { name: 'Ir ao painel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Descartar o que você preencheu?' });
    expect(nav.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Descartar e sair' }));
    expect(nav.push).toHaveBeenCalledWith('/painel');
  });

  it('links para processos existentes não pedem confirmação e preservam o rascunho', async () => {
    const user = userEvent.setup();
    seedDraft('review', validValues());
    mockProcessApi({ duplicates: () => jsonResponse({ data: { candidates: [CANDIDATE] } }) });
    renderWithShell(<ProcessWizard />);
    const link = await screen.findByRole('link', { name: '0011/2026' });
    link.addEventListener('click', (event) => {
      event.preventDefault();
    });
    await user.click(link);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });
});

describe('rota /processos/novo e botão "Novo processo"', () => {
  it('sem PROCESS_CREATE a rota mostra a página 403 (SCR-111)', async () => {
    mockProcessApi({ permissions: ['PROCESS_VIEW'] });
    renderWithShell(<NewProcessPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Acesso negado' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ir para o início' })).toBeTruthy();
    expect(screen.queryByLabelText('Título *')).toBeNull();
  });

  it('com PROCESS_CREATE a rota abre o wizard', async () => {
    mockProcessApi();
    renderWithShell(<NewProcessPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Novo processo' })).toBeTruthy();
    expect(await screen.findByLabelText('Título *')).toBeTruthy();
  });

  it('o botão global só aparece com PROCESS_CREATE e leva a /processos/novo', async () => {
    mockProcessApi({ permissions: ['PROCESS_CREATE'] });
    const first = renderWithShell(<NewProcessButton />);
    const link = await screen.findByRole('link', { name: 'Novo processo' });
    expect(link.getAttribute('href')).toBe('/processos/novo');
    first.unmount();

    mockProcessApi({ permissions: ['SOMENTE_LEITURA'] });
    renderWithShell(
      <>
        <NewProcessButton />
        <p>carregado</p>
      </>,
    );
    await screen.findByText('carregado');
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Novo processo' })).toBeNull();
    });
  });
});
