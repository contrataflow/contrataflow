import lint from '@commitlint/lint';
import load from '@commitlint/load';
import { beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../lib/workspace.js';

type LoadedConfig = Awaited<ReturnType<typeof load>>;

let config: LoadedConfig;

async function check(message: string) {
  const result = await lint(message, config.rules, {
    ...(config.parserPreset?.parserOpts ? { parserOpts: config.parserPreset.parserOpts } : {}),
    plugins: config.plugins,
    ...(config.ignores ? { ignores: config.ignores } : {}),
    defaultIgnores: config.defaultIgnores ?? true,
  });
  return { valid: result.valid, errors: result.errors.map((error) => error.name) };
}

describe('commitlint (RN-FND-07)', () => {
  beforeAll(async () => {
    config = await load({}, { cwd: REPO_ROOT });
  });

  it('[Validação] rejeita "ajustes diversos" por type-empty e scope-empty', async () => {
    const result = await check('ajustes diversos');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(['type-empty', 'scope-empty']));
  });

  it('[Validação] aceita "feat(api): adiciona filtro de erros" com rodapé Refs: US-080', async () => {
    const result = await check('feat(api): adiciona filtro de erros\n\nRefs: US-080');
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('exige o rodapé Refs: US-NNN', async () => {
    const result = await check('fix(process): corrige prazo da etapa');
    expect(result.errors).toEqual(['footer-story-ref']);
  });

  it('isenta atualizações de dependências do Renovate e reverts do rodapé', async () => {
    expect((await check('chore(deps): atualiza grupo lint')).valid).toBe(true);
    expect((await check('revert(api): reverte filtro de erros')).valid).toBe(true);
  });

  it('rejeita tipo e escopo fora das listas fechadas', async () => {
    const result = await check('style(financeiro): ajusta\n\nRefs: US-080');
    expect(result.errors).toEqual(expect.arrayContaining(['type-enum', 'scope-enum']));
  });

  it('aceita módulos de DEC-040 como escopo', async () => {
    const result = await check('feat(price-research): calcula mediana\n\nRefs: US-030');
    expect(result.valid).toBe(true);
  });

  it('rejeita assunto com mais de 100 caracteres ou iniciado em maiúscula', async () => {
    const long = await check(`feat(api): ${'a'.repeat(101)}\n\nRefs: US-080`);
    expect(long.errors).toContain('subject-max-length');
    const upper = await check('feat(api): Adiciona filtro\n\nRefs: US-080');
    expect(upper.errors).toContain('subject-case');
  });

  it('exige DEC/ADR em BREAKING CHANGE', async () => {
    const without = await check(
      'feat(api): remove rota antiga\n\nBREAKING CHANGE: rota /v0 removida\nRefs: US-080',
    );
    expect(without.errors).toContain('breaking-change-decision-ref');
    const withRef = await check(
      'feat(api): remove rota antiga\n\nBREAKING CHANGE: rota /v0 removida (DEC-108)\nRefs: US-080',
    );
    expect(withRef.valid).toBe(true);
  });
});
