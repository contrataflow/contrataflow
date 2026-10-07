# Configuração (`src/config/`)

Único lugar onde `process.env` pode ser lido (RN-FND-06). O módulo validado por Zod
(`env.ts`, falha rápida no boot — architecture.md §10) é entregue pela US-080; até lá,
`http.config.ts` fixa a porta do estado hello.
