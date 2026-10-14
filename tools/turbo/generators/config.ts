// Geradores do monorepo (FA-03 da US-077):
//   pnpm turbo gen package      → packages/<nome> com tsconfig, ESLint, Vitest e package.json padrão
//   pnpm turbo gen api-module   → apps/api/src/modules/<módulo> com as camadas de DEC-041
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { PlopTypes } from '@turbo/gen';

interface ModuleLevels {
  readonly levels: readonly { readonly level: number; readonly modules: readonly string[] }[];
}

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Módulos de DEC-040 (tools/module-levels.json). O turbo gen empacota este arquivo em CJS. */
function declaredModules(plop: PlopTypes.NodePlopAPI): string[] {
  const file = path.resolve(plop.getPlopfilePath(), '..', '..', 'module-levels.json');
  const data = JSON.parse(readFileSync(file, 'utf8')) as ModuleLevels;
  return data.levels.flatMap(({ modules }) => modules);
}

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator('package', {
    description: 'Pacote compartilhado em packages/<nome> (@contrataflow/<nome>)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Nome do pacote (kebab-case, sem @contrataflow/):',
        validate: (input: string) => KEBAB_CASE.test(input) || 'Use kebab-case (ex.: date-utils).',
      },
      {
        type: 'input',
        name: 'description',
        message: 'Descrição em pt-BR:',
        validate: (input: string) => input.trim().length > 0 || 'Informe a descrição.',
      },
    ],
    actions: [
      {
        type: 'addMany',
        destination: '{{ turbo.paths.root }}/packages/{{ name }}',
        base: 'templates/package',
        templateFiles: 'templates/package/**/*.hbs',
        stripExtensions: ['hbs'],
        globOptions: { dot: true },
      },
      'Pacote criado. Rode "pnpm install", declare as dependências com "catalog:" e registre o pacote nas regras do .dependency-cruiser.cjs (architecture.md §4.3).',
    ],
  });

  plop.setGenerator('api-module', {
    description: 'Módulo da API com domain/application/infrastructure/presentation (DEC-041)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Nome do módulo (kebab-case, declarado em tools/module-levels.json):',
        validate: (input: string) => {
          if (!KEBAB_CASE.test(input)) return 'Use kebab-case (ex.: price-research).';
          return (
            declaredModules(plop).includes(input) ||
            'Módulo fora de DEC-040: registre-o primeiro em decisions.md e em tools/module-levels.json.'
          );
        },
      },
    ],
    actions: [
      {
        type: 'addMany',
        destination: '{{ turbo.paths.root }}/apps/api/src/modules/{{ name }}',
        base: 'templates/api-module',
        templateFiles: 'templates/api-module/**/*.hbs',
        stripExtensions: ['hbs'],
        globOptions: { dot: true },
      },
      'Módulo criado. Descreva a responsabilidade no README.md e registre {{ pascalCase name }}Module em src/modules/index.ts (API_MODULES).',
    ],
  });
}
