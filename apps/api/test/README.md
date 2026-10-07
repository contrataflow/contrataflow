# Testes de integração (`test/`)

Executados por `pnpm test:integration` (exige Docker): Testcontainers com PostgreSQL + RLS,
Redis e MinIO, suíte _tenant leak_ e contrato. Infraestrutura entregue pela US-078/US-079.
Testes unitários ficam ao lado do código (`src/**/*.spec.ts`) e rodam sem banco.
