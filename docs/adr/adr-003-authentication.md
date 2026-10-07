# ADR-003 — Autenticação com Authentik (OIDC + PKCE) e BFF no Next.js

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead · Segurança · Produto |
| **Decisões relacionadas** | DEC-012, DEC-053, DEC-130, DEC-131, DEC-132, DEC-133, DEC-135, DEC-138, DEC-139 |
| **Documentos** | [authentication.md](../architecture/authentication.md) · [security.md](../architecture/security.md) · [entities.md — `User`, `TenantMembership`](../mvp-01/entities.md) · [api.md §3.1](../mvp-01/api.md) |

## Contexto

- O ContrataFlow é um SaaS B2G multi-tenant (Lei 14.133/2021): cada instituição contratante é um tenant, e a mesma pessoa pode ter vínculos com várias instituições (ex.: consultoria externa, órgão de controle). Senhas não podem ser compartilhadas nem geridas fora do controle do próprio órgão.
- É preciso delegar autenticação — senha, MFA, recuperação, e no futuro federação (gov.br, Entra ID do órgão) — a um IdP especializado, sem reescrever esses fluxos na aplicação; manter identidade global (`User`) separada do vínculo por tenant (`TenantMembership`); e impedir que tokens fiquem expostos ao navegador, reduzindo a superfície de XSS e roubo de token.
- A API NestJS não deve ser exposta à internet no MVP 1 (DEC-053); a sessão precisa de expiração ociosa e absoluta configuráveis por tenant, e de MFA proporcional ao risco por tenant.
- Equipe pequena, sem orçamento para operar um IdP próprio do zero nem squad de identidade dedicado; stack já cloud-agnostic por protocolo (DEC-058), o que pesa contra serviços de identidade proprietários.

## Decisão

1. **Authentik como IdP OIDC** (DEC-130): Authorization Code + PKCE (`S256`) com cliente **confidencial** no BFF; escopos `openid profile email offline_access`; `sub` = UUID do usuário no Authentik. Login, recuperação de senha, MFA (TOTP/WebAuthn) e federação futura são fluxos hospedados no Authentik, com identidade visual do ContrataFlow.
2. **BFF em `apps/web`** (DEC-053): único componente que fala OIDC; expõe `/api/auth/*` (login, callback, logout, session, switch-tenant, step-up, forgot-password) e faz proxy autenticado de `/api/v1/*` para a API. Tokens (access/refresh/id) ficam só no servidor; o browser recebe apenas o cookie opaco `__Host-cf_session` (`HttpOnly`, `Secure`, `SameSite=Lax`) — DEC-131.
3. **Sessão em Redis dedicado**, separado do Redis de filas/cache/idempotência, em HA Multi-AZ: dependência crítica (indisponibilidade → BFF 503, nunca inconsistência de dados). Expiração ociosa e absoluta configuráveis por tenant (`security.sessionIdleMinutes`, `security.sessionAbsoluteHours`); renovação de tokens transparente, com trava por sessão.
4. **Identidade global + vínculo por tenant** (DEC-012): `User` mapeado ao `sub`; `TenantMembership` concede acesso a um tenant com status, validade e papel próprios; o usuário escolhe o tenant ativo da sessão e pode trocá-lo sem novo login.
5. **A API revalida tudo, a cada requisição** (DEC-132): assinatura do JWT via JWKS em cache, `iss`, `aud`, `exp`, `nbf`; resolve `User` pelo `sub` e o tenant pelo `X-Tenant-Id` definido pelo BFF; exige `TenantMembership` `ACTIVE` e tenant `ACTIVE` (ou `OFFBOARDING` em modo somente leitura). A API nunca confia cegamente no BFF.
6. **MFA proporcional ao risco, por tenant** (DEC-133, POL-14): `security.mfaPolicy` `NONE`/`ADMINS`/`ALL`; claim `amr` verificada na API; *step-up* no BFF sem novo login completo.
7. **CSRF e cabeçalhos** (DEC-135): cookie `SameSite=Lax` + header `X-CF-Request: 1` + verificação de `Origin`/`Sec-Fetch-Site` para métodos mutáveis; CSP estrita, HSTS e demais cabeçalhos aplicados no BFF.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant W as apps/web (BFF)
    participant AT as Authentik
    participant A as apps/api
    B->>W: GET /api/auth/login
    W-->>B: 302 Authentik (Authorization Code + PKCE)
    B->>AT: autentica (+ MFA se exigido)
    AT-->>B: 302 /api/auth/callback?code
    B->>W: GET /api/auth/callback
    W->>AT: troca code por tokens
    W->>W: sessão no Redis; Set-Cookie __Host-cf_session
    B->>W: requisições subsequentes (cookie)
    W->>A: proxy com Bearer + X-Tenant-Id
    A->>A: valida JWT (JWKS) e vínculo a cada chamada
```

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **Keycloak** (IdP próprio) | Open-source maduro; RBAC e federação ricos; auto-hospedado | Operação Java mais pesada para equipe pequena; customização de tema do fluxo de recuperação menos direta | **Rejeitada:** Authentik cobre o mesmo padrão OIDC com operação mais simples e tema mais direto para a identidade visual do ContrataFlow |
| **Auth0 / AWS Cognito** (IdP gerenciado) | Sem operação própria; SLA do fornecedor | Serviço proprietário no caminho crítico de login (contraria DEC-058); custo por usuário ativo cresce com a base de servidores públicos; dados pessoais de identidade hospedados fora do controle direto (LGPD, DEC-140) | **Rejeitada:** portabilidade e soberania de dados de identidade de órgãos públicos pesam mais que a operação zero |
| **Autenticação própria** (senha e hash no ContrataFlow) | Controle total; sem dependência externa | Reconstrói MFA, recuperação de senha, políticas de senha e proteção contra *credential stuffing*; risco de segurança integral do time; nenhum ganho de produto | **Rejeitada:** custo e risco desproporcionais para um requisito *commodity* |
| **Tokens no navegador** (SPA pura, sem BFF) | Arquitetura mais simples, sem camada de sessão própria | Access token exposto a XSS; refresh token no browser amplia a superfície de roubo; exigiria CORS na API, expondo-a à internet (contra DEC-053); revogação e *step-up* de MFA mais difíceis | **Rejeitada:** o padrão BFF com cookie `HttpOnly` elimina a classe de ataque de roubo de token via XSS e mantém a API em rede privada |
| **Federação direta por tenant, sem IdP central** | Reaproveita um IdP que o órgão já tenha | Cada integração seria um projeto; sem fluxo único de recuperação/MFA/convite; complexidade multiplicada por tenant já no MVP 1 | **Adiada:** federação (gov.br, Entra ID do órgão) entra como provedor *upstream* do Authentik quando necessário, não como substituto |

## Consequências

**Positivas**
- Tokens nunca chegam ao navegador; a superfície de roubo de token (XSS, extensões maliciosas) é eliminada (DEC-053, DEC-131).
- Login, MFA, recuperação de senha e futura federação são configuração do Authentik, não código da aplicação.
- A API permanece em rede privada no MVP 1, reduzindo a superfície pública a `apps/web` e ao Authentik.
- Identidade global com vínculo por tenant suporta nativamente consultorias externas e múltiplas instituições por pessoa (DEC-012).
- Política de MFA e de sessão configuráveis por tenant sem mudança de código.

**Negativas**
- O Redis de sessões é dependência crítica adicional: sua indisponibilidade derruba o BFF (503) mesmo com banco e API saudáveis.
- O BFF concentra lógica sensível (troca de token, CSRF, proxy), exigindo revisão de segurança e testes dedicados.
- Dependência operacional do Authentik (disponibilidade, atualizações, banco próprio) além da stack principal do ContrataFlow.
- A renovação de token com trava por sessão adiciona latência ocasional (até 5 s de espera) em requisições concorrentes durante o *refresh*.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Indisponibilidade do Redis de sessões derruba todo o acesso | Cluster HA Multi-AZ com failover automático; separado logicamente do Redis de cache/filas (DEC-131) |
| Authentik indisponível no login ou na renovação | Falha transitória preserva a sessão com o token ainda válido; falha definitiva encerra a sessão de forma explícita (`SESSION_EXPIRED`), nunca silenciosa |
| Vazamento ou reuso de refresh token | Rotação atômica a cada renovação; token anterior invalidado; reuso detectado encerra a sessão |
| Administrador perde o próprio MFA e trava a si mesmo | Acesso de suporte da plataforma auditado (DEC-139) como via de último recurso, nunca autoatendimento só por e-mail |
| Authentik como ponto único de identidade de todos os tenants | Banco próprio do Authentik com backup dedicado; `sub` estável (UUID) preserva a identidade em caso de migração futura de IdP |
| Abuso de acesso de suporte por operador da plataforma | Vínculo temporário (≤ 72 h), perfil restrito, auditoria visível ao administrador do tenant (DEC-139) |

## Critérios de revisão

- Necessidade de federação real com gov.br ou Entra ID do órgão em produção → configurar *identity provider* upstream no Authentik, sem rever esta decisão.
- API pública a terceiros (MVP 3) exigindo tokens no cliente (integrações servidor-a-servidor) → avaliar fluxo `client_credentials` adicional, mantendo o BFF para usuários humanos.
- Incidente de disponibilidade recorrente do Authentik ou do Redis de sessões → reavaliar a topologia de HA ou um IdP alternativo.
- Volume de tenants/usuários que torne o custo operacional do Authentik maior que um IdP gerenciado equivalente → reavaliar Auth0/Cognito.

## Referências

- DEC-012, DEC-053, DEC-130, DEC-131, DEC-132, DEC-133, DEC-135, DEC-138, DEC-139 — [decisions.md](../architecture/decisions.md).
- [authentication.md](../architecture/authentication.md) (especificação completa de fluxos, sessão e rotas do BFF).
- [security.md](../architecture/security.md) §3 (autenticação), §4 (MFA), §7 (CORS/CSRF), §8 (cabeçalhos), §22 (suporte da plataforma).
- [entities.md](../mvp-01/entities.md) (`User`, `TenantMembership`), [api.md](../mvp-01/api.md) §3.1 (rotas do BFF).
- US-087 a US-091, US-093 — `docs/backlog/`.
