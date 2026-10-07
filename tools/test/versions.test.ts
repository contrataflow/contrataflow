import { describe, expect, it } from 'vitest';

import {
  checkCatalogs,
  checkDuplicateMajors,
  checkManifests,
  checkRepository,
  formatViolation,
  lockfileVersions,
} from '../lib/versions.js';
import { parseWorkspaceConfig, REPO_ROOT } from '../lib/workspace.js';
import type { Manifest } from '../lib/workspace.js';

const config = parseWorkspaceConfig(`
packages:
  - apps/*
catalog:
  zod: 4.6.5
  lodash: 4.17.21
catalogs:
  react:
    react: 19.2.8
`);

const manifest = (deps: Partial<Manifest>): Manifest => ({
  path: 'apps/api/package.json',
  name: '@contrataflow/api',
  ...deps,
});

describe('check:versions — VERSION_NOT_PINNED (V-02)', () => {
  it('[Validação] reprova faixa de versão indicando o pacote e a dependência', () => {
    const violations = checkManifests([manifest({ dependencies: { lodash: '^4.17.21' } })], config);

    expect(violations).toEqual([
      {
        code: 'VERSION_NOT_PINNED',
        location: 'apps/api/package.json (@contrataflow/api) → dependencies.lodash',
        message:
          'A dependência lodash deve usar `catalog:` com versão exata. Encontrado "^4.17.21".',
      },
    ]);
    expect(violations.map(formatViolation)[0]).toContain('VERSION_NOT_PINNED');
  });

  it.each(['~4.17.21', '*', 'latest', '4.17.21', '>=4', 'npm:lodash@4.17.21'])(
    'reprova a especificação "%s" fora do catálogo',
    (spec) => {
      const violations = checkManifests([manifest({ devDependencies: { lodash: spec } })], config);
      expect(violations.map((v) => v.code)).toEqual(['VERSION_NOT_PINNED']);
    },
  );

  it('aceita catálogo padrão, catálogo nomeado e workspace:*', () => {
    const violations = checkManifests(
      [
        manifest({
          dependencies: {
            zod: 'catalog:',
            react: 'catalog:react',
            '@contrataflow/types': 'workspace:*',
          },
          peerDependencies: { lodash: 'catalog:' },
        }),
      ],
      config,
    );
    expect(violations).toEqual([]);
  });

  it('exige entrada no catálogo referenciado', () => {
    const violations = checkManifests(
      [manifest({ dependencies: { next: 'catalog:', 'react-dom': 'catalog:react' } })],
      config,
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]?.message).toContain('Não há entrada para next no catálogo "default"');
    expect(violations[1]?.message).toContain('catálogo "react"');
  });

  it('exige workspace:* para pacotes internos', () => {
    const violations = checkManifests(
      [manifest({ dependencies: { '@contrataflow/types': 'workspace:^' } })],
      config,
    );
    expect(violations[0]?.message).toBe(
      'O pacote interno @contrataflow/types deve usar "workspace:*" (encontrado "workspace:^").',
    );
  });

  it('reprova versões não exatas no próprio catálogo', () => {
    const loose = parseWorkspaceConfig(`
catalog:
  zod: ^4.6.5
catalogs:
  react:
    react: 19.x
`);
    expect(checkCatalogs(loose).map((v) => v.location)).toEqual([
      'pnpm-workspace.yaml → catálogo "default"',
      'pnpm-workspace.yaml → catálogo "react"',
    ]);
  });
});

describe('check:versions — DUPLICATE_MAJOR (V-08)', () => {
  it('[Duplicidade] reprova zod 3.x resolvido enquanto o catálogo fixa zod 4.x', () => {
    const lockfile = `
lockfileVersion: '9.0'
packages:
  zod@3.25.76:
    resolution: {integrity: sha512-x}
  '@nestjs/core@11.2.7':
    resolution: {integrity: sha512-y}
`;
    const violations = checkDuplicateMajors(lockfileVersions(lockfile), config);

    expect(violations).toEqual([
      {
        code: 'DUPLICATE_MAJOR',
        location: 'pnpm-lock.yaml → zod',
        message: 'Versões duplicadas de zod: 3.25.76, 4.6.5.',
      },
    ]);
  });

  it('aceita várias versões da mesma major', () => {
    const lockfile = `
packages:
  react@19.2.8:
    resolution: {integrity: sha512-a}
  react@19.2.7:
    resolution: {integrity: sha512-b}
`;
    expect(checkDuplicateMajors(lockfileVersions(lockfile), config)).toEqual([]);
  });

  it('lê nomes com escopo e ignora sufixos de peers', () => {
    const versions = lockfileVersions(`
packages:
  '@prisma/client@7.10.0(prisma@7.10.0)':
    resolution: {integrity: sha512-a}
  '@prisma/client@6.19.0':
    resolution: {integrity: sha512-b}
`);
    expect([...(versions.get('@prisma/client') ?? [])]).toEqual(['7.10.0', '6.19.0']);
    expect(checkDuplicateMajors(versions, config)[0]?.message).toBe(
      'Versões duplicadas de @prisma/client: 6.19.0, 7.10.0.',
    );
  });

  it('trata lockfile sem pacotes', () => {
    expect(lockfileVersions('lockfileVersion: 9.0').size).toBe(0);
  });
});

describe('repositório real', () => {
  it('não tem dependências fora do catálogo nem majors duplicadas', () => {
    expect(checkRepository(REPO_ROOT).map(formatViolation)).toEqual([]);
  });
});
