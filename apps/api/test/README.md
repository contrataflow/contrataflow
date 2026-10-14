# Testes de integração e apoio (`test/`)

- `test/*.spec.ts` — integração com Docker, executada por `pnpm test:integration` (fora do
  `pnpm test`): Testcontainers com Redis (`redis-pipeline.spec.ts`: throttler, idempotência,
  concorrência e queda do Redis); PostgreSQL + RLS, MinIO e a suíte _tenant leak_ chegam com as
  stories donas.
- `test/support/` — apoio compartilhado pelos testes unitários e de integração: `createTestApi()`
  (aplicação Nest completa com armazenamentos em memória ou Redis, tokens do `FakeJwksProvider`) e
  controllers usados só pelos testes do pipeline.

Testes unitários ficam ao lado do código (`src/**/*.spec.ts`) e rodam sem Docker.
