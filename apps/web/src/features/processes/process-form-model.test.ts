import { createProcessSchema } from '@contrataflow/validation';
import type { DepartmentDto, PermissionScopeDto } from '@contrataflow/validation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatMoneyText,
  isDecimalMoney,
  normalizeMoneyText,
  parseMoneyText,
  toDecimalMoney,
} from './money';
import {
  buildCreateBody,
  buildDuplicateCheckBody,
  buildResolveBody,
  clearDraft,
  completeValues,
  coversDepartment,
  draftStorageKey,
  firstInvalidStep,
  hasUserContent,
  initialValues,
  loadDraft,
  localToday,
  parseDraft,
  prefillFromLotation,
  saveDraft,
  sectorOptions,
  secretariatOptions,
  stepOfField,
  validateStep,
  validationContext,
} from './process-form-model';
import type { ProcessFormValues, ScopeContext } from './process-form-model';

const NOW = new Date(2026, 9, 16, 10, 0, 0);
const YEAR = 2026;
const CONTEXT = validationContext(false, NOW);

const ID = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function valid(overrides: Partial<ProcessFormValues> = {}): ProcessFormValues {
  return {
    ...initialValues(YEAR),
    title: 'Aquisição de cimento para manutenção de vias',
    object: 'Aquisição de cimento Portland para a manutenção das vias do município.',
    contractingTypeId: ID(1),
    organizationId: ID(2),
    requestingSecretariatId: ID(3),
    requestingDepartmentId: ID(4),
    originId: ID(5),
    pcaStatus: 'NOT_APPLICABLE',
    ...overrides,
  };
}

describe('initialValues', () => {
  it('prioridade MEDIUM e exercício do PCA = ano corrente', () => {
    const values = initialValues(2026);
    expect(values.priority).toBe('MEDIUM');
    expect(values.pcaYear).toBe('2026');
    expect(values.pcaStatus).toBe('');
    expect(hasUserContent(values)).toBe(false);
  });

  it('localToday usa a data local no formato AAAA-MM-DD', () => {
    expect(localToday(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('validação do passo 1 · Identificação', () => {
  it('sem título: "Informe o título." (V-01) e demais obrigatórios do passo', () => {
    const messages = validateStep('identification', initialValues(YEAR), CONTEXT);
    expect(messages).toEqual({
      title: 'Informe o título.',
      object: 'Informe o objeto.',
      contractingTypeId: 'Informe o tipo de contratação.',
    });
  });

  it('limites de tamanho (V-02)', () => {
    const messages = validateStep(
      'identification',
      valid({ title: 'abc', object: 'curto', description: 'x'.repeat(10_001) }),
      CONTEXT,
    );
    expect(messages.title).toBe('O título deve ter entre 5 e 200 caracteres.');
    expect(messages.object).toBe('O objeto deve ter entre 10 e 2000 caracteres.');
    expect(messages.description).toBe('A descrição deve ter no máximo 10.000 caracteres.');
  });

  it('espaços não contam: título só com espaços equivale a vazio', () => {
    expect(validateStep('identification', valid({ title: '     ' }), CONTEXT).title).toBe(
      'Informe o título.',
    );
  });

  it('dados válidos → sem mensagens; modalidade vazia = "A definir"', () => {
    expect(validateStep('identification', valid({ modalityId: '' }), CONTEXT)).toEqual({});
  });
});

describe('validação do passo 2 · Origem e planejamento', () => {
  it('obrigatórios do passo', () => {
    const messages = validateStep('origin', initialValues(YEAR), CONTEXT);
    expect(messages).toEqual({
      requestingSecretariatId: 'Informe a secretaria solicitante.',
      requestingDepartmentId: 'Informe o setor solicitante.',
      originId: 'Informe a origem.',
      pcaStatus: 'Informe a situação no PCA.',
    });
  });

  it('PCA NOT_PLANNED exige justificativa com ao menos 20 caracteres (V-09)', () => {
    const message =
      'Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres).';
    expect(validateStep('origin', valid({ pcaStatus: 'NOT_PLANNED' }), CONTEXT)).toEqual({
      pcaJustification: message,
    });
    expect(
      validateStep(
        'origin',
        valid({ pcaStatus: 'NOT_PLANNED', pcaJustification: 'curta demais' }),
        CONTEXT,
      ),
    ).toEqual({ pcaJustification: message });
    expect(
      validateStep(
        'origin',
        valid({
          pcaStatus: 'NOT_PLANNED',
          pcaJustification: 'Demanda surgida após a aprovação do plano.',
        }),
        CONTEXT,
      ),
    ).toEqual({});
  });

  it('PCA PLANNED exige o exercício (ano corrente ou seguinte)', () => {
    expect(
      validateStep('origin', valid({ pcaStatus: 'PLANNED', pcaYear: '' }), CONTEXT).pcaYear,
    ).toBe('Informe o exercício do PCA.');
    expect(
      validateStep('origin', valid({ pcaStatus: 'PLANNED', pcaYear: '2030' }), CONTEXT).pcaYear,
    ).toBe('O exercício do PCA deve ser o ano corrente ou o seguinte.');
    expect(
      validateStep('origin', valid({ pcaStatus: 'PLANNED', pcaYear: '2027' }), CONTEXT),
    ).toEqual({});
    expect(validateStep('origin', valid({ pcaStatus: 'PLANNED' }), CONTEXT)).toEqual({});
  });

  it('PCA NOT_APPLICABLE ignora exercício e justificativa', () => {
    expect(
      validateStep(
        'origin',
        valid({ pcaStatus: 'NOT_APPLICABLE', pcaYear: '1900', pcaJustification: 'x' }),
        CONTEXT,
      ),
    ).toEqual({});
  });

  it('prazo alvo não pode ser anterior a hoje (V-07), mas hoje vale', () => {
    expect(validateStep('origin', valid({ targetDate: '2026-10-15' }), CONTEXT).targetDate).toBe(
      'O prazo alvo não pode ser anterior a hoje.',
    );
    expect(validateStep('origin', valid({ targetDate: '2026-10-16' }), CONTEXT)).toEqual({});
    expect(validateStep('origin', valid({ targetDate: '2027-01-31' }), CONTEXT)).toEqual({});
  });

  it('valor estimado: negativo ou com mais de 2 casas é inválido (V-08)', () => {
    const message = 'Informe um valor válido, com até 2 casas decimais.';
    for (const text of ['abc', '-5', '10,555', '1,2,3']) {
      expect(validateStep('origin', valid({ estimatedValue: text }), CONTEXT).estimatedValue).toBe(
        message,
      );
    }
    for (const text of ['', '0', '15.000,50', '15000,5', 'R$ 1.234,00', '15000.50']) {
      expect(validateStep('origin', valid({ estimatedValue: text }), CONTEXT)).toEqual({});
    }
  });
});

describe('validação do passo 3 · Revisão', () => {
  it('código interno é opcional por padrão e obrigatório com process.requireInternalCode (FA-09)', () => {
    expect(validateStep('review', valid(), CONTEXT)).toEqual({});
    const strict = validationContext(true, NOW);
    expect(validateStep('review', valid(), strict)).toEqual({
      internalCode: 'Informe o código interno.',
    });
    expect(validateStep('review', valid({ internalCode: 'PROT-2026-0457' }), strict)).toEqual({});
  });

  it('código interno e observações têm limite de tamanho', () => {
    const messages = validateStep(
      'review',
      valid({ internalCode: 'x'.repeat(61), notes: 'y'.repeat(5001) }),
      CONTEXT,
    );
    expect(messages.internalCode).toBe('O código interno deve ter no máximo 60 caracteres.');
    expect(messages.notes).toBe('As observações devem ter no máximo 5.000 caracteres.');
  });
});

describe('firstInvalidStep e stepOfField', () => {
  it('acha o primeiro passo com erro', () => {
    expect(firstInvalidStep(valid(), CONTEXT)).toBeNull();
    expect(firstInvalidStep(valid({ title: '' }), CONTEXT)).toBe('identification');
    expect(firstInvalidStep(valid({ originId: '' }), CONTEXT)).toBe('origin');
    expect(firstInvalidStep(valid({ internalCode: 'x'.repeat(61) }), CONTEXT)).toBe('review');
  });

  it('associa o campo ao passo (usado para voltar ao passo certo após um 422)', () => {
    expect(stepOfField('title')).toBe('identification');
    expect(stepOfField('requestingDepartmentId')).toBe('origin');
    expect(stepOfField('internalCode')).toBe('review');
    expect(stepOfField('inexistente')).toBeNull();
  });
});

describe('corpo enviado (PRC-02)', () => {
  it('só obrigatórios: campos vazios ficam de fora e o corpo passa no schema da API', () => {
    const body = buildCreateBody(valid());
    expect(body).toEqual({
      title: 'Aquisição de cimento para manutenção de vias',
      object: 'Aquisição de cimento Portland para a manutenção das vias do município.',
      contractingTypeId: ID(1),
      isPriceRegistration: false,
      organizationId: ID(2),
      requestingSecretariatId: ID(3),
      requestingDepartmentId: ID(4),
      priority: 'MEDIUM',
      originId: ID(5),
      pcaStatus: 'NOT_APPLICABLE',
    });
    expect(createProcessSchema.safeParse(body).success).toBe(true);
  });

  it('valor estimado vai como string decimal com ponto e 2 casas', () => {
    expect(buildCreateBody(valid({ estimatedValue: '15.000,5' })).estimatedValue).toBe('15000.50');
    expect(buildCreateBody(valid({ estimatedValue: '' }))).not.toHaveProperty('estimatedValue');
  });

  it('campos do PCA só seguem a situação escolhida (RN-PROC-12)', () => {
    const planned = buildCreateBody(
      valid({
        pcaStatus: 'PLANNED',
        pcaYear: '2027',
        pcaItemCode: ' ITEM-9 ',
        pcaJustification: 'ignorada',
      }),
    );
    expect(planned).toMatchObject({ pcaStatus: 'PLANNED', pcaYear: 2027, pcaItemCode: 'ITEM-9' });
    expect(planned).not.toHaveProperty('pcaJustification');

    const notPlanned = buildCreateBody(
      valid({
        pcaStatus: 'NOT_PLANNED',
        pcaYear: '2026',
        pcaJustification: '  Demanda surgida após a aprovação do plano.  ',
      }),
    );
    expect(notPlanned).toMatchObject({
      pcaJustification: 'Demanda surgida após a aprovação do plano.',
    });
    expect(notPlanned).not.toHaveProperty('pcaYear');
    expect(createProcessSchema.safeParse(notPlanned).success).toBe(true);
  });

  it('confirmDuplicate só vai quando confirmado; opcionais preenchidos seguem aparados', () => {
    expect(buildCreateBody(valid())).not.toHaveProperty('confirmDuplicate');
    const body = buildCreateBody(
      valid({
        description: '  contexto  ',
        modalityId: ID(9),
        isPriceRegistration: true,
        targetDate: '2026-12-31',
        internalCode: ' PROT-1 ',
        notes: ' nota ',
      }),
      { confirmDuplicate: true },
    );
    expect(body).toMatchObject({
      description: 'contexto',
      modalityId: ID(9),
      isPriceRegistration: true,
      targetDate: '2026-12-31',
      internalCode: 'PROT-1',
      notes: 'nota',
      confirmDuplicate: true,
    });
    expect(createProcessSchema.safeParse(body).success).toBe(true);
  });

  it('corpos de PRC-03 e WF-06', () => {
    const values = valid({
      modalityId: ID(9),
      estimatedValue: '1.000,00',
      isPriceRegistration: true,
    });
    expect(buildDuplicateCheckBody(values)).toEqual({
      title: values.title,
      object: values.object,
      requestingDepartmentId: ID(4),
    });
    expect(buildResolveBody(values)).toEqual({
      contractingTypeId: ID(1),
      modalityId: ID(9),
      originId: ID(5),
      estimatedValue: '1000.00',
      organizationId: ID(2),
      isPriceRegistration: true,
    });
    expect(buildResolveBody(valid())).not.toHaveProperty('modalityId');
    expect(buildResolveBody(valid())).not.toHaveProperty('estimatedValue');
  });

  it('completeValues completa o que o useWatch não trouxe', () => {
    expect(completeValues({ title: 'x', isPriceRegistration: 'sim' }, YEAR)).toEqual({
      ...initialValues(YEAR),
      title: 'x',
    });
  });
});

describe('valor em reais (money)', () => {
  it.each([
    ['15.000,50', '15000.50'],
    ['15000,5', '15000.50'],
    ['1.234', '1234.00'],
    ['15000.50', '15000.50'],
    ['R$ 2.500,00', '2500.00'],
    ['0,99', '0.99'],
    ['0', '0.00'],
  ])('"%s" → "%s"', (text, decimal) => {
    expect(toDecimalMoney(text)).toBe(decimal);
  });

  it.each(['', 'abc', '-1', '1,234', '1,2,3', '10,555'])('"%s" é inválido', (text) => {
    expect(toDecimalMoney(text)).toBeNull();
  });

  it('parseMoneyText: vazio é ausente; lixo passa limpo para o schema reprovar', () => {
    expect(parseMoneyText('   ')).toBeUndefined();
    expect(parseMoneyText('abc')).toBe('abc');
    expect(isDecimalMoney('10.5')).toBe(true);
    expect(isDecimalMoney('10.555')).toBe(false);
  });

  it('formata e normaliza para o padrão brasileiro com 2 casas', () => {
    expect(formatMoneyText('1234567.5')).toBe('1.234.567,50');
    expect(normalizeMoneyText('15000,5')).toBe('15.000,50');
    expect(normalizeMoneyText(' abc ')).toBe('abc');
  });
});

describe('secretaria, setor e escopo (RN-PROC-02/03 · FA-05 · FA-08)', () => {
  function unit(
    id: number,
    name: string,
    parent: DepartmentDto | null,
    extra: Partial<DepartmentDto> = {},
  ): DepartmentDto {
    return {
      id: ID(id),
      organizationId: ID(100),
      parentId: parent?.id ?? null,
      type: parent ? 'SECTOR' : 'SECRETARIAT',
      name,
      acronym: null,
      code: null,
      email: null,
      phone: null,
      headUserId: null,
      deputyUserId: null,
      isActive: true,
      isSecretariat: parent === null,
      sortOrder: 0,
      path: `${parent?.path ?? '/'}${ID(id)}/`,
      depth: parent ? parent.depth + 1 : 0,
      createdAt: '2026-10-15T12:00:00.000Z',
      updatedAt: '2026-10-15T12:00:00.000Z',
      version: 1,
      ...extra,
    };
  }
  const obras = unit(10, 'Secretaria de Obras', null);
  const manutencao = unit(11, 'Setor de Manutenção', obras);
  const projetos = unit(12, 'Departamento de Projetos', obras, { type: 'DEPARTMENT' });
  const topografia = unit(13, 'Setor de Topografia', projetos);
  const saude = unit(20, 'Secretaria de Saúde', null);
  const farmacia = unit(21, 'Setor de Farmácia', saude);
  const inativa = unit(30, 'Secretaria Extinta', null, { isActive: false });
  const all = [obras, manutencao, projetos, topografia, saude, farmacia, inativa];
  const everything: ScopeContext = {
    scopes: [{ type: 'TENANT', includeSubtree: false }],
    ownDepartmentIds: [],
    departments: all,
  };

  it('secretarias: raízes e tipos SECRETARIAT/BOARD ativos do órgão', () => {
    expect(secretariatOptions(all, ID(100), everything).map((u) => u.name)).toEqual([
      'Secretaria de Obras',
      'Secretaria de Saúde',
    ]);
    expect(secretariatOptions(all, ID(999), everything)).toEqual([]);
  });

  it('setores: a própria secretaria e a subárvore dela, com nível de indentação', () => {
    const options = sectorOptions(all, obras, everything);
    expect(options.map((o) => [o.department.name, o.level])).toEqual([
      ['Secretaria de Obras', 0],
      ['Setor de Manutenção', 1],
      ['Departamento de Projetos', 1],
      ['Setor de Topografia', 2],
    ]);
    expect(sectorOptions(all, undefined, everything)).toEqual([]);
  });

  function scopeOf(scopes: PermissionScopeDto[], own: string[] | null): ScopeContext {
    return { scopes, ownDepartmentIds: own, departments: all };
  }

  it('escopo OWN_DEPARTMENTS: só as lotações; lotações destacadas no topo (FA-05)', () => {
    const scope = scopeOf([{ type: 'OWN_DEPARTMENTS', includeSubtree: false }], [manutencao.id]);
    expect(coversDepartment(manutencao, scope)).toBe(true);
    expect(coversDepartment(obras, scope)).toBe(false);
    expect(secretariatOptions(all, ID(100), scope).map((u) => u.name)).toEqual([
      'Secretaria de Obras',
    ]);
    const options = sectorOptions(all, obras, scope);
    expect(options.map((o) => [o.department.name, o.own])).toEqual([['Setor de Manutenção', true]]);
  });

  it('OWN_DEPARTMENTS com subárvore inclui os descendentes da lotação', () => {
    const scope = scopeOf([{ type: 'OWN_DEPARTMENTS', includeSubtree: true }], [projetos.id]);
    expect(coversDepartment(topografia, scope)).toBe(true);
    expect(coversDepartment(manutencao, scope)).toBe(false);
  });

  it('escopos DEPARTMENT e ORGANIZATION; lotações desconhecidas não filtram', () => {
    const department = scopeOf(
      [{ type: 'DEPARTMENT', departmentId: saude.id, includeSubtree: true }],
      null,
    );
    expect(coversDepartment(farmacia, department)).toBe(true);
    expect(coversDepartment(manutencao, department)).toBe(false);
    const organization = scopeOf(
      [{ type: 'ORGANIZATION', organizationId: ID(100), includeSubtree: false }],
      null,
    );
    expect(coversDepartment(manutencao, organization)).toBe(true);
    const otherOrganization = scopeOf(
      [{ type: 'ORGANIZATION', organizationId: ID(101), includeSubtree: false }],
      null,
    );
    expect(coversDepartment(manutencao, otherOrganization)).toBe(false);
    expect(
      coversDepartment(
        manutencao,
        scopeOf([{ type: 'OWN_DEPARTMENTS', includeSubtree: false }], null),
      ),
    ).toBe(true);
    expect(coversDepartment(manutencao, scopeOf([], []))).toBe(true);
  });

  it('pré-preenche secretaria e setor pela lotação principal (a secretaria mais próxima)', () => {
    expect(
      prefillFromLotation(all, ID(100), [{ id: topografia.id, isPrimary: true }], everything),
    ).toEqual({ secretariatId: obras.id, departmentId: topografia.id });
    // A principal vence a ordem recebida.
    expect(
      prefillFromLotation(
        all,
        ID(100),
        [
          { id: farmacia.id, isPrimary: false },
          { id: manutencao.id, isPrimary: true },
        ],
        everything,
      ),
    ).toEqual({ secretariatId: obras.id, departmentId: manutencao.id });
  });

  it('sem a principal informada (ME-03): pré-preenche só com UMA lotação elegível', () => {
    expect(
      prefillFromLotation(all, ID(100), [{ id: manutencao.id, isPrimary: false }], everything),
    ).toEqual({ secretariatId: obras.id, departmentId: manutencao.id });
    expect(
      prefillFromLotation(
        all,
        ID(100),
        [
          { id: farmacia.id, isPrimary: false },
          { id: manutencao.id, isPrimary: false },
        ],
        everything,
      ),
    ).toBeNull();
    // A inativa não conta: sobra uma elegível.
    expect(
      prefillFromLotation(
        all,
        ID(100),
        [
          { id: inativa.id, isPrimary: false },
          { id: manutencao.id, isPrimary: false },
        ],
        everything,
      ),
    ).toEqual({ secretariatId: obras.id, departmentId: manutencao.id });
  });

  it('sem lotação utilizável (inativa, fora do órgão ou sem cobertura) não pré-preenche', () => {
    expect(prefillFromLotation(all, ID(100), [], everything)).toBeNull();
    expect(
      prefillFromLotation(all, ID(100), [{ id: inativa.id, isPrimary: true }], everything),
    ).toBeNull();
    expect(
      prefillFromLotation(all, ID(999), [{ id: manutencao.id, isPrimary: true }], everything),
    ).toBeNull();
    const onlyHealth = scopeOf(
      [{ type: 'DEPARTMENT', departmentId: saude.id, includeSubtree: true }],
      null,
    );
    expect(
      prefillFromLotation(all, ID(100), [{ id: manutencao.id, isPrimary: true }], onlyHealth),
    ).toBeNull();
  });
});

describe('rascunho local (FA-01)', () => {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('chave por instituição + usuário', () => {
    expect(draftStorageKey('t1', 'u1')).toBe('cf:t1:u1:process-draft');
  });

  it('grava, recupera e limpa', () => {
    vi.stubGlobal('sessionStorage', fakeStorage);
    const key = draftStorageKey('t1', 'u1');
    expect(loadDraft(key, YEAR)).toBeNull();
    saveDraft(key, { version: 1, step: 'origin', values: valid({ title: 'Meu título' }) });
    const draft = loadDraft(key, YEAR);
    expect(draft?.step).toBe('origin');
    expect(draft?.values.title).toBe('Meu título');
    clearDraft(key);
    expect(loadDraft(key, YEAR)).toBeNull();
  });

  it('ignora JSON inválido, versão desconhecida e passo inexistente', () => {
    expect(parseDraft('{', YEAR)).toBeNull();
    expect(parseDraft(null, YEAR)).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 2, step: 'origin', values: {} }), YEAR)).toBeNull();
    expect(parseDraft(JSON.stringify({ version: 1, step: 'x', values: {} }), YEAR)).toBeNull();
  });

  it('descarta campos com tipo errado e valores de enum inválidos', () => {
    const draft = parseDraft(
      JSON.stringify({
        version: 1,
        step: 'identification',
        values: { title: 42, object: 'Objeto do processo', priority: 'ALTISSIMA', pcaStatus: 'X' },
      }),
      YEAR,
    );
    expect(draft?.values.title).toBe('');
    expect(draft?.values.object).toBe('Objeto do processo');
    expect(draft?.values.priority).toBe('MEDIUM');
    expect(draft?.values.pcaStatus).toBe('');
  });

  it('sem sessionStorage disponível nada quebra', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
      removeItem: () => {
        throw new Error('bloqueado');
      },
    });
    const key = draftStorageKey('t1', 'u1');
    expect(loadDraft(key, YEAR)).toBeNull();
    expect(() => {
      saveDraft(key, { version: 1, step: 'identification', values: valid() });
      clearDraft(key);
    }).not.toThrow();
  });
});

describe('hasUserContent', () => {
  it('pré-preenchimentos não contam; texto, escolhas e SRP contam', () => {
    expect(
      hasUserContent(
        valid({ title: '', object: '', contractingTypeId: '', originId: '', pcaStatus: '' }),
      ),
    ).toBe(false);
    expect(hasUserContent({ ...initialValues(YEAR), title: 'x' })).toBe(true);
    expect(hasUserContent({ ...initialValues(YEAR), isPriceRegistration: true })).toBe(true);
    expect(hasUserContent({ ...initialValues(YEAR), pcaStatus: 'PLANNED' })).toBe(true);
  });
});
