# Configuração (`src/config/`)

Único lugar onde `process.env` pode ser lido (RN-FND-06). O módulo validado por Zod do worker
(`WORKER_QUEUES`, `SHUTDOWN_GRACE_MS`… — architecture.md §10.2) chega com as stories donas.

- `telemetry.ts` — observabilidade (US-084).
- `outbox.ts` — `DATABASE_URL_RELAY` (papel `cf_relay`) e `REDIS_URL` (Redis das filas) do relay do outbox e do
  consumidor de `domain-events` (US-082 · DEC-072). Obrigatórias fora de `local`/`dev`/`test`; nesses
  ambientes, ausentes as duas, o outbox fica desligado.
