// API simulada do E2E do shell (US-086): responde às rotas internas da US-080 (`/_internal/*`) e
// a ME-03, exige o Bearer emitido pelo BFF e permite injetar falhas por `POST /__mock/fail`.
// Sem dependências: `node test/e2e/support/mock-api.mjs <porta>`.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 4010);
const failures = new Map();
const replays = new Map();

// Tipos de documento (US-061 · DTY-01..03): catálogo em memória, só o necessário para a jornada do SCR-108.
const EDITABLE_ALL = [
  'name',
  'description',
  'allowMultiplePerProcess',
  'numberingEnabled',
  'numberingMask',
  'requiresApproval',
  'approvalPolicy',
  'defaultConfidentiality',
  'sortOrder',
  'isActive',
];
const EDITABLE_SYSTEM = EDITABLE_ALL.filter((field) => field !== 'allowMultiplePerProcess');
const documentTypes = [
  ['DFD', 'Documento de Formalização da Demanda', 'STRUCTURED', 'DFD', 10, null],
  ['ETP', 'Estudo Técnico Preliminar', 'STRUCTURED', 'ETP', 20, null],
  ['OFICIO', 'Ofício', 'FREE_TEXT', null, 70, 'OF {seq:4}/{year}'],
  ['DOCUMENTO_EXTERNO', 'Documento externo', 'UPLOADED', null, 110, null],
].map(([code, name, kind, systemModule, sortOrder, numberingMask], index) => ({
  id: `0192a000-0000-7000-8000-00000000d0${String(index).padStart(2, '0')}`,
  code,
  name,
  description: null,
  kind,
  systemModule,
  isSystem: true,
  isActive: true,
  allowMultiplePerProcess: kind !== 'STRUCTURED',
  numberingEnabled: code !== 'DOCUMENTO_EXTERNO',
  numberingMask,
  requiresApproval: false,
  approvalPolicy: null,
  defaultConfidentiality: 'INTERNAL',
  defaultTemplate: null,
  sortOrder,
  editableFields:
    kind === 'STRUCTURED' ? EDITABLE_SYSTEM.filter((f) => f !== 'isActive') : EDITABLE_SYSTEM,
  version: 1,
}));

// Configurações do tenant (US-103 · SET-01..03): um subconjunto de chaves de grupos diferentes, com
// versão por chave e conferência de `expectedVersions` no PATCH em lote (tudo ou nada).
const settings = new Map([
  ['labels.secretariat', { value: 'Secretaria', version: 1 }],
  ['labels.department', { value: 'Setor', version: 1 }],
  ['branding.primaryColor', { value: '#1D4ED8', version: 1 }],
  ['numbering.process.mask', { value: '{seq:4}/{year}', version: 1 }],
  ['security.sessionIdleMinutes', { value: 30, version: 1 }],
]);
const PUBLIC_SETTINGS = ['labels.secretariat', 'labels.department', 'branding.primaryColor'];

// Órgãos (US-101 · ORG-01..04): um órgão principal ativo e um fundo, só o necessário para o SCR-032.
const organizations = [
  ['PMSJ', 'Prefeitura Municipal de São José', '11222333000181', 'DIRECT_ADMINISTRATION'],
  ['FMS', 'Fundo Municipal de Saúde', '11444777000161', 'FUND'],
].map(([shortName, name, cnpj, type], index) => ({
  id: `0192a000-0000-7000-8000-00000000f1${String(index).padStart(2, '0')}`,
  name,
  shortName,
  cnpj,
  type,
  isActive: true,
  isPrimary: index === 0,
  email: null,
  phone: null,
  website: null,
  addressStreet: null,
  addressNumber: null,
  addressComplement: null,
  addressDistrict: null,
  addressCity: null,
  addressState: null,
  addressZipCode: null,
  ibgeCityCode: null,
  logoAttachmentId: null,
  metadata: {},
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  version: 1,
}));

function previewOf(type) {
  if (!type.numberingEnabled) return null;
  const mask = type.numberingMask ?? '{type} {seq:4}/{year}';
  return mask
    .replace(/\{seq:(\d)\}/, (_m, width) => '1'.padStart(Number(width), '0'))
    .replace('{year}', String(new Date().getFullYear()))
    .replace('{type}', type.code);
}

function documentTypeView(type) {
  return { ...type, nextNumberPreview: previewOf(type) };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

function problem(response, status, code, correlationId) {
  send(
    response,
    status,
    {
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase().replaceAll('_', '-')}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1',
      code,
      correlationId,
      errors: [],
      violations: [],
    },
    { 'Content-Type': 'application/problem+json', 'X-Correlation-Id': correlationId },
  );
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      resolve(raw);
    });
  });
}

function subject(authorization) {
  const token = (authorization ?? '').replace(/^Bearer /, '');
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).sub ?? null;
  } catch {
    return null;
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  const correlationId = request.headers['x-correlation-id'] ?? randomUUID();

  if (url.pathname === '/__mock/health') return send(response, 200, { status: 'ok' });
  if (url.pathname === '/__mock/fail') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (body.status) failures.set(body.path, body);
    else failures.delete(body.path);
    return send(response, 204);
  }
  const forced = failures.get(url.pathname);
  if (forced) return problem(response, forced.status, forced.code, String(correlationId));

  const sub = subject(request.headers.authorization);
  if (!sub) return problem(response, 401, 'UNAUTHENTICATED', String(correlationId));
  const tenantId = request.headers['x-tenant-id'] ?? null;

  if (url.pathname === '/api/v1/me/permissions') {
    const permissions =
      sub === 'sub-ana'
        ? [
            { code: 'PROCESS_CREATE', scopes: ['TENANT'] },
            { code: 'DOCUMENT_TYPE_MANAGE', scopes: [] },
            { code: 'ORGANIZATION_MANAGE', scopes: [] },
            { code: 'SETTINGS_MANAGE', scopes: [] },
          ]
        : [];
    return send(response, 200, { data: { permissions, implicit: {} } });
  }
  if (url.pathname === '/api/v1/_internal/ping') {
    return send(
      response,
      200,
      { data: { status: 'ok', correlationId, tenantId, userId: sub, membershipId: null } },
      { 'X-Correlation-Id': String(correlationId) },
    );
  }
  if (url.pathname === '/api/v1/_internal/items') {
    const page = Number(url.searchParams.get('page') ?? 1);
    const items = Array.from({ length: 10 }, (_, index) => {
      const position = (page - 1) * 10 + index + 1;
      return { id: `item-${String(position).padStart(2, '0')}`, position };
    }).filter((item) => item.position <= 45);
    return send(response, 200, {
      data: items,
      meta: { page, pageSize: 10, totalItems: 45, totalPages: 5 },
    });
  }
  if (url.pathname === '/api/v1/_internal/echo' && request.method === 'POST') {
    const key = String(request.headers['idempotency-key'] ?? '');
    const body = JSON.parse((await readBody(request)) || '{}');
    const replayed = replays.get(key);
    if (replayed) return send(response, 201, replayed, { 'Idempotent-Replayed': 'true' });
    const created = {
      data: { id: randomUUID(), name: body.name, quantity: body.quantity ?? null },
    };
    if (key) replays.set(key, created);
    return send(response, 201, created);
  }
  if (url.pathname === '/api/v1/document-types' && request.method === 'GET') {
    const all = url.searchParams.get('includeInactive') === 'true';
    const list = documentTypes
      .filter((type) => all || type.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pt-BR'));
    return send(response, 200, { data: list.map(documentTypeView) });
  }
  if (url.pathname === '/api/v1/document-types' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (documentTypes.some((type) => type.code === body.code)) {
      return problem(response, 409, 'CONFLICT', String(correlationId));
    }
    const created = {
      id: randomUUID(),
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      kind: body.kind,
      systemModule: null,
      isSystem: false,
      isActive: true,
      allowMultiplePerProcess: body.allowMultiplePerProcess,
      numberingEnabled: body.numberingEnabled,
      numberingMask: body.numberingMask ?? null,
      requiresApproval: body.requiresApproval,
      approvalPolicy: body.approvalPolicy ?? null,
      defaultConfidentiality: body.defaultConfidentiality,
      defaultTemplate: null,
      sortOrder: body.sortOrder ?? 0,
      editableFields: EDITABLE_ALL,
      version: 1,
    };
    documentTypes.push(created);
    return send(
      response,
      201,
      { data: documentTypeView(created) },
      {
        ETag: '"1"',
        Location: `/api/v1/document-types/${created.id}`,
      },
    );
  }
  if (url.pathname === '/api/v1/settings' && request.method === 'GET') {
    return send(response, 200, { data: Object.fromEntries(settings) });
  }
  if (url.pathname === '/api/v1/settings/public' && request.method === 'GET') {
    return send(response, 200, {
      data: Object.fromEntries(PUBLIC_SETTINGS.map((key) => [key, settings.get(key)?.value])),
    });
  }
  if (url.pathname === '/api/v1/settings' && request.method === 'PATCH') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const keys = Object.keys(body.values ?? {});
    if (keys.some((key) => !settings.has(key))) {
      return problem(response, 422, 'SETTING_KEY_UNKNOWN', String(correlationId));
    }
    if (keys.some((key) => body.expectedVersions?.[key] === undefined)) {
      return problem(response, 428, 'PRECONDITION_REQUIRED', String(correlationId));
    }
    if (keys.some((key) => body.expectedVersions[key] !== settings.get(key).version)) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const updated = {};
    for (const key of keys) {
      const next = { value: body.values[key], version: settings.get(key).version + 1 };
      settings.set(key, next);
      updated[key] = next;
    }
    return send(response, 200, { data: updated });
  }
  if (url.pathname === '/api/v1/organizations' && request.method === 'GET') {
    const list = [...organizations].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return send(response, 200, {
      data: list,
      meta: { page: 1, pageSize: 100, totalItems: list.length, totalPages: 1 },
    });
  }
  if (url.pathname === '/api/v1/organizations' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const shortName = String(body.shortName ?? '').toUpperCase();
    const cnpj = String(body.cnpj ?? '').replace(/[./-]/g, '');
    if (organizations.some((org) => org.shortName === shortName || org.cnpj === cnpj)) {
      return problem(response, 422, 'VALIDATION_ERROR', String(correlationId));
    }
    const created = {
      ...organizations[1],
      id: randomUUID(),
      name: body.name,
      shortName,
      cnpj,
      type: body.type,
      isPrimary: false,
      isActive: true,
      version: 1,
    };
    organizations.push(created);
    return send(
      response,
      201,
      { data: created },
      { ETag: '"1"', Location: `/api/v1/organizations/${created.id}` },
    );
  }
  const organizationRoute = /^\/api\/v1\/organizations\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (organizationRoute && request.method === 'GET') {
    const organization = organizations.find((item) => item.id === organizationRoute[1]);
    if (!organization) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    return send(response, 200, { data: organization }, { ETag: `"${organization.version}"` });
  }
  if (organizationRoute && request.method === 'PATCH') {
    const organization = organizations.find((item) => item.id === organizationRoute[1]);
    if (!organization) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${organization.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    const others = organizations.filter((item) => item !== organization && item.isActive);
    if (body.isActive === false && (organization.isPrimary || others.length === 0)) {
      return problem(response, 409, 'PRIMARY_ORGANIZATION_REQUIRED', String(correlationId));
    }
    Object.assign(organization, body, { version: organization.version + 1 });
    return send(response, 200, { data: organization }, { ETag: `"${organization.version}"` });
  }
  const documentTypeRoute = /^\/api\/v1\/document-types\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (documentTypeRoute && request.method === 'PATCH') {
    const type = documentTypes.find((item) => item.id === documentTypeRoute[1]);
    if (!type) return problem(response, 404, 'NOT_FOUND', String(correlationId));
    if (String(request.headers['if-match'] ?? '') !== `"${type.version}"`) {
      return problem(response, 412, 'VERSION_CONFLICT', String(correlationId));
    }
    const body = JSON.parse((await readBody(request)) || '{}');
    Object.assign(type, body, { version: type.version + 1 });
    return send(response, 200, { data: documentTypeView(type) }, { ETag: `"${type.version}"` });
  }
  return problem(response, 404, 'NOT_FOUND', String(correlationId));
}).listen(PORT, () => {
  process.stdout.write(`mock-api pronto na porta ${PORT}\n`);
});
