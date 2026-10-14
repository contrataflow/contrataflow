# Autenticação e sessão

> **Escopo:** autenticação de usuários do ContrataFlow via Authentik (OIDC), sessão do BFF em `apps/web`, validação de JWT e contexto de requisição na API, troca de tenant, MFA, convite de usuário, recuperação de senha e logout.
> **Status:** especificação da fundação + MVP 1.
> **Decisões de base:** DEC-012, DEC-053, DEC-130, DEC-131, DEC-132, DEC-133, DEC-135, DEC-138, DEC-139 ([decisions.md](decisions.md)).
> **Nomes canônicos:** [`entities.md`](../mvp-01/entities.md) (`User`, `TenantMembership`, `MembershipStatus`, chaves `security.*`), [`api.md`](../mvp-01/api.md) (rotas `/api/auth/*`, USR-13, códigos de erro), [`permissions.md`](../mvp-01/permissions.md) (POL-14, POL-15, POL-16).
> **Relacionados:** [security.md](security.md) (§3, §4, §7, §8, §22) · [architecture.md](architecture.md) (BFF, guards) · [multi-tenancy.md](multi-tenancy.md) · [observability.md](observability.md) · [ADR-003](../adr/adr-003-authentication.md).
>
> Itens marcados **(proposta)** não constam das fontes canônicas e devem ser registrados em `decisions.md`/`entities.md` antes da implementação.

Sumário: [1. Princípios](#1-visão-geral-e-princípios) · [2. Componentes](#2-componentes) · [3. Login OIDC](#3-login-oidc-authorization-code-com-pkce) · [4. Sessão no BFF](#4-sessão-no-bff) · [5. JWT e contexto](#5-validação-do-jwt-e-contexto-de-requisição-na-api-dec-132) · [6. Troca de tenant](#6-troca-de-tenant) · [7. Logout](#7-logout-e-expiração) · [8. Recuperação de senha](#8-recuperação-de-senha) · [9. MFA](#9-mfa-e-step-up) · [10. Convite](#10-convite-de-usuário-e-ativação-do-vínculo) · [11. CSRF e cabeçalhos](#11-csrf-e-cabeçalhos-de-segurança) · [12. Suporte da plataforma](#12-acesso-de-suporte-da-plataforma-dec-139) · [13. Observabilidade](#13-observabilidade) · [14. Falhas](#14-falhas-e-degradação) · [15. Rotas do BFF](#15-rotas-do-bff) · [16. Referências](#16-referências)

---

## 1. Visão geral e princípios

| # | Princípio | Consequência prática |
|---|---|---|
| P1 | Authentik autentica, o ContrataFlow autoriza | Login, MFA, recuperação de senha e federação futura (gov.br, Entra ID) são fluxos do Authentik; a aplicação nunca vê senha (DEC-130) |
| P2 | Tokens nunca chegam ao navegador | Access/refresh/id token ficam só no servidor do BFF; o browser recebe apenas um cookie de sessão opaco (DEC-053, DEC-131) |
| P3 | A API não confia no BFF, confia no JWT | Toda requisição é revalidada por assinatura JWKS, `iss`, `aud`, `exp`, `nbf`; o `X-Tenant-Id` é só um apontador resolvido contra o vínculo real (DEC-132) |
| P4 | Identidade global, acesso por vínculo | `User` é único por pessoa; `TenantMembership` concede acesso a um tenant específico, com status e validade próprios (DEC-012) |
| P5 | Sessão é infraestrutura crítica | O Redis de sessões roda separado do Redis de cache/filas, em HA; sua indisponibilidade derruba o BFF (503), não a consistência dos dados (DEC-131) |
| P6 | MFA proporcional ao risco | A política por tenant (`security.mfaPolicy`) decide se o segundo fator é opcional, obrigatório para permissões de risco alto ou obrigatório sempre (DEC-133, POL-14) |
| P7 | Nada sensível em log | Tokens, cookies, senhas e CPF nunca são logados; e-mails são mascarados (DEC-138) |
| P8 | Suporte da plataforma é excepcional e auditado | Operadores não têm acesso por padrão; quando concedido, é temporário, visível ao tenant e auditado (DEC-139) |
| P9 | Protocolo aberto, não o fornecedor | OIDC é padrão aberto (DEC-058): troca de Authentik por outro IdP OIDC não exige mudar o modelo de sessão do BFF nem o contrato da API |

## 2. Componentes

```mermaid
flowchart LR
  subgraph Browser
    UI["apps/web (UI)"]
  end
  subgraph Privada["Rede privada"]
    BFF["apps/web (BFF)<br/>oidc-client · session-store · csrf"]
    API["apps/api<br/>guards de autenticação"]
  end
  subgraph Dados["Dados"]
    RS[("Redis de sessões<br/>HA, crítico — DEC-131")]
  end
  subgraph IdP["Identidade"]
    AUTHENTIK["Authentik<br/>OIDC · MFA · recuperação de senha"]
  end

  UI -->|"cookie __Host-cf_session"| BFF
  BFF -->|tokens cifrados| RS
  BFF -->|"Authorization Code + PKCE"| AUTHENTIK
  BFF -->|"Bearer + X-Tenant-Id"| API
  API -->|JWKS| AUTHENTIK
```

- **Authentik (IdP OIDC):** autentica usuários; hospeda login, recuperação de senha, MFA (TOTP/WebAuthn) e, no futuro, federação (gov.br, Entra ID do órgão), com identidade visual do ContrataFlow; publica JWKS; exposto via ALB em `auth.<domínio>`.
- **BFF (`apps/web`, Next.js):** único componente que fala OIDC; mantém `src/bff/` (`oidc-client`, `session-store`, `csrf`, `api-proxy`, `rate-limit`); expõe `/api/auth/*` e faz proxy autenticado de `/api/v1/*` para a API; nunca expõe tokens ao browser (DEC-053).
- **API (`apps/api`, NestJS):** não exposta à internet no MVP 1 (só rede privada); valida o JWT em toda requisição e resolve o contexto de tenant/ator (DEC-132).
- **Redis de sessões:** guarda o estado de sessão (tokens cifrados, `userId`, `activeTenantId`, expirações); dependência crítica, separada do Redis de filas/cache/idempotência (DEC-131).

## 3. Login OIDC (Authorization Code com PKCE)

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant W as apps/web (BFF)
    participant R as Redis de sessões
    participant AT as Authentik
    participant A as apps/api

    B->>W: GET /api/auth/login?returnTo=...
    W->>W: gera state, nonce, code_verifier (CSPRNG); calcula code_challenge S256
    W->>R: grava cookie de transação cifrado (state, nonce, verifier, returnTo validado) — TTL 10 min
    W-->>B: 302 para Authentik /authorize (code_challenge, state, nonce)
    B->>AT: autentica (login, MFA se exigido, recuperação se solicitada)
    AT-->>B: 302 para /api/auth/callback?code=...&state=...
    B->>W: GET /api/auth/callback
    W->>W: valida state/nonce contra o cookie de transação
    W->>AT: POST /token (code + code_verifier)
    AT-->>W: access_token, refresh_token, id_token
    W->>W: valida id_token (JWKS, iss, aud, azp, exp, iat, nonce)
    W->>A: resolve vínculos utilizáveis (ME-01/ME-04)
    A-->>W: User.status, TenantMembership[] utilizáveis
    W->>R: cria sessão (userId, activeTenantId ou nenhum, tokens cifrados, expirações)
    W-->>B: Set-Cookie __Host-cf_session; 302 returnTo (ou seletor de instituição)
```

- Cliente **confidencial**; único fluxo habilitado é Authorization Code + PKCE `S256` (RN-IAM-01); implícito, híbrido e *password grant* desabilitados no Authentik; `code_challenge_method=plain` rejeitado.
- `state`/`nonce` (≥ 256 bits) e `code_verifier` (64 bytes base64url) por CSPRNG, uso único, válidos 10 min, no cookie de transação cifrado (AES-256-GCM; `HttpOnly`, `Secure`, `SameSite=Lax`); até 3 transações simultâneas por navegador (RN-IAM-02).
- `returnTo`: só caminho relativo validado (sem `//`, `/\`, esquema, host ou caracteres de controle); inválido cai em `/painel`, sem erro ao usuário (RN-IAM-03).
- `id_token`: assinatura via JWKS, algoritmos `RS256`/`ES256` (`none` rejeitado), `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`; tolerância de relógio ≤ 60 s (RN-IAM-04).
- `User.status` deve ser `ACTIVE`; `BLOCKED`/`DEACTIVATED` impedem a sessão (RN-IAM-07).
- Seleção da instituição: 1 vínculo utilizável → automática; vários → instituição padrão do usuário, se utilizável, senão seletor (US-093); nenhum → sessão sem instituição ativa (RN-IAM-09).
- Login CSRF: impedido pelo `state` vinculado ao cookie de transação (security.md §7).
- Limite de 20 req/min por IP em `/api/auth/login` e `/api/auth/callback` → 429 `RATE_LIMITED` (RN-IAM-15).
- Auditoria `auth.session_start` (SECURITY) gravada na instituição que se torna ativa, com `sessionIdHash`, IP, user-agent e `metadata { selection, firstLogin, amr }` (RN-IAM-17). Mensagens não revelam se a conta existe (RN-IAM-18).

## 4. Sessão no BFF

- **Cookie:** `__Host-cf_session`, opaco, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`; o prefixo `__Host-` impede que subdomínios o sobrescrevam (DEC-131, security.md §7).
- **Armazenamento:** o Redis de sessões guarda `userId`, `activeTenantId`/`membershipId`, tokens (access/refresh/id) cifrados e expirações; a chave é o hash SHA-256 do id do cookie — nunca o valor em claro.

| Configuração (`entities.md` §6) | Padrão | Faixa | Efeito |
|---|---|---|---|
| `security.sessionIdleMinutes` | 30 | 5–120 | Expiração por ociosidade (deslizante) |
| `security.sessionAbsoluteHours` | 12 | 1–24 | Expiração por duração absoluta (nunca estendida) |

- **Ociosidade (deslizante):** `idleExpiresAt = lastSeenAt + security.sessionIdleMinutes` da instituição ativa; só requisições iniciadas pelo usuário renovam — `GET /api/auth/session` em modo *keepalive* e sondagens de contador não renovam (RN-IAM-21).
- **Absoluta:** `absoluteExpiresAt = createdAt + security.sessionAbsoluteHours`; nunca estendida, nem por "Continuar conectado"; depois dela, só novo login (RN-IAM-22).
- **Avisos:** diálogo de ociosidade 2 min antes; aviso de término absoluto 5 min antes; `aria-live`, operáveis por teclado (RN-IAM-23).
- **Sessão vencida:** o BFF apaga os tokens, registra o motivo (`IDLE`/`ABSOLUTE`) e responde 401 `SESSION_EXPIRED`; o horário do fato é o limite calculado, não o da detecção (RN-IAM-24).
- **Renovação de tokens:** quando o access token vence em ≤ 60 s, renovação com trava por sessão (uma por vez; demais requisições esperam até 5 s); rotação do refresh token gravada atomicamente — o anterior deixa de ser aceito (RN-IAM-25). Falha definitiva (`invalid_grant`, token revogado/reutilizado) encerra a sessão (`REFRESH_FAILED` → 401 `SESSION_EXPIRED`); falha transitória segue com o token ainda válido; sem token válido → 503 `DEPENDENCY_UNAVAILABLE` com sessão preservada (RN-IAM-26).
- **Sincronização entre abas:** `BroadcastChannel` `cf-session` (`logout`, `expired`, `extended`) — logout em uma aba leva todas a SCR-001; expiração exibe o modal em todas (RN-IAM-29). Rascunhos locais (IndexedDB) sobrevivem à expiração por até 24 h, só para o mesmo usuário/instituição (RN-IAM-30).
- **Reautenticação:** após expiração, o login força `max_age=0` no Authentik; a sessão do próprio Authentik dura no máximo o teto absoluto da plataforma, para que a ociosidade não seja contornada (RN-IAM-32).
- **Varredura:** job a cada 1 min grava `auth.session_expired`/`auth.session_end`; registros de encerramento sem tokens ficam no máx. 24 h no Redis (RN-IAM-28).
- **Criptografia em repouso:** os tokens armazenados no Redis são cifrados (DEC-137), além da proteção de rede (TLS + AUTH) do próprio Redis de sessões.
- **Rastros de acesso:** `User.lastLoginAt` é atualizado na criação da sessão; `TenantMembership.lastAccessAt`, no máximo 1×/5 min por vínculo, para não gerar escrita excessiva (RN-IAM-16).

## 5. Validação do JWT e contexto de requisição na API (DEC-132)

Pipeline de guards fixo e global (as etapas 4 e 5 — permissão e política — pertencem a `permissions.md`, fora do escopo deste documento):

| # | Guard | Verifica | Falha |
|---|---|---|---|
| 1 | `AuthenticationGuard` | Assinatura do JWT via JWKS em cache (10 min, renovação forçada em `kid` desconhecido, no máx. 1×/30 s), `iss`, `aud`, `exp`, `nbf`, tolerância ≤ 60 s; resolve `User` por `externalSubject = sub`, exige `User.status = ACTIVE` | 401 `UNAUTHENTICATED` |
| 2 | `TenantContextGuard` | `X-Tenant-Id` (definido pelo BFF a partir da sessão); `TenantMembership` `ACTIVE` e não expirado; acesso conforme `Tenant.status`: `ACTIVE` → normal; `OFFBOARDING` → somente leitura/exportação para `ADMIN_ORGAO`/`AUDITOR`; `PROVISIONING`, `SUSPENDED`, `DEACTIVATED` → negado a usuários (operadores usam `/platform/*`) | 403 `TENANT_SUSPENDED` / `MEMBERSHIP_INACTIVE` |
| 3 | `MfaGuard` | Ver §9 | 403 `MFA_REQUIRED` |

- Contexto propagado por `AsyncLocalStorage` (`RequestContext`): `correlationId`, `traceparent`, `actor { type, userId, membershipId }`, `tenantId`, `sessionIdHash` (SHA-256 do id de sessão do BFF — liga a auditoria da API à sessão sem expor o cookie), `authTime`, `amr` (POL-14), `ip`, `userAgent`, `locale`, `timezone`.
- Recurso de outro tenant ou não visível → 404, nunca 403 (DEC-024); a verificação de visibilidade acontece antes de qualquer política.
- **Proxy autenticado (`/api/v1/*`):** o BFF remove `Authorization`, `X-Tenant-Id`, `Cookie` e `X-Forwarded-*` recebidos do cliente e injeta `Authorization` (Bearer), `X-Tenant-Id` (da sessão) e `X-Correlation-Id` (gerado se ausente); a API nunca é exposta à internet (RN-IAM-13, DEC-053). Métodos mutáveis exigem `X-CF-Request: 1` e `Origin`/`Sec-Fetch-Site` da própria origem (RN-IAM-14, DEC-135).

## 6. Troca de tenant

- `POST /api/auth/switch-tenant` reaproveita a sessão existente (`sid`): só `activeTenantId`/`membershipId` são substituídos — sem novo cookie, sem PKCE/Authentik (RN-IAM-66).
- Só lista/aceita vínculos `usable`: `TenantMembership.status = ACTIVE`, não expirado, e `Tenant.status` que permita acesso (RN-IAM-65, DEC-132). Tenant em `OFFBOARDING` só é selecionável por `ADMIN_ORGAO`/`AUDITOR`, resultando em sessão `readOnly = true` (RN-IAM-67); `PROVISIONING`/`SUSPENDED`/`DEACTIVATED` nunca aparecem como `usable` para usuários comuns (RN-IAM-68).
- Se o tenant de destino exigir MFA (`security.mfaPolicy`) e a sessão não tiver o `amr` correspondente, a troca é suspensa até o *step-up* (§9) ser concluído (RN-IAM-69).
- Trocar para o tenant já ativo é *no-op* idempotente (RN-IAM-70). Toda troca efetiva gera auditoria `auth.tenant_switch` com `fromTenantId`/`toTenantId`, IP e user-agent (RN-IAM-71); o front invalida o cache de consultas do tenant anterior antes de buscar dados do novo, para impedir renderização cruzada (RN-IAM-72).

## 7. Logout e expiração

- `POST /api/auth/logout` encerra a sessão local (remove o registro no Redis e o cookie) **e** inicia o *RP-initiated logout* no Authentik (DEC-131): o navegador é redirecionado ao *end-session* do IdP, encerrando também a sessão global do Authentik na mesma operação — logout local e global não são rotas separadas. Exigido por `POST` para que logout forçado por terceiros não seja possível (security.md §7).
- **Encerramento por mudança de vínculo:** ao consumir `MembershipSuspended`, `MembershipRevoked` ou `MembershipExpired`, o worker encerra apenas as sessões cujo `activeTenantId` é o do evento, gravando `auth.session_end` com o motivo correspondente; sessões em outras instituições continuam. O efeito de acesso é imediato porque a API revalida o vínculo em toda requisição (DEC-132); o consumidor é idempotente por `eventId` (RN-IAM-27).
- **Auditoria:** `auth.session_end` para `LOGOUT`, `SESSION_LIMIT` e encerramentos por vínculo; `auth.session_expired` para `IDLE`, `ABSOLUTE` e `REFRESH_FAILED` (RN-IAM-28, ver §4).
- Logout explícito com rascunho não sincronizado exige confirmação; ao sair, o shell limpa o cache de consultas (TanStack Query), os rascunhos locais do usuário e o `sessionStorage` (RN-IAM-31).

## 8. Recuperação de senha

- `GET /api/auth/forgot-password` é rota **pública** do BFF que apenas redireciona (302) ao *flow* de recuperação do Authentik; não recebe nem repassa e-mail, senha ou identificador de usuário (RN-IAM-34, US-089).
- Fluxo inteiramente hospedado no Authentik, com identidade visual do ContrataFlow (DEC-130): o ContrataFlow apenas encaminha o usuário e o recebe de volta no login ao final. Nenhuma senha ou token de redefinição transita ou é persistido pela aplicação ou pela API.
- Mensagens genéricas quanto à existência da conta (RN-IAM-18/35); a página não exibe nome nem dado de nenhuma instituição (DEC-012).
- Política de senha (mínimo 12 caracteres, rejeita senhas presentes em bases de vazamentos conhecidos) é responsabilidade exclusiva da configuração do Authentik — o ContrataFlow não define, valida nem armazena senhas (RN-IAM-36).
- O link de redefinição é de uso único e sua posse não autentica no ContrataFlow — só permite trocar a senha no IdP (RN-IAM-37).
- Segue o limite de 20 req/min por IP de `/api/auth/*` e responde `Cache-Control: no-store` (RN-IAM-38).

## 9. MFA e step-up

- **Fatores** no Authentik: TOTP e WebAuthn (chaves de segurança/passkeys); códigos de recuperação estáticos do Authentik como contingência; SMS não é aceito (DEC-133, security.md §4).
- **Política por tenant** `security.mfaPolicy`: `NONE` | `ADMINS` (padrão — obrigatório para quem tem permissão `HIGH`) | `ALL` (DEC-133, POL-14). Com `NONE`, o `amr` nunca é verificado; com `ADMINS`, só quando a permissão exercida tem `riskLevel = HIGH`; com `ALL`, toda requisição autenticada exige MFA desde o primeiro acesso (RN-IAM-39).
- **Verificação:** o claim `amr` (ou claim customizada via *property mapping*) é checado no pipeline de contexto a cada requisição sujeita à política vigente; ausência do fator → 403 `MFA_REQUIRED` + auditoria `auth.mfa_required` (RN-IAM-40).
- **Step-up:** `GET /api/auth/step-up` preserva `returnTo` (mesma validação do login, §3), força a etapa de MFA sem repetir a senha e, ao concluir, substitui o access/refresh token da sessão existente — sem novo login completo (RN-IAM-41). Segue o limite de 20 req/min por IP e responde `Cache-Control: no-store` (RN-IAM-45).
- Alterações em `security.mfaPolicy` (`TenantSettingsChanged`) invalidam o cache de permissões efetivas imediatamente; sessões abertas são avaliadas pela nova política na próxima requisição (RN-IAM-42).
- **Reset administrativo** (`USR-13` — `POST /users/{userId}/mfa-reset`): exige `USER_MANAGE`; não pode ser sobre o próprio vínculo do administrador (autoproteção, mesmo espírito de POL-16); remove os fatores no Authentik via API administrativa, forçando novo *enrollment*; gera auditoria `SECURITY` (RN-IAM-43). Quando o próprio administrador perde o fator e não há outro admin no tenant, a via é o acesso de suporte da plataforma mediante chamado e confirmação da instituição (§12) — nunca autoatendimento só com e-mail (security.md §4).
- Operadores da plataforma: MFA **sempre** obrigatório, preferencialmente WebAuthn (security.md §4).
- O ContrataFlow não armazena segredos de MFA; só lê, via `/me`, se a sessão comprova o fator — derivado do `amr`, sem detalhar o dispositivo (RN-IAM-44).

## 10. Convite de usuário e ativação do vínculo

- Convidar exige `USER_INVITE`; reaproveita o `User` global pelo `email` (único) ou cria um novo; se o `User` não tiver `authentikUserId`, a API o provisiona no Authentik via `AuthentikAdminClient` (sem senha — a pessoa a define no próprio Authentik) (RN-IAM-46).
- `TenantMembership.inviteTokenHash` é o SHA-256 de um token opaco gerado por CSPRNG, nunca persistido em claro; `inviteExpiresAt = now + 7 dias`, fixo no MVP 1 e não configurável por tenant (RN-IAM-47; `entities.md`).
- `MEMBERSHIP_ALREADY_EXISTS` (409) se já existir `TenantMembership` em `INVITED`, `ACTIVE` ou `SUSPENDED` para `(tenant, usuário/e-mail)`; reenvio (`USR-04`) substitui token e expiração sem criar novo vínculo; cancelamento (`USR-05`) só é permitido em `INVITED` (RN-IAM-48).
- Aceite (`USR-06`) exige usuário autenticado (login prévio no Authentik, inclusive definição de senha) cujo `User.email` corresponda ao do convite; valida `inviteTokenHash` e `inviteExpiresAt > now`; ativa o vínculo (`status = ACTIVE`, `activatedAt = now`) em transação única (RN-IAM-49).
- `INVITATION_EXPIRED` (410) quando `inviteExpiresAt ≤ now`; `INVITATION_INVALID` (404) quando o token não corresponde a nenhum hash pendente (inexistente, já aceito ou cancelado) — sem revelar qual causa se aplica (RN-IAM-50).
- Lotação (`MembershipDepartment`) e perfil inicial (`RoleAssignment`), quando informados no convite, são gravados junto com o `TenantMembership` em `INVITED`, mas só produzem efeito de acesso quando o vínculo estiver `ACTIVE` (RN-IAM-51).
- Convite para vínculo `EXTERNAL` exige `expiresAt` (≤ `security.externalMembershipMaxDays`, padrão 180 dias); para `INTERNAL`, `expiresAt` permanece nulo (RN-IAM-52).
- Reenvio (`USR-04`) limitado a 5 vezes por convite, com intervalo mínimo de 1 min entre tentativas (RN-IAM-53).

## 11. CSRF e cabeçalhos de segurança

Detalhado em [security.md §7](security.md#7-cors-e-csrf) e [§8](security.md#8-cabeçalhos-de-segurança-csp-e-ip-do-cliente) (DEC-135); resumo aplicado à autenticação:

- Cookie `SameSite=Lax` + header obrigatório `X-CF-Request: 1` em métodos mutáveis + `Sec-Fetch-Site: same-origin` (ou `Origin` = `APP_BASE_URL`) + prefixo `__Host-` (impede *cookie tossing* por subdomínio).
- Login CSRF coberto pelo `state` vinculado ao cookie de transação (§3); logout exigido por `POST` (§7).
- Falha de CSRF → 403 `CSRF_REJECTED` respondido pelo BFF (security.md §7).
- Respostas de `/api/auth/*` levam `Cache-Control: no-store` e os cabeçalhos de DEC-135 (CSP com nonce, HSTS, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `frame-ancestors 'none'`) (RN-IAM-19).
- O CSP único do BFF inclui `form-action` para `https://auth.<domínio>` porque o logout por formulário termina em redirecionamento ao *end-session* do Authentik (navegadores aplicam `form-action` a redirecionamentos).
- IP do cliente: o BFF confia apenas no último salto de `X-Forwarded-For` adicionado pelo ALB e o repassa à API; alimenta rate limit, sessão e `AuditLog.ip` (security.md §8).

## 12. Acesso de suporte da plataforma (DEC-139)

- Operadores da plataforma não têm acesso a dados de tenants por padrão.
- Operador com `PLATFORM_SUPPORT_ACCESS` (MFA obrigatório) registra o chamado e solicita acesso a um tenant; é criado vínculo `EXTERNAL` temporário (validade ≤ 72 h) com perfil restrito (padrão `SOMENTE_LEITURA`; perfis com permissão `HIGH` vedados por POL-15).
- Auditoria `support.access_grant` com o número do chamado, gravada **no tenant** com `actorType = PLATFORM_OPERATOR`, visível e notificada ao administrador da instituição; ações do operador carregam `actorType = PLATFORM_OPERATOR` (e `onBehalfOfUserId` quando aplicável).
- Expiração automática (job `maintenance`/`MembershipExpired`) ou revogação antecipada (`support.access_revoke`); sessões do operador nesse tenant são encerradas.
- Proposta†: configuração de tenant para exigir aprovação prévia do administrador antes da concessão.

## 13. Observabilidade

Eventos de auditoria `auth.*`:

| Evento | Quando | Campos principais |
|---|---|---|
| `auth.session_start` | Login concluído (§3) | `sessionIdHash`, IP, user-agent, `selection`, `firstLogin`, `amr` |
| `auth.session_end` | Logout, limite de sessões ou encerramento por vínculo (§7) | motivo (`LOGOUT`, `SESSION_LIMIT`, `MEMBERSHIP_*`) |
| `auth.session_expired` | Ociosidade, duração absoluta ou falha de renovação (§4) | motivo (`IDLE`, `ABSOLUTE`, `REFRESH_FAILED`) |
| `auth.mfa_required` | Ação exige MFA e a sessão não tem o `amr` (§9) | permissão exigida, `riskLevel` |
| `auth.tenant_switch` | Troca de instituição ativa (§6) | `fromTenantId`, `toTenantId`, IP, user-agent |

- Suporte: `support.access_grant`, `support.access_revoke` (§12).
- `sessionIdHash` (SHA-256 do id de sessão do BFF) liga o `AuditLog` da API à sessão sem expor o cookie (`RequestContext`, §5).
- Logs seguros (DEC-138): proibido logar tokens, cookies, senhas ou CPF; e-mails mascarados (`j***@dominio.gov.br`); redação automática no pino (`redact`).

## 14. Falhas e degradação

- **Redis de sessões indisponível** → o BFF responde 503 `DEPENDENCY_UNAVAILABLE` em todas as rotas autenticadas; a interface mostra indisponibilidade (nunca "sessão expirada") e preserva rascunhos locais (RN-IAM-33, DEC-131).
- **Authentik indisponível na renovação de token:** falha transitória segue com o access token ainda válido; sem token válido → 503 `DEPENDENCY_UNAVAILABLE` com sessão preservada; falha definitiva (`invalid_grant`) encerra a sessão (RN-IAM-26).
- O Redis de sessões é logicamente — de preferência fisicamente — separado do Redis de cache/idempotência/filas: a degradação deste último não derruba sessões, só degrada cache e rate limit sem perder consistência (CA-T-07, DEC-131).
- JWKS: cache de 10 min na API, com renovação forçada ao ver `kid` desconhecido (limitada a 1×/30 s), para resistir à rotação de chaves no Authentik sem sobrecarregar o IdP (RN-IAM-05).

## 15. Rotas do BFF

Não fazem parte da API NestJS; implementadas em `apps/web/src/app/api/auth/[action]/route.ts` (api.md §3.1):

| Rota | Método | Descrição | Story |
|---|---|---|---|
| `/api/auth/login` | GET | Inicia o Authorization Code + PKCE; aceita `returnTo` | US-087 |
| `/api/auth/callback` | GET | Recebe o retorno do Authentik, troca `code` por tokens e cria a sessão | US-087 |
| `/api/auth/session` | GET | Consulta a sessão atual; suporta modo *keepalive* sem renovar ociosidade | US-087 / US-088 |
| `/api/auth/logout` | POST | Encerra a sessão local e inicia o *RP-initiated logout* no Authentik | US-088 |
| `/api/auth/switch-tenant` | POST | Troca a instituição ativa da sessão | US-093 |
| `/api/auth/step-up` | GET | Força reautenticação de MFA sem exigir novo login completo | US-090 |
| `/api/auth/forgot-password` | GET | Redireciona (302) ao *flow* de recuperação de senha do Authentik | US-089 |

## 16. Referências

- DEC-012, DEC-053, DEC-130, DEC-131, DEC-132, DEC-133, DEC-135, DEC-138, DEC-139 — [decisions.md](decisions.md).
- [security.md](security.md) §3 (autenticação), §4 (MFA), §7 (CORS/CSRF), §8 (cabeçalhos), §22 (suporte da plataforma).
- [architecture.md](architecture.md) §3.2 (componentes e containers), §4 (estrutura de `apps/web`), §6.1–6.2 (contexto de requisição e guards).
- [permissions.md](../mvp-01/permissions.md) POL-14 (MFA), POL-15 (externos), POL-16 (autoproteção).
- [entities.md](../mvp-01/entities.md) (`User`, `TenantMembership`, chaves `security.*` §6).
- [api.md](../mvp-01/api.md) §3.1 (rotas do BFF), USR-13 (reset de MFA), §2.1 (códigos de erro).
- US-087 a US-091, US-093 — `docs/backlog/story-087-oidc-login-bff.md` e seguintes.
- [ADR-003](../adr/adr-003-authentication.md).
