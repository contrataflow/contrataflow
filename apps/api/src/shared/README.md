# Shared kernel (`src/shared/`)

Infraestrutura transversal da API (nível 0 — architecture.md §3.3): contexto de requisição
(AsyncLocalStorage), erros RFC 9457, Unit of Work, guards, decorators, portas
(`ProcessAccessPort`…), `shared/database/**` (Prisma) e `shared/cache/**` (`TenantCache`).

- Importado por qualquer módulo como `#shared/<caminho>.js`.
- **Nunca** importa `src/modules/**` (verificado pelo dependency-cruiser).
- Preenchido a partir da US-080.
