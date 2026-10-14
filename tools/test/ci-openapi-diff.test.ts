// US-079 — estágio "Contrato" (RN-FND-23 · V-05 · DEC-108): mudança aditiva passa, incompatível
// bloqueia. Documentos mínimos no formato do zod-to-openapi (OpenAPI 3.1, schemas em components).
import { describe, expect, it } from 'vitest';

import { breakingMessage, diffOpenApi } from '../ci/lib/openapi-diff.js';
import type { ContractChange, OpenApiDocument } from '../ci/lib/openapi-diff.js';

type Json = Record<string, unknown>;

const processSchema = (extra: Json = {}, required = ['id', 'title', 'status']): Json => ({
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: ['DRAFT', 'IN_PROGRESS'] },
    ...extra,
  },
  required,
});

const createBody = (extra: Json = {}, required = ['title']): Json => ({
  type: 'object',
  properties: { title: { type: 'string', maxLength: 200 }, ...extra },
  required,
});

function doc(
  overrides: {
    process?: Json;
    body?: Json;
    getParams?: unknown[];
    listParams?: unknown[];
    responses?: Json;
    security?: unknown[];
    extraPaths?: Json;
    removeGet?: boolean;
  } = {},
): OpenApiDocument {
  const get: Json = {
    parameters: overrides.getParams ?? [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ],
    responses: overrides.responses ?? {
      '200': {
        description: 'ok',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Process' } } },
      },
      '404': { description: 'não encontrado' },
    },
  };
  return {
    openapi: '3.1.0',
    security: overrides.security ?? [{ bearer: [] }],
    paths: {
      '/processes': {
        get: {
          parameters: overrides.listParams ?? [
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'ok' } },
        },
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateProcess' } },
            },
          },
          responses: { '201': { description: 'criado' } },
        },
      },
      '/processes/{id}': overrides.removeGet ? {} : { get },
      ...overrides.extraPaths,
    },
    components: {
      schemas: {
        Process: overrides.process ?? processSchema(),
        CreateProcess: overrides.body ?? createBody(),
      },
    },
  };
}

const levels = (changes: readonly ContractChange[], level: ContractChange['level']) =>
  changes.filter((change) => change.level === level).map((change) => change.detail);

describe('diffOpenApi — mudanças aditivas passam (DEC-108)', () => {
  it('contrato idêntico não tem mudança', () => {
    expect(diffOpenApi(doc(), doc())).toEqual([]);
  });

  it('operação nova, parâmetro opcional, resposta nova e propriedade nova são aditivas', () => {
    const head = doc({
      extraPaths: { '/processes/{id}/forward': { post: { responses: { '200': {} } } } },
      listParams: [
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string' } },
      ],
      process: processSchema({ priority: { type: 'string' } }),
      body: createBody({ notes: { type: 'string' } }),
      responses: {
        '200': {
          description: 'ok',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Process' } } },
        },
        '404': {},
        '409': { description: 'conflito' },
      },
    });
    const changes = diffOpenApi(doc(), head);
    expect(levels(changes, 'breaking')).toEqual([]);
    expect(levels(changes, 'additive')).toEqual(
      expect.arrayContaining([
        'operação nova',
        'parâmetro novo: query.status',
        'resposta 200.priority: propriedade nova',
        'notes: propriedade nova',
        'resposta 409 nova',
      ]),
    );
  });

  it('alargar a requisição (enum com valor novo, limite maior, integer → number) é aditivo', () => {
    const base = doc({
      body: createBody({
        kind: { type: 'string', enum: ['A'] },
        amount: { type: 'integer', maximum: 10 },
      }),
    });
    const head = doc({
      body: createBody({
        kind: { type: 'string', enum: ['A', 'B'] },
        amount: { type: 'number', maximum: 100 },
      }),
    });
    expect(levels(diffOpenApi(base, head), 'breaking')).toEqual([]);
  });

  it('renomear o parâmetro de caminho ({id} → {processId}) não muda a rota', () => {
    const head = doc();
    const paths = head.paths as Json;
    const item = paths['/processes/{id}'] as { get: { parameters: { name: string }[] } };
    const [param] = item.get.parameters;
    if (param) param.name = 'processId';
    delete paths['/processes/{id}'];
    paths['/processes/{processId}'] = item;
    expect(levels(diffOpenApi(doc(), head), 'breaking')).toEqual([]);
  });

  it('remover autenticação e depreciar uma operação não quebram (depreciação é aviso)', () => {
    const head = doc({ security: [] });
    (((head.paths as Json)['/processes'] as Json).get as Json).deprecated = true;
    const changes = diffOpenApi(doc(), head);
    expect(levels(changes, 'breaking')).toEqual([]);
    expect(levels(changes, 'warning')).toContain('operação depreciada');
  });
});

describe('diffOpenApi — mudanças incompatíveis bloqueiam (OPENAPI_BREAKING_CHANGE)', () => {
  it.each<[string, Parameters<typeof doc>[0], string, Parameters<typeof doc>[0]?]>([
    ['operação removida', { removeGet: true }, 'operação removida'],
    [
      'parâmetro obrigatório novo',
      {
        listParams: [
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'unit', in: 'query', required: true, schema: { type: 'string' } },
        ],
      },
      'parâmetro obrigatório novo: query.unit',
    ],
    ['parâmetro removido', { listParams: [] }, 'parâmetro removido: query.cursor'],
    [
      'parâmetro passou a ser obrigatório',
      { listParams: [{ name: 'cursor', in: 'query', required: true, schema: { type: 'string' } }] },
      'parâmetro passou a ser obrigatório: query.cursor',
    ],
    [
      'propriedade obrigatória nova no corpo',
      { body: createBody({ unitId: { type: 'string' } }, ['title', 'unitId']) },
      'unitId: propriedade obrigatória nova',
    ],
    [
      'propriedade do corpo passou a ser obrigatória',
      { body: createBody({ notes: { type: 'string' } }, ['title', 'notes']) },
      'notes: passou a ser obrigatória',
      { body: createBody({ notes: { type: 'string' } }) },
    ],
    [
      'limite mais restrito na requisição',
      { body: createBody({ title: { type: 'string', maxLength: 100 } }) },
      'title: maxLength mais restrito (200 → 100)',
    ],
    [
      'tipo trocado na requisição',
      { body: createBody({ title: { type: 'integer' } }) },
      'title: deixou de aceitar o tipo string',
    ],
    [
      'propriedade removida da resposta',
      { process: processSchema({}, ['id', 'status']) },
      'resposta 200.title: deixou de ser garantida na resposta',
    ],
    [
      'tipo novo na resposta (nullable)',
      { process: processSchema({ title: { type: ['string', 'null'] } }) },
      'resposta 200.title: pode responder com o tipo novo null',
    ],
    ['status de sucesso removido', { responses: { '404': {} } }, 'resposta 200 removida'],
    ['passou a exigir autenticação', { security: [{ bearer: [] }, { apiKey: [] }] }, ''],
  ])('%s', (_name, overrides, detail, baseOverrides) => {
    const base = detail === '' ? doc({ security: [] }) : doc(baseOverrides);
    const head = doc(overrides);
    const breaking = levels(diffOpenApi(base, head), 'breaking');
    expect(breaking).toContain(detail === '' ? 'passou a exigir autenticação' : detail);
  });

  it('propriedade removida da resposta é incompatível; da requisição só se o schema for estrito', () => {
    const base = doc({
      process: processSchema({ notes: { type: 'string' } }),
      body: createBody({ notes: { type: 'string' } }),
    });
    const lenient = diffOpenApi(base, doc());
    expect(levels(lenient, 'breaking')).toContain('resposta 200.notes: propriedade removida');
    expect(levels(lenient, 'warning')).toContain('notes: propriedade removida');
    const strict = diffOpenApi(
      base,
      doc({ body: { ...createBody(), additionalProperties: false } }),
    );
    expect(levels(strict, 'breaking')).toEqual(
      expect.arrayContaining([
        'notes: propriedade removida',
        'corpo: deixou de aceitar propriedades adicionais',
      ]),
    );
  });

  it('valor novo no enum da resposta é aviso; valor removido do enum da requisição quebra', () => {
    const base = doc({ body: createBody({ kind: { type: 'string', enum: ['A', 'B'] } }) });
    const head = doc({
      process: processSchema({
        status: { type: 'string', enum: ['DRAFT', 'IN_PROGRESS', 'DONE'] },
      }),
      body: createBody({ kind: { type: 'string', enum: ['A'] } }),
    });
    const changes = diffOpenApi(base, head);
    expect(levels(changes, 'warning')).toContain(
      'resposta 200.status: valor novo no enum da resposta ("DONE")',
    );
    expect(levels(changes, 'breaking')).toContain('kind: enum restringido ("B")');
  });

  it('segue $ref e allOf, e não entra em laço com schemas recursivos', () => {
    const tree = (required: string[]): Json => ({
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/components/schemas/Process' } },
          },
          required,
        },
      ],
    });
    const changes = diffOpenApi(doc({ process: tree(['name']) }), doc({ process: tree([]) }));
    expect(levels(changes, 'breaking')).toContain(
      'resposta 200.name: deixou de ser garantida na resposta',
    );
  });

  it('a mensagem segue a V-05', () => {
    expect(breakingMessage('GET /processes/{id}')).toBe(
      'Mudança incompatível em GET /processes/{id}. Use /api/v2 ou torne aditiva.',
    );
  });
});
