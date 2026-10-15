# Configuração (`src/config/`)

Único lugar onde `process.env` pode ser lido (RN-FND-06). O módulo validado por Zod do worker
(`WORKER_QUEUES`, `SHUTDOWN_GRACE_MS`… — architecture.md §10.2) chega com as stories donas.

- `telemetry.ts` — observabilidade (US-084).
- `outbox.ts` — `DATABASE_URL_RELAY` (papel `cf_relay`) e `REDIS_URL` (Redis das filas) do relay do outbox e do
  consumidor de `domain-events` (US-082 · DEC-072). Obrigatórias fora de `local`/`dev`/`test`; nesses
  ambientes, ausentes as duas, o outbox fica desligado.
- `queues.ts` — filas, schedulers e Bull Board (US-083): `REDIS_URL`, `DATABASE_URL_WORKER` (papel
  `cf_worker`, RLS), `DATABASE_URL_MAINTENANCE` (papel `cf_maintenance`, purga do outbox),
  `WORKER_ADMIN_PORT` (porta interna do painel) e `OIDC_ISSUER_URL`/`WORKER_ADMIN_OIDC_AUDIENCE`
  (cliente OIDC de operação). Obrigatórias fora de `local`/`dev`/`test` (o painel, só com a porta);
  sem `REDIS_URL` em `local`, as filas ficam desligadas; sem a `queues`, mas com o outbox, sobem só
  as filas do outbox. A CLI (`src/cli.ts`) lê ainda `CF_OPS_TOKEN` e, para `outbox:republish`,
  `DATABASE_URL_RELAY`.
- `sessions.ts` — `REDIS_SESSION_URL` (Redis de sessões) do consumidor que encerra sessões quando o
  vínculo é suspenso, revogado ou expirado (US-088 · RN-IAM-27). Obrigatória em `staging`/`production`;
  em `local`/`dev`/`test`, ausente, o evento é descartado com o aviso `auth.session_termination_disabled`.
