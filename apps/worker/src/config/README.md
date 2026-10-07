# Configuração (`src/config/`)

Único lugar onde `process.env` pode ser lido (RN-FND-06). O módulo validado por Zod do worker
(`WORKER_QUEUES`, `SHUTDOWN_GRACE_MS`… — architecture.md §10.2) chega com as stories donas.
