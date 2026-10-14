// Diff de contrato do estágio "Contrato" (US-079 — RN-FND-23 · DEC-108 · ADR-010): compara o
// OpenAPI versionado (`openapi/api.v1.json` da base) com o gerado no PR e classifica cada mudança.
// Na v1 só mudanças aditivas passam; qualquer mudança incompatível bloqueia o merge.
//
// Direção: na REQUISIÇÃO o servidor não pode passar a exigir mais (parâmetro/propriedade
// obrigatória nova, tipo ou enum mais restrito, limite mais apertado); na RESPOSTA o servidor não
// pode deixar de entregar o que prometeu (propriedade removida ou opcional, tipo novo, status de
// sucesso removido). Valor novo em enum de resposta é "atenção": não bloqueia, mas é reportado.

export type ChangeLevel = 'breaking' | 'warning' | 'additive';

export interface ContractChange {
  readonly level: ChangeLevel;
  /** `MÉTODO /caminho` da operação afetada. */
  readonly route: string;
  readonly detail: string;
}

type Json = Record<string, unknown>;
export type OpenApiDocument = Json;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Segue `$ref` locais (`#/components/...`) até um objeto concreto. */
function resolve(doc: Json, value: unknown, depth = 0): Json {
  const node = record(value);
  const ref = node.$ref;
  if (typeof ref !== 'string' || depth > 32) return node;
  if (!ref.startsWith('#/')) return node;
  let target: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    target = record(target)[key];
  }
  return resolve(doc, target, depth + 1);
}

/** Caminho com os parâmetros anonimizados: renomear `{id}` não é mudança de rota. */
function routeKey(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}');
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

interface Operation {
  readonly route: string;
  readonly path: string;
  readonly op: Json;
  readonly pathItem: Json;
}

function operations(doc: Json): Map<string, Operation> {
  const result = new Map<string, Operation>();
  for (const [path, rawItem] of Object.entries(record(doc.paths))) {
    const pathItem = resolve(doc, rawItem);
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!isRecord(op)) continue;
      result.set(`${method.toUpperCase()} ${routeKey(path)}`, {
        route: `${method.toUpperCase()} ${path}`,
        path,
        op,
        pathItem,
      });
    }
  }
  return result;
}

interface Parameter {
  readonly label: string;
  readonly required: boolean;
  readonly schema: unknown;
}

/** Parâmetros efetivos (do caminho + da operação); os de caminho são casados por posição. */
function parameters(doc: Json, operation: Operation): Map<string, Parameter> {
  const result = new Map<string, Parameter>();
  const positions = pathParamNames(operation.path);
  const all = [...array(operation.pathItem.parameters), ...array(operation.op.parameters)];
  for (const raw of all) {
    const param = resolve(doc, raw);
    const name = typeof param.name === 'string' ? param.name : '';
    const location = typeof param.in === 'string' ? param.in : 'query';
    const key =
      location === 'path'
        ? `path:${positions.indexOf(name)}`
        : `${location}:${location === 'header' ? name.toLowerCase() : name}`;
    result.set(key, {
      label: `${location}.${name}`,
      required: location === 'path' || param.required === true,
      schema: param.schema,
    });
  }
  return result;
}

type Direction = 'request' | 'response';

interface Context {
  readonly base: Json;
  readonly head: Json;
  readonly route: string;
  readonly emit: (level: ChangeLevel, detail: string) => void;
  readonly seen: Set<string>;
}

function types(schema: Json): Set<string> {
  const raw = schema.type;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  if (schema.nullable === true) list.push('null');
  return new Set(list);
}

/** `number` aceita todo `integer`: trocar `integer` por `number` alarga, não restringe. */
function covers(set: ReadonlySet<string>, type: string): boolean {
  return set.has(type) || (type === 'integer' && set.has('number'));
}

/** `allOf` vira um único objeto (propriedades e obrigatórios somados). */
function flatten(doc: Json, value: unknown): Json {
  const schema = resolve(doc, value);
  const parts = array(schema.allOf);
  if (parts.length === 0) return schema;
  const properties: Json = { ...record(schema.properties) };
  const required = new Set(array(schema.required).map(String));
  let type: unknown = schema.type;
  for (const part of parts) {
    const flat = flatten(doc, part);
    Object.assign(properties, record(flat.properties));
    for (const name of array(flat.required)) required.add(String(name));
    type ??= flat.type;
  }
  const { allOf: _allOf, ...rest } = schema;
  return {
    ...rest,
    ...(type === undefined ? {} : { type }),
    properties,
    required: [...required],
  };
}

const NARROWING: readonly { key: string; tighter: (base: number, head: number) => boolean }[] = [
  { key: 'minLength', tighter: (base, head) => head > base },
  { key: 'maxLength', tighter: (base, head) => head < base },
  { key: 'minimum', tighter: (base, head) => head > base },
  { key: 'maximum', tighter: (base, head) => head < base },
  { key: 'exclusiveMinimum', tighter: (base, head) => head > base },
  { key: 'exclusiveMaximum', tighter: (base, head) => head < base },
  { key: 'minItems', tighter: (base, head) => head > base },
  { key: 'maxItems', tighter: (base, head) => head < base },
];

function compareSchema(
  context: Context,
  baseRaw: unknown,
  headRaw: unknown,
  direction: Direction,
  where: string,
): void {
  const baseRef = record(baseRaw).$ref;
  const headRef = record(headRaw).$ref;
  if (typeof baseRef === 'string' && typeof headRef === 'string') {
    // O mesmo par de schemas só é comparado uma vez (schemas recursivos não entram em laço).
    const key = `${baseRef}|${headRef}|${direction}`;
    if (context.seen.has(key)) return;
    context.seen.add(key);
  }
  const base = flatten(context.base, baseRaw);
  const head = flatten(context.head, headRaw);
  const label = where === '' ? 'corpo' : where;

  // Tipos
  const baseTypes = types(base);
  const headTypes = types(head);
  if (baseTypes.size > 0 && headTypes.size > 0) {
    const removed = [...baseTypes].filter((type) => !covers(headTypes, type));
    const added = [...headTypes].filter((type) => !covers(baseTypes, type));
    if (direction === 'request' && removed.length > 0) {
      context.emit('breaking', `${label}: deixou de aceitar o tipo ${removed.join('/')}`);
    }
    if (direction === 'response' && added.length > 0) {
      context.emit('breaking', `${label}: pode responder com o tipo novo ${added.join('/')}`);
    }
  } else if (baseTypes.size === 0 && headTypes.size > 0 && direction === 'request') {
    context.emit('breaking', `${label}: passou a restringir o tipo a ${[...headTypes].join('/')}`);
  }

  // Enum
  const baseEnum = array(base.enum).map((value) => JSON.stringify(value));
  const headEnum = array(head.enum).map((value) => JSON.stringify(value));
  if (direction === 'request') {
    const removed = baseEnum.filter((value) => !headEnum.includes(value));
    if (headEnum.length > 0 && (baseEnum.length === 0 || removed.length > 0)) {
      const detail = baseEnum.length === 0 ? 'passou a aceitar só valores listados' : removed;
      context.emit('breaking', `${label}: enum restringido (${String(detail)})`);
    }
  } else if (baseEnum.length > 0) {
    const added = headEnum.filter((value) => !baseEnum.includes(value));
    if (added.length > 0) {
      context.emit('warning', `${label}: valor novo no enum da resposta (${added.join(', ')})`);
    }
  }

  // Limites, formato e padrão (só restringem a requisição)
  if (direction === 'request') {
    for (const { key, tighter } of NARROWING) {
      const before = base[key];
      const after = head[key];
      if (typeof after !== 'number') continue;
      if (typeof before !== 'number' || tighter(before, after)) {
        context.emit('breaking', `${label}: ${key} mais restrito (${String(before)} → ${after})`);
      }
    }
    for (const key of ['pattern', 'format'] as const) {
      if (head[key] !== undefined && head[key] !== base[key]) {
        context.emit('breaking', `${label}: ${key} alterado`);
      }
    }
    if (base.additionalProperties !== false && head.additionalProperties === false) {
      context.emit('breaking', `${label}: deixou de aceitar propriedades adicionais`);
    }
  }

  // Objetos
  const baseProps = record(base.properties);
  const headProps = record(head.properties);
  const baseRequired = new Set(array(base.required).map(String));
  const headRequired = new Set(array(head.required).map(String));
  const prefix = where === '' ? '' : `${where}.`;
  for (const name of Object.keys(baseProps)) {
    if (name in headProps) continue;
    // Requisição: o cliente antigo continua enviando; só quebra se o schema novo for estrito.
    const level =
      direction === 'response' || head.additionalProperties === false ? 'breaking' : 'warning';
    context.emit(level, `${prefix}${name}: propriedade removida`);
  }
  for (const [name, schema] of Object.entries(headProps)) {
    const path = `${prefix}${name}`;
    if (!(name in baseProps)) {
      if (direction === 'request' && headRequired.has(name)) {
        context.emit('breaking', `${path}: propriedade obrigatória nova`);
      } else {
        context.emit('additive', `${path}: propriedade nova`);
      }
      continue;
    }
    if (direction === 'request' && headRequired.has(name) && !baseRequired.has(name)) {
      context.emit('breaking', `${path}: passou a ser obrigatória`);
    }
    if (direction === 'response' && baseRequired.has(name) && !headRequired.has(name)) {
      context.emit('breaking', `${path}: deixou de ser garantida na resposta`);
    }
    compareSchema(context, baseProps[name], schema, direction, path);
  }

  // Arrays
  if (base.items !== undefined && head.items !== undefined) {
    compareSchema(context, base.items, head.items, direction, `${prefix}[]`);
  }

  // Uniões (oneOf/anyOf): na requisição não pode perder alternativas; na resposta, ganhar.
  for (const key of ['oneOf', 'anyOf'] as const) {
    const before = array(base[key]);
    const after = array(head[key]);
    if (before.length === 0 && after.length === 0) continue;
    if (direction === 'request' && after.length < before.length) {
      context.emit('breaking', `${label}: ${key} perdeu alternativas`);
    }
    if (direction === 'response' && after.length > before.length) {
      context.emit('breaking', `${label}: ${key} ganhou alternativas na resposta`);
    }
    for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
      compareSchema(context, before[index], after[index], direction, `${label}<${key}[${index}]>`);
    }
  }
}

function content(doc: Json, value: unknown): Json {
  return record(resolve(doc, value).content);
}

function security(doc: Json, op: Json): Set<string> {
  const list = Array.isArray(op.security) ? op.security : array(doc.security);
  return new Set(
    list.map((item) => {
      const requirement = record(item);
      return JSON.stringify(
        Object.keys(requirement)
          .sort()
          .map((name) => [name, array(requirement[name]).map(String).sort()]),
      );
    }),
  );
}

const PUBLIC = JSON.stringify([]);

function compareOperation(context: Context, before: Operation, after: Operation): void {
  const { base, head } = context;

  // Parâmetros
  const baseParams = parameters(base, before);
  const headParams = parameters(head, after);
  for (const [key, param] of baseParams) {
    if (!headParams.has(key)) context.emit('breaking', `parâmetro removido: ${param.label}`);
  }
  for (const [key, param] of headParams) {
    const previous = baseParams.get(key);
    if (!previous) {
      context.emit(
        param.required ? 'breaking' : 'additive',
        `parâmetro ${param.required ? 'obrigatório ' : ''}novo: ${param.label}`,
      );
      continue;
    }
    if (param.required && !previous.required) {
      context.emit('breaking', `parâmetro passou a ser obrigatório: ${param.label}`);
    }
    compareSchema(context, previous.schema, param.schema, 'request', param.label);
  }

  // Corpo da requisição
  const baseBody = resolve(base, before.op.requestBody);
  const headBody = resolve(head, after.op.requestBody);
  if (headBody.required === true && baseBody.required !== true) {
    context.emit('breaking', 'corpo da requisição passou a ser obrigatório');
  }
  const baseContent = content(base, before.op.requestBody);
  const headContent = content(head, after.op.requestBody);
  for (const [type, media] of Object.entries(baseContent)) {
    const next = headContent[type];
    if (next === undefined) {
      context.emit('breaking', `requisição deixou de aceitar ${type}`);
      continue;
    }
    compareSchema(context, record(media).schema, record(next).schema, 'request', '');
  }

  // Respostas
  const baseResponses = record(before.op.responses);
  const headResponses = record(after.op.responses);
  for (const [status, response] of Object.entries(baseResponses)) {
    const next = headResponses[status];
    if (next === undefined) {
      if (/^[23]/.test(status)) context.emit('breaking', `resposta ${status} removida`);
      continue;
    }
    const baseMedia = content(base, response);
    const headMedia = content(head, next);
    for (const [type, media] of Object.entries(baseMedia)) {
      const target = headMedia[type];
      if (target === undefined) {
        context.emit('breaking', `resposta ${status} deixou de oferecer ${type}`);
        continue;
      }
      compareSchema(
        context,
        record(media).schema,
        record(target).schema,
        'response',
        `resposta ${status}`,
      );
    }
  }
  for (const status of Object.keys(headResponses)) {
    if (!(status in baseResponses)) context.emit('additive', `resposta ${status} nova`);
  }

  // Segurança: exigir autenticação nova (ou remover uma alternativa aceita) quebra clientes.
  const baseSecurity = security(base, before.op);
  const headSecurity = security(head, after.op);
  const wasPublic = baseSecurity.size === 0 || baseSecurity.has(PUBLIC);
  const isPublic = headSecurity.size === 0 || headSecurity.has(PUBLIC);
  if (wasPublic && !isPublic) {
    context.emit('breaking', 'passou a exigir autenticação');
  } else if (!wasPublic && !isPublic) {
    const removed = [...baseSecurity].filter((item) => !headSecurity.has(item));
    if (removed.length > 0) context.emit('breaking', 'requisito de segurança alterado');
  }
}

export function diffOpenApi(base: OpenApiDocument, head: OpenApiDocument): ContractChange[] {
  const changes: ContractChange[] = [];
  const baseOps = operations(base);
  const headOps = operations(head);
  const seen = new Set<string>();

  for (const [key, before] of baseOps) {
    const after = headOps.get(key);
    if (!after) {
      changes.push({ level: 'breaking', route: before.route, detail: 'operação removida' });
      continue;
    }
    if (after.op.deprecated === true && before.op.deprecated !== true) {
      changes.push({ level: 'warning', route: after.route, detail: 'operação depreciada' });
    }
    compareOperation(
      {
        base,
        head,
        route: after.route,
        seen,
        emit: (level, detail) => changes.push({ level, route: after.route, detail }),
      },
      before,
      after,
    );
  }
  for (const [key, after] of headOps) {
    if (!baseOps.has(key)) {
      changes.push({ level: 'additive', route: after.route, detail: 'operação nova' });
    }
  }
  return changes;
}

/** Mensagem da V-05 (`OPENAPI_BREAKING_CHANGE`). */
export function breakingMessage(route: string): string {
  return `Mudança incompatível em ${route}. Use /api/v2 ou torne aditiva.`;
}
