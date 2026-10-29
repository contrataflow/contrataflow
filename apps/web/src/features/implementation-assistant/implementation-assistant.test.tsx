// @vitest-environment jsdom
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { renderWithShell } from '@test/support/render';

import { ImplementationAssistant } from './implementation-assistant';
import type { CreateDepartmentInput } from './implementation-assistant';
import {
  SUGGESTED_STRUCTURE,
  creationOrder,
  nameErrors,
  shouldShowImplementationAssistant,
} from './suggested-structure';
import type { SuggestedUnit } from './suggested-structure';

configure({ asyncUtilTimeout: 5000 });

const GABINETE: SuggestedUnit = {
  key: 'gabinete',
  name: 'Gabinete',
  type: 'SECRETARIAT',
  parentKey: null,
  selected: true,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/estrutura',
}));

function setup(
  create: (input: CreateDepartmentInput, key: string) => Promise<{ id: string }> = (input) =>
    Promise.resolve({ id: `id-${input.name}` }),
) {
  const createDepartment = vi.fn(create);
  const onDismiss = vi.fn();
  let counter = 0;
  const view = renderWithShell(
    <ImplementationAssistant
      organizationName="Prefeitura Municipal de São José"
      createDepartment={createDepartment}
      onDismiss={onDismiss}
      newKey={() => `key-${(counter += 1)}`}
    />,
  );
  return { ...view, createDepartment, onDismiss, user: userEvent.setup() };
}

describe('estrutura sugerida (FA-09 · RN-TEN-18)', () => {
  it('aparece só com DEPARTMENT_MANAGE e órgão sem unidades', () => {
    expect(
      shouldShowImplementationAssistant({ canManageDepartments: true, departmentCount: 0 }),
    ).toBe(true);
    expect(
      shouldShowImplementationAssistant({ canManageDepartments: true, departmentCount: 2 }),
    ).toBe(false);
    expect(
      shouldShowImplementationAssistant({ canManageDepartments: false, departmentCount: 0 }),
    ).toBe(false);
  });

  it('cria pais antes dos filhos e ignora filho de pai desmarcado', () => {
    expect(creationOrder(SUGGESTED_STRUCTURE).map((unit) => unit.key)).toEqual([
      'gabinete',
      'administracao',
      'compras',
    ]);
    const withoutParent = SUGGESTED_STRUCTURE.map((unit) =>
      unit.key === 'administracao' ? { ...unit, selected: false } : unit,
    );
    expect(creationOrder(withoutParent).map((unit) => unit.key)).toEqual(['gabinete']);
  });

  it('valida nomes vazios, curtos, longos e repetidos no mesmo nível', () => {
    const units = SUGGESTED_STRUCTURE.map((unit) =>
      unit.key === 'gabinete'
        ? { ...unit, name: ' secretaria de administração ' }
        : unit.key === 'compras'
          ? { ...unit, name: 'x' }
          : unit,
    );
    expect(nameErrors(units)).toEqual({
      gabinete: 'DUPLICATE',
      administracao: 'DUPLICATE',
      compras: 'TOO_SHORT',
    });
    expect(nameErrors([{ ...GABINETE, name: '' }])).toEqual({ gabinete: 'REQUIRED' });
    expect(nameErrors([{ ...GABINETE, name: 'a'.repeat(201) }])).toEqual({
      gabinete: 'TOO_LONG',
    });
  });
});

describe('ImplementationAssistant (SCR-032 · US-099)', () => {
  it('sugere a estrutura mínima editável e não cria nada sem confirmação', async () => {
    const { createDepartment, container } = setup();
    expect(screen.getByRole('heading', { name: 'Monte a estrutura mínima' })).toBeTruthy();
    expect(screen.getByDisplayValue('Gabinete')).toBeTruthy();
    expect(screen.getByDisplayValue('Secretaria de Administração')).toBeTruthy();
    expect(screen.getByDisplayValue('Setor de Compras')).toBeTruthy();
    expect(createDepartment).not.toHaveBeenCalled();
    expect(await seriousA11yViolations(container)).toEqual([]);
  });

  it('cria as unidades editadas com uma chave por unidade, anuncia o progresso e mostra os primeiros passos', async () => {
    const { createDepartment, user } = setup();
    const gabinete = screen.getByDisplayValue('Gabinete');
    await user.clear(gabinete);
    await user.type(gabinete, 'Gabinete do Prefeito');
    await user.click(screen.getByRole('button', { name: 'Criar estrutura' }));

    const heading = await screen.findByRole('heading', { name: 'Primeiros passos' });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(createDepartment.mock.calls).toEqual([
      [{ name: 'Gabinete do Prefeito', type: 'SECRETARIAT', parentId: null }, 'key-1'],
      [{ name: 'Secretaria de Administração', type: 'SECRETARIAT', parentId: null }, 'key-2'],
      [
        { name: 'Setor de Compras', type: 'SECTOR', parentId: 'id-Secretaria de Administração' },
        'key-3',
      ],
    ]);
    expect(screen.getByText('3 unidades criadas. Continue a implantação:')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Convidar usuários' }).getAttribute('href')).toBe(
      '/admin/usuarios',
    );
    expect(
      screen
        .getByRole('link', {
          name: 'Indicar a unidade de Compras na etapa de pesquisa de preços do workflow',
        })
        .getAttribute('href'),
    ).toBe('/admin/workflows');
  });

  it('desmarcar a secretaria desabilita o setor subordinado', async () => {
    const { createDepartment, user } = setup();
    await user.click(screen.getByRole('checkbox', { name: 'Criar Secretaria de Administração' }));
    expect(
      screen.getByRole('checkbox', { name: 'Criar Setor de Compras' }).hasAttribute('disabled'),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Criar estrutura' }));
    await screen.findByRole('heading', { name: 'Primeiros passos' });
    expect(createDepartment).toHaveBeenCalledTimes(1);
  });

  it('falha parcial mantém o que foi criado e repete com a mesma chave só o restante', async () => {
    let failOnce = true;
    const { createDepartment, user } = setup((input) => {
      if (input.name === 'Secretaria de Administração' && failOnce) {
        failOnce = false;
        return Promise.reject(new Error('503'));
      }
      return Promise.resolve({ id: `id-${input.name}` });
    });
    await user.click(screen.getByRole('button', { name: 'Criar estrutura' }));

    expect(await screen.findByText('Algumas unidades não foram criadas')).toBeTruthy();
    expect(screen.getByText('1 de 3 unidades criadas.')).toBeTruthy();
    expect(screen.getByText('Criada')).toBeTruthy();
    expect(screen.getByText('Não criada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agora não' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByRole('heading', { name: 'Primeiros passos' });
    expect(createDepartment.mock.calls.map(([input, key]) => [input.name, key])).toEqual([
      ['Gabinete', 'key-1'],
      ['Secretaria de Administração', 'key-2'],
      ['Secretaria de Administração', 'key-2'],
      ['Setor de Compras', 'key-3'],
    ]);
  });

  it('nome inválido bloqueia a criação com a mensagem no campo', async () => {
    const { createDepartment, user } = setup();
    await user.clear(screen.getByDisplayValue('Gabinete'));
    await user.click(screen.getByRole('button', { name: 'Criar estrutura' }));
    expect(screen.getByText('Informe o nome da unidade.')).toBeTruthy();
    expect(createDepartment).not.toHaveBeenCalled();
  });

  it('nada marcado pede uma escolha; "Agora não" descarta sem criar', async () => {
    const { createDepartment, onDismiss, user } = setup();
    await user.click(screen.getByRole('checkbox', { name: 'Criar Gabinete' }));
    await user.click(screen.getByRole('checkbox', { name: 'Criar Secretaria de Administração' }));
    await user.click(screen.getByRole('button', { name: 'Criar estrutura' }));
    expect(screen.getByText('Selecione ao menos uma unidade ou escolha "Agora não".')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Agora não' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(createDepartment).not.toHaveBeenCalled();
  });

  it('o tipo da unidade é editável', async () => {
    const { createDepartment, user } = setup();
    const [firstType] = screen.getAllByRole('combobox', { name: 'Tipo' });
    if (!firstType) throw new Error('sem campo de tipo');
    await user.click(firstType);
    await user.click(await screen.findByRole('option', { name: 'Diretoria' }));
    await user.click(screen.getByRole('button', { name: 'Criar estrutura' }));
    await screen.findByRole('heading', { name: 'Primeiros passos' });
    expect(createDepartment.mock.calls[0]?.[0]).toMatchObject({ name: 'Gabinete', type: 'BOARD' });
  });
});
