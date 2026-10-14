// API simulada do E2E do shell (US-086): responde às rotas internas da US-080 (`/_internal/*`) e
// a ME-03, exige o Bearer emitido pelo BFF e permite injetar falhas por `POST /__mock/fail`.
// Sem dependências: `node test/e2e/support/mock-api.mjs <porta>`.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 4010);
const failures = new Map();
const replays = new Map();

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
    const permissions = sub === 'sub-ana' ? [{ code: 'PROCESS_CREATE', scopes: ['TENANT'] }] : [];
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
  return problem(response, 404, 'NOT_FOUND', String(correlationId));
}).listen(PORT, () => {
  process.stdout.write(`mock-api pronto na porta ${PORT}\n`);
});
