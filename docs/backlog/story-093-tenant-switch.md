---
id: US-093
title: "Selecionar órgão ativo"
epic: EP-016
feature: FT-052
mvp: 1
priority: P1
estimate: S
status: Especificada
depends_on: [US-087]
modules: [identity]
screens: [SCR-101]
endpoints: [ME-04]     # + rota do BFF /api/auth/switch-tenant (api.md §3.1) e interna /internal/session-events
permissions: []        # capacidade implícita (vínculo ativo) — permissions.md §7
events: []             # ação de sessão no BFF; sem evento de domínio
---

# US-093 — Selecionar órgão ativo

## Título
Selecionar órgão ativo

## Descrição
**Como** usuário com vínculo em mais de uma instituição contratante, **quero** trocar o órgão ativo da minha sessão sem precisar fazer login novamente, **para** trabalhar em cada instituição onde atuo (ex.: consultoria externa) sem confusão sobre qual órgão estou enxergando.

A troca acontece em SCR-101, reaproveitando a lista de vínculos utilizáveis já carregada no login (US-087). Ao confirmar, o BFF atualiza o `activeTenantId` da sessão, o front reseta o cache de dados e a interface passa a refletir a nova instituição.

## Contexto
- DEC-012: a identidade é global; o usuário escolhe um **tenant ativo** por sessão (exibido como "instituição contratante"). SCR-101 já existe desde o login (US-087), quando há mais de um vínculo utilizável.
- Hoje esse fluxo só roda uma vez, no login; esta story adiciona a troca **durante** a sessão, sem logout/login.
- DEC-131/DEC-132: sessão e contexto de requisição vivem no Redis e são resolvidos pelo `X-Tenant-Id` definido pelo BFF a partir da sessão — trocar o tenant ativo é alterar esse campo da sessão, não criar uma nova sessão.

## Objetivo
Permitir a troca de órgão ativo em menos de 3 segundos, sem reautenticação, com o front sempre refletindo dados do tenant correto após a troca (zero vazamento de dados entre tenants na mesma aba).

## Persona
- **Principal:** Usuário com vínculo `EXTERNAL` em múltiplos tenants (ex.: consultoria externa) ou servidor com vínculo em mais de um órgão.
- **Secundárias:** Qualquer usuário autenticado (ação disponível no menu mesmo com um só vínculo, por consistência de interface).

## Pré-condições
- Usuário autenticado (US-087) com sessão válida.
- Usuário possui ao menos um `TenantMembership` `usable` (`ME-04`) diferente do ativo, para a ação ter efeito prático.

## Fluxo principal
1. O usuário abre o seletor de instituição no cabeçalho ou acessa SCR-101 (`/selecionar-orgao`).
2. O front chama `GET /api/v1/me/memberships` (`ME-04`, sem `X-Tenant-Id`) e lista as instituições com `usable = true`, destacando a ativa.
3. O usuário escolhe outra instituição e confirma.
4. O front chama `POST /api/auth/switch-tenant` (BFF) com `{ membershipId }`.
5. O BFF chama a rota interna `POST /internal/session-events` com `{ type: "TENANT_SWITCHED", sessionIdHash, tenantId, selection: "manual" }`; a API revalida que o vínculo é `ACTIVE`/não expirado e o tenant está em status utilizável, e responde `{ user, memberships[], mfaRequired }`.
6. Se `mfaRequired = false`, o BFF atualiza `activeTenantId`/`membershipId` no registro de sessão no Redis, mantendo o mesmo `sid`/cookie.
7. O BFF responde 200 com a nova `activeTenant`; o front limpa todo o cache de consultas do tenant anterior e navega ao Dashboard.
8. A API registra a auditoria `auth.tenant_switch` com o tenant anterior e o novo.

## Fluxos alternativos
- **FA-01 — Tenant de destino exige MFA e a sessão não satisfaz:** a resposta de `/internal/session-events` traz `mfaRequired = true`; o BFF guarda a troca pendente na sessão e responde 403 `MFA_REQUIRED` com `stepUpUrl`, e o front segue ao `/api/auth/step-up` (US-090); ao concluir o step-up, a troca se completa (DEC-075).
- **FA-02 — Tenant em `OFFBOARDING`:** troca permitida apenas para vínculos `ADMIN_ORGAO`/`AUDITOR` (DEC-132); sessão resultante fica com `readOnly = true` (`GET /api/auth/session`), e a interface exibe aviso de somente leitura.
- **FA-03 — Único vínculo:** o seletor mostra a instituição atual sem opção de troca; a ação fica desabilitada.
- **FA-04 — "Usar como padrão":** opção adicional grava `preferences.defaultTenantId` (jsonb livre em `User.preferences`, sem migração) para pré-selecionar essa instituição em logins futuros.

## Regras de negócio
- **RN-IAM-65** — A troca só lista/aceita vínculos `usable` (`TenantMembership.status = ACTIVE`, não expirado, e `Tenant.status` que permita acesso — DEC-132).
- **RN-IAM-66** — A troca reaproveita a sessão existente (`sid`); apenas `activeTenantId`/`membershipId` da sessão são substituídos — não gera novo cookie nem exige PKCE/Authentik novamente.
- **RN-IAM-67** — Tenant em `OFFBOARDING` só é selecionável por vínculos com perfil `ADMIN_ORGAO` ou `AUDITOR`; resultado é sessão `readOnly = true` (DEC-132).
- **RN-IAM-68** — Tenant em `PROVISIONING`/`SUSPENDED`/`DEACTIVATED` nunca aparece como `usable` para usuários comuns (DEC-132).
- **RN-IAM-69** — Se o tenant de destino exigir MFA (`security.mfaPolicy`) e a sessão não tiver o `amr` correspondente, a troca é suspensa até o *step-up* (US-090) ser concluído.
- **RN-IAM-70** — Trocar para o tenant já ativo é um no-op idempotente: não gera novo registro de auditoria nem reseta desnecessariamente o cache do front.
- **RN-IAM-71** — Toda troca efetiva gera auditoria `auth.tenant_switch` com `fromTenantId`/`toTenantId`, IP e `userAgent`.
- **RN-IAM-72** — Ao trocar, o front invalida todo o cache de consultas do tenant anterior (chaves prefixadas `['t', tenantId, …]`) antes de buscar dados do novo tenant, para impedir renderização cruzada.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Instituição de destino | `membershipId` | seleção (lista `ME-04`) | Sim | `usable = true` | — |
| Usar como padrão | `setAsDefault` | interruptor | Não | FA-04 | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `membershipId` ausente/não é do usuário | API | "Selecione uma instituição válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-02 | Vínculo não `usable` (status/expirado/tenant indisponível) | API | "Você não tem mais acesso a esta instituição." | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` |

## Permissões
- **Permissão:** nenhuma — capacidade implícita de qualquer vínculo ativo (permissions.md §7).
- **Políticas:** DEC-132 (status do tenant) e POL-14/MFA (step-up) quando o destino exigir.
- **MFA:** condicional ao perfil do usuário no tenant de destino e à `security.mfaPolicy` daquele tenant (não do tenant de origem).
- **Sem permissão:** não aplicável; qualquer vínculo listado em `ME-04` pode ser escolhido.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio (ação de sessão no BFF); efeito registrado via auditoria `auth.tenant_switch`. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: events.md §6 não define tipo para troca de tenant. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Selecionar órgão ativo

  Background:
    Given que "Helena" está autenticada com sessão ativa no tenant "Prefeitura A"
    And "Helena" também tem vínculo "ACTIVE" na "Prefeitura B"

  Scenario: [Sucesso] Trocar para outro órgão
    When "Helena" selecionar "Prefeitura B" no seletor de instituição
    Then a sessão deve passar a ter "activeTenant" igual a "Prefeitura B"
    And o front deve limpar o cache de consultas da "Prefeitura A"
    And deve gerar registro de auditoria "auth.tenant_switch" com "toTenantId" da "Prefeitura B"

  Scenario: [Validação] Instituição que não pertence ao usuário
    When a API receber "POST /api/auth/switch-tenant" com um "membershipId" que não pertence a "Helena"
    Then deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"

  Scenario: [Permissão] Vínculo suspenso não aparece como opção
    Given que o vínculo de "Helena" na "Prefeitura B" está "SUSPENDED"
    When "Helena" abrir o seletor de instituição
    Then "Prefeitura B" não deve aparecer como opção selecionável
    And uma tentativa direta à API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Tenant incorreto] Tenant suspenso pela plataforma
    Given que a "Prefeitura B" está com status "SUSPENDED"
    When "Helena" tentar trocar para "Prefeitura B"
    Then a API deve responder 403 com código "TENANT_SUSPENDED"
    And a sessão deve permanecer na "Prefeitura A"

  Scenario: [Duplicidade] Trocar para o órgão já ativo
    When "Helena" selecionar novamente "Prefeitura A", já ativa
    Then a operação deve ser tratada como no-op
    And nenhum novo registro de auditoria "auth.tenant_switch" deve ser gravado

  Scenario: [Concorrência] Dois cliques de troca em sequência rápida
    When "Helena" clicar duas vezes em "Trocar para Prefeitura B" antes da primeira resposta
    Then a sessão deve terminar consistente com "Prefeitura B" ativa
    And nenhuma corrupção do registro de sessão deve ocorrer

  Scenario: [Falha de banco] Banco indisponível ao revalidar o vínculo
    Given que o banco de dados está indisponível
    When "Helena" tentar trocar para "Prefeitura B"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a sessão deve permanecer na "Prefeitura A"

  Scenario: [Falha de integração] Tenant de destino exige MFA não satisfeito
    Given que a "Prefeitura B" tem "security.mfaPolicy" igual a "ALL" e a sessão de "Helena" não tem MFA
    When "Helena" tentar trocar para "Prefeitura B"
    Then o BFF deve redirecionar para "/api/auth/step-up"
    And a troca só deve se completar após o step-up ser concluído
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `membershipId` inválido/de outro usuário | 422 | `VALIDATION_ERROR` | "Selecione uma instituição válida." | Recarrega a lista |
| Vínculo não `ACTIVE`/expirado | 403 | `MEMBERSHIP_INACTIVE` | "Você não tem mais acesso a esta instituição." | Remove da lista |
| Tenant não `ACTIVE` | 403 | `TENANT_SUSPENDED` | "Esta instituição está indisponível no momento." | Mantém sessão atual |
| MFA exigido pelo destino | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Redireciona ao step-up |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível trocar agora. Tente novamente." | Mantém sessão atual |

## Dependências
- **Stories:** US-087 (sessão e rota `/internal/session-events` proposta nessa story de login); US-090 (step-up de MFA); US-091 (origem dos vínculos `EXTERNAL`).
- **Decisões/ADRs:** DEC-012, DEC-131, DEC-132.
- **Configurações:** `security.mfaPolicy` (do tenant de destino).
- **Lacunas nas fontes canônicas:** nenhuma — reaproveita a rota `/internal/session-events` já prevista (não implementada) em `story-087-oidc-login-bff.md`.

## Impacto técnico
- Primeira implementação real da rota `/internal/session-events` (marcada "proposto" em US-087); deve tratar `SESSION_STARTED` (login) e `TENANT_SWITCHED` (esta story) no mesmo contrato.
- A atualização da sessão no Redis deve ser atômica (um único `HSET`/script Lua) para não deixar `activeTenantId` e `membershipId` inconsistentes entre si sob concorrência (FA de dois cliques).

## Backend
- **Módulo(s):** `identity` (BFF) + `access`/`platform` (API, validação de vínculo e contexto).
- **Casos de uso:** `SwitchActiveTenantCommand` (BFF) → `ResolveSessionEventCommand` (API, `/internal/session-events`).
- **Integrações internas:** reaproveita `cf_user_memberships` (US-087) para revalidar vínculos utilizáveis.

## Frontend
- **Tela(s):** SCR-101 (`/selecionar-orgao`) e seletor global no cabeçalho.
- **Componentes:** `TenantSwitcherMenu`, `TenantList` (reaproveita o componente de SCR-101 do login).
- **Estados:** loading no botão durante a troca; erro inline se falhar; sucesso navega e mostra toast "Agora você está em {tenant}".

## Banco de dados
- **Tabelas:** nenhuma tabela nova; leitura de `tenant_memberships` (via `cf_user_memberships`).
- **Migrações:** nenhuma.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ME-04 | GET | `/api/v1/me/memberships` | sem `X-Tenant-Id` | `200 { data: [{ membershipId, tenant{id,name,status}, type, status, usable }] }` | 200, 401 |
| BFF | POST | `/api/auth/switch-tenant` | `{ membershipId, setAsDefault? }` | `200 { data: { activeTenant, readOnly, … } }` (visão pública da sessão) ou 403 `MFA_REQUIRED` com `stepUpUrl` (o front segue ao step-up — DEC-075) | 200, 400, 401, 403, 422, 503 |
| interno | POST | `/internal/session-events` | `{ type: "TENANT_SWITCHED", sessionIdHash, membershipId, tenantId?, setAsDefault?, fromTenantId, selection }` | `200 { data: { user, memberships[], activeMembership, defaultTenantId, mfaRequired } }` | 200, 403, 422, 503 |

## Logs
- `info` `auth.tenant_switch` — `userId`, `fromTenantId`, `toTenantId`, `durationMs`.
- `warn` `auth.tenant_switch_rejected` — motivo (`MEMBERSHIP_INACTIVE`, `TENANT_SUSPENDED`, `MFA_REQUIRED`).
- **Nunca logar:** conteúdo do cookie de sessão, tokens.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `auth.tenant_switch` | `ACCESS` | Troca efetiva de tenant ativo | `metadata`: `fromTenantId`, `toTenantId`, `selection`, IP, `userAgent` |

## Testes necessários
- **Unitários:** resolução de vínculo `usable`; idempotência do no-op (RN-IAM-70).
- **Integração (Testcontainers + Redis):** atualização atômica da sessão; revalidação de status de tenant/vínculo.
- **API/contrato:** respostas conforme api.md; redirecionamento ao step-up.
- **RBAC e multi-tenant:** troca para tenant sem vínculo → 403; nenhum dado do tenant anterior residual após a troca.
- **Concorrência:** dois cliques simultâneos não corrompem a sessão.
- **E2E (Playwright):** login com dois vínculos → troca → dados exibidos são do novo tenant.
- **Acessibilidade/performance:** troca completa em p95 < 1 s.

## Definition of Done
- [ ] Cenários Gherkin automatizados e passando no CI
- [ ] Rota `/internal/session-events` implementada para `TENANT_SWITCHED`
- [ ] Auditoria `auth.tenant_switch` verificada em teste
- [ ] Teste de isolamento de tenant (sem resíduo de cache do tenant anterior)
- [ ] Contrato do BFF documentado
- [ ] Logs sem dados sensíveis
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**S** — reaproveita sessão, listagem (`ME-04`) e o contrato já proposto em US-087; não cria entidades novas.

## Prioridade
**P1** — importante para consultorias externas e servidores multi-órgão, mas não bloqueia o fluxo de um único órgão do MVP 1.
