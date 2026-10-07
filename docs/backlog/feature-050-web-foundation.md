---
id: FT-050
title: "Frontend base"
epic: EP-015
mvp: 1
priority: P0
stories: [US-086]
status: Especificada
---

# FT-050 — Frontend base

## Título
Frontend base

## Épico
EP-015 — Fundação técnica

## Descrição
Entrega a casca (*shell*) definitiva do `apps/web`: rotas (App Router com *route groups*), BFF (sessão OIDC + proxy de API), *design system* (`packages/ui` com Storybook), cache (TanStack Query particionado por tenant), componente de permissão (`<Can>`) e as páginas globais de erro (SCR-111) — tudo entregue por uma única story (US-086).

## Valor para o usuário e para o órgão
- Garante uma experiência consistente (navegação, erros, acessibilidade) em toda tela de negócio futura, com menos retrabalho de UI entre features de produto.
- Garante que o browser nunca veja token de acesso (DEC-053) e que toda página autenticada tenha os cabeçalhos de segurança corretos desde o primeiro dia.
- Reduz o tempo de entrega de cada tela de negócio seguinte, que só precisa compor componentes já acessíveis (WCAG 2.1 AA + eMAG 3.1).

## Personas
- Pessoa desenvolvedora frontend — constrói cada tela de negócio sobre esta casca.
- Usuário final de qualquer perfil do ContrataFlow — experimenta a navegação, o tema e as páginas de erro desde esta feature.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-086 | Shell da aplicação web, design system e cliente de API | P0 | L | US-077 |

## Escopo
- *Route groups* `(auth)`, `(app)`, `(app)/admin`; resolução de sessão/tenant no servidor.
- BFF: `/api/auth/*` (sessão OIDC) e proxy `/api/v1/[...path]` com CSRF, *allowlist* de cabeçalhos, cabeçalhos de segurança/CSP.
- `packages/ui` (shadcn/ui + Radix + Tailwind) com Storybook e testes de acessibilidade; next-intl (pt-BR).
- TanStack Query com *query keys* por tenant; `<Can>`/`usePermission`; páginas de SCR-111.

## Fora de escopo
- Qualquer tela de negócio de produto (EP-001 a EP-014) — compõem sobre esta casca, não a estendem aqui.
- Autenticação real (fluxo Authentik completo, MFA, convites) — EP-016.

## Regras de negócio da feature
- RN-FND-87 a RN-FND-96 (US-086): rotas/*route groups*, Server/Client Components, cliente de API único via proxy, *query keys* por tenant, *design system* genérico, permissões na UI, erros/*boundaries*, cabeçalhos de segurança/CSP, internacionalização, acessibilidade.

## Telas
- SCR-111 — Páginas de erro e estados globais (`/erro/*`).

## Endpoints
Não aplicável ao catálogo `api.md` §3 — as rotas desta feature são do BFF (`/api/auth/*`, `/api/v1/[...path]`), documentadas em `architecture.md` §8.4.

## Entidades
Não aplicável — nenhuma tabela; `TenantSetting` de branding é lido, não criado, por esta feature.

## Eventos
Não aplicável.

## Permissões
Não aplicável — nenhuma permissão nova; `<Can>`/`usePermission` são o mecanismo que consome o catálogo já existente (`permissions.md`).

## Dependências
- Depende de FT-047 (monorepo, `packages/ui` inicial) e consome o contrato de erro/paginação de FT-048 (US-080). Habilita toda feature de produto da UI do MVP 1 e disponibiliza SCR-111 para qualquer story que precise de página de erro global.

## Critérios de aceite da feature
```gherkin
Feature: Frontend base
  Scenario: Jornada ponta a ponta do shell web
    Given uma pessoa autenticada com tenant ativo
    When ela navegar pela página de exemplo do shell
    Then o shell deve aplicar os cabeçalhos de segurança e CSP em toda resposta
    And ao trocar o tenant ativo todo o cache anterior deve ser limpo
```

## Métricas de sucesso
- 100% dos componentes do `packages/ui` com zero violação séria/crítica de acessibilidade (axe).
- *Shell* interativo (TTI) sob 2,5 s em conexão 4G simulada no CI.

## Riscos
- CSP estrita bloqueia biblioteca de terceiros sem suporte a *nonce* — mitigado por avaliação prévia (mesmo processo de dependência nova da US-077) e monitoramento de `report-to`.
- Convenção de `<Can>`/*query key* errada na fundação propaga retrabalho a todas as telas de negócio — mitigado por página de exemplo com teste automatizado antes de liberar a feature.

## Definition of Done da feature
- [ ] Story P0 (US-086) concluída e aceita
- [ ] Jornada E2E da feature automatizada (login fake → shell → página de exemplo → cada classe de erro → logout)
- [ ] Documentação atualizada (`architecture.md` §8, `security.md` §8)
