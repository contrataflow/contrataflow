# Módulos (`src/modules/<módulo>/`)

Um diretório por módulo de DEC-040, com as camadas de DEC-041 (architecture.md §5):

```
<módulo>/
  domain/          # puro: sem NestJS, Prisma, Redis ou outro módulo
  application/     # commands, queries, políticas, <módulo>.facade.ts (API pública)
  infrastructure/  # repositórios Prisma, adapters
  presentation/    # controllers REST
  <módulo>.module.ts
```

- Outro módulo só é acessado por `application/<módulo>.facade.ts` (e `application/dto/**`),
  respeitando os níveis de `tools/module-levels.json`.
- Crie um módulo com `pnpm turbo gen api-module`.
- Regras verificadas por `pnpm depcruise` e `pnpm lint`.
