# Testes de integração e apoio (`test/`)

- `test/*.spec.ts` — integração com Docker, executada por `pnpm test:integration` (fora do
  `pnpm test`): Testcontainers com Redis (`redis-pipeline.spec.ts`: throttler, idempotência,
  concorrência e queda do Redis); `database/` (US-081) com PostgreSQL real e as migrações aplicadas
  por `prisma migrate deploy`: `tenant-isolation.spec.ts` (suíte _tenant leak_ no banco, também em
  `pnpm test:tenant-leak`) e `persistence.spec.ts` (papéis, concorrência otimista, decimais, falha
  de banco, travas, snapshots e migrações). `audit/audit-trail.spec.ts` (US-073/US-088: trilha,
  RLS, partições, `oncePerSession`) e `audit/session-sweep.spec.ts` (US-088: varredura de
  sessões contra Redis e PostgreSQL reais). `timeline/timeline-projection.spec.ts` (US-059:
  projeção síncrona da timeline — mesma transação, RLS, reprocessamento, concorrência e falha de
  banco; também em `pnpm test:tenant-leak`). MinIO chega com a story dona.
- `test/support/` — apoio compartilhado pelos testes unitários e de integração: `createTestApi()`
  (aplicação Nest completa com armazenamentos em memória ou Redis, tokens do `FakeJwksProvider`) e
  controllers usados só pelos testes do pipeline.

Testes unitários ficam ao lado do código (`src/**/*.spec.ts`) e rodam sem Docker.
