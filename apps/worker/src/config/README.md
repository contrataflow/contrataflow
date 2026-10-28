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
- `email.ts` — e-mail transacional do `EmailSender` (US-112 · DEC-050): `EMAIL_TRANSPORT` (`smtp`),
  `SMTP_URL` (`smtp://`/`smtps://`, credenciais na URL — Mailpit em dev, interface SMTP do SES em
  produção), `EMAIL_FROM`, `APP_BASE_URL` (base dos links) e `EMAIL_RATE_PER_SECOND` (padrão 10/s,
  `limiter` da fila `email`). Lida pelo `main` só quando as filas estão ligadas; obrigatória fora de
  `local`/`dev`/`test` (lá, sem `SMTP_URL`, o `EmailSender` não é registrado e os jobs esperam na fila).
- `api-jobs.ts` — jobs dos módulos da API (DEC-052 · `@contrataflow/api/jobs`): PDF (`document-render`),
  varredura de anexos (`file-scan`) e IA (`ai-generation`). Lê o mesmo `.env` da API pelo schema dela no
  modo "jobs" (`loadJobsConfig`, sem `OIDC_ISSUER_URL`/`INTERNAL_SERVICE_TOKEN`/`REDIS_SESSION_URL`).
  Liga com `DATABASE_URL` (papel `cf_app`); obrigatória fora de `local`/`dev`/`test` (lá, ausente, os
  jobs da API ficam desligados). Lida pelo `main` só com as filas ligadas. Sem `GOTENBERG_URL`,
  `CLAMAV_HOST` ou os buckets S3, só as filas dependentes ficam pausadas (`worker.queue_unconfigured`).
