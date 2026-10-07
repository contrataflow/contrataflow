---
id: US-096
title: "Atribuir perfis com escopo e vigência"
epic: EP-016
feature: FT-053
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-091, US-094]
modules: [access, identity]
screens: [SCR-029]
endpoints: [ROL-09, ROL-10, ROL-11, ROL-12]
permissions: [ROLE_VIEW, USER_VIEW, ROLE_ASSIGN]
events: [RoleAssigned, RoleRevoked]
---

# US-096 — Atribuir perfis com escopo e vigência

## Título
Atribuir perfis com escopo e vigência

## Descrição
**Como** administrador do órgão (ou gestor com `ROLE_ASSIGN`), **quero** atribuir e revogar perfis a um vínculo definindo o escopo (`TENANT`, `ORGANIZATION`, `DEPARTMENT` ou `OWN_DEPARTMENTS`) e, quando necessário, a vigência, **para** conceder exatamente o acesso necessário a cada pessoa, sem acúmulo de privilégios nem perfis esquecidos.

A atribuição (`RoleAssignment`) liga um vínculo (`TenantMembership`) a um perfil (`Role`) dentro de um escopo e período de validade; várias atribuições podem coexistir por vínculo. A tela de usuário (SCR-029) lista, adiciona e revoga atribuições; a API aplica anti-escalonamento (POL-13), restrição a vínculos externos (POL-15), proteção do último administrador (POL-12) e autoproteção (POL-16).

## Contexto
- US-094 semeia os 15 perfis padrão e US-095 permite editá-los; esta story é o elo final do RBAC — ligar perfil, vínculo, escopo e vigência — e fornece os dados que o motor de autorização (US-097) usa para calcular permissões efetivas.
- Hoje, nos órgãos, o acesso é combinado a cargos informais ("quem é do setor de compras vê tudo"); o modelo de escopo (DEC-134) permite restringir por órgão ou unidade sem precisar criar um perfil por combinação.
- O convite (US-091) pode gravar um `RoleAssignment` inicial ainda com o vínculo `INVITED`; esta story cobre a gestão contínua — adicionar, listar e revogar atribuições a qualquer momento.
- Vínculos `EXTERNAL` (consultoria, auditoria externa — TCE) têm regra adicional (POL-15): só recebem perfis com `allowExternalAssignment = true`.

## Objetivo
Permitir que um administrador conceda ou revogue um perfil com escopo e vigência em menos de 30 segundos, com 100% das atribuições sujeitas a anti-escalonamento, restrição de vínculos externos e proteção contra bloqueio do tenant, e com efeito imediato no cache de permissões.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) quando detentor de `ROLE_ASSIGN`; titular de secretaria atribuindo dentro do próprio escopo.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `ROLE_ASSIGN` (US-097).
- Existe o vínculo (`TenantMembership`) de destino, ativo (US-091/US-092).
- Existe o perfil (`Role`) ativo no tenant (US-094/US-095).

## Fluxo principal
1. Na tela do usuário (SCR-029, `/admin/usuarios/[userId]`), o administrador abre a aba **"Perfis e acessos"**, que lista (`ROL-10`) as atribuições ativas (perfil, escopo, vigência, quem concedeu).
2. Clica em **"Atribuir perfil"**; o sistema abre o formulário com **Perfil** (`ROL-02`, apenas perfis ativos), **Escopo** e, condicionalmente, **Órgão** ou **Unidade** (com "Incluir subárvore"), além de **Vigência** (início padrão hoje; término opcional).
3. Preenche e confirma. O front valida com `assignRoleSchema` (Zod) e envia `POST /api/v1/users/{userId}/role-assignments` com `Idempotency-Key`.
4. A API, em transação com `app.tenant_id`: valida o corpo e resolve `membershipId`; autoriza `ROLE_ASSIGN` e aplica POL-13 e, se externo, POL-15; verifica ausência de atribuição ativa idêntica; insere `RoleAssignment`; grava `AuditLog` `role.assign`; publica `RoleAssigned` no outbox; confirma.
5. `PermissionCacheInvalidator` consome `RoleAssigned` e remove a chave de cache de permissões efetivas do vínculo.
6. A API responde **201**; o front invalida a lista e exibe "Perfil atribuído".
7. Para revogar, o administrador clica em **"Revogar"**, informa motivo (opcional) e confirma; `POST /api/v1/role-assignments/{id}/revoke` aplica POL-12/POL-16, grava `revokedAt/revokedById/revocationReason`, audita `role.revoke`, publica `RoleRevoked` e responde **200**.

## Fluxos alternativos
- **FA-01 — Escopo `ORGANIZATION`/`DEPARTMENT`:** o formulário exibe o seletor correspondente (órgão ou unidade em árvore, "Incluir subárvore" marcado por padrão); `TENANT`/`OWN_DEPARTMENTS` não exibem seletor adicional.
- **FA-02 — Vigência futura:** `validFrom` no futuro é aceito; a atribuição só concede permissões quando `now ≥ validFrom`.
- **FA-03 — Vínculo externo:** ao atribuir a um vínculo `EXTERNAL`, o seletor mostra habilitados apenas os perfis com `allowExternalAssignment = true`; os demais aparecem desabilitados com tooltip explicativo.
- **FA-04 — Última atribuição administrativa:** revogar a última atribuição `ADMIN_ORGAO`/`TENANT` ativa do tenant é bloqueado, sugerindo atribuir outro administrador antes.
- **FA-05 — Autoproteção:** ao tentar revogar sua própria última atribuição administrativa, o front avisa sem chamar a API.
- **FA-06 — Atribuição vinda do convite:** o `RoleAssignment` gravado ainda em `INVITED` (US-091) aparece normalmente na lista após a ativação do vínculo.

## Regras de negócio
- **RN-IAM-89** — Campos obrigatórios: `membershipId` (resolvido pelo `userId`), `roleId`, `scopeType`. `scopeOrganizationId` obrigatório e exclusivo se `ORGANIZATION`; `scopeDepartmentId` obrigatório e exclusivo se `DEPARTMENT`; nenhum dos dois em `TENANT`/`OWN_DEPARTMENTS`. `includeSubtree` padrão `true` para `DEPARTMENT`/`OWN_DEPARTMENTS`.
- **RN-IAM-90** — `roleId` deve referenciar perfil `isActive = true` do tenant; `membershipId` deve estar `ACTIVE` e não expirado. Referência inexistente/outro tenant → `REFERENCE_NOT_FOUND`; vínculo inativo → `MEMBERSHIP_INACTIVE`.
- **RN-IAM-91** — POL-13 (anti-escalonamento): o ator só pode atribuir perfil cujas permissões já possua, em escopo igual ou mais amplo; usuário com `ADMIN_ORGAO` está isento. Violação → `PRIVILEGE_ESCALATION_FORBIDDEN` (403).
- **RN-IAM-92** — POL-15 (externos): vínculo `EXTERNAL` só recebe perfil com `allowExternalAssignment = true`; perfil com permissão `HIGH` e `allowExternalAssignment = false` → `EXTERNAL_HIGH_RISK_ROLE` (422).
- **RN-IAM-93** — `validFrom` padrão `now()`; `validUntil`, se informado, deve ser `> validFrom`; para vínculo `EXTERNAL`, `validUntil` não pode exceder `TenantMembership.expiresAt`.
- **RN-IAM-94** — Não pode existir mais de uma atribuição ativa com o mesmo `(membershipId, roleId, scopeType, scopeOrganizationId, scopeDepartmentId)` → `ROLE_ASSIGNMENT_ALREADY_EXISTS` (409).
- **RN-IAM-95** — Revogação (`ROL-12`) grava `revokedAt`, `revokedById`, `revocationReason` (opcional); a atribuição deixa de contar em `EffectivePermissions` e em POL-12/16, mas permanece no histórico.
- **RN-IAM-96** — POL-12 (anti-bloqueio): revogar atribuição `ADMIN_ORGAO`/`TENANT` só é permitido se restar ≥ 1 outro vínculo `ACTIVE` com atribuição ativa de `ADMIN_ORGAO`/`TENANT`; senão `LAST_ADMIN_REQUIRED` (409).
- **RN-IAM-97** — POL-16 (autoproteção): o próprio usuário não pode revogar sua última atribuição com permissões administrativas; API responde `PERMISSION_DENIED` (`reasonCode = POL-16`).
- **RN-IAM-98** — `ROLE_ASSIGN` é `riskLevel = HIGH`: exige MFA satisfeito quando `security.mfaPolicy ∈ {ADMINS, ALL}` (POL-14); sem MFA → `MFA_REQUIRED` (403).
- **RN-IAM-99** — No commit, publica-se `RoleAssigned`/`RoleRevoked`; `PermissionCacheInvalidator` invalida imediatamente (`DEL`, idempotente) a chave `cf:{env}:t:{tenantId}:access:eff:{membershipId}`, sem esperar o TTL de 5 min.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Perfil | `roleId` | seleção | Sim | perfil ativo do tenant; RN-IAM-90 | — |
| Escopo | `scopeType` | seleção (`ScopeType`) | Sim | enum; RN-IAM-89 | `TENANT` |
| Órgão | `scopeOrganizationId` | seleção | Condicional (`ORGANIZATION`) | órgão ativo | — |
| Unidade | `scopeDepartmentId` | seleção em árvore | Condicional (`DEPARTMENT`) | unidade ativa | — |
| Incluir subárvore | `includeSubtree` | interruptor | Não | `DEPARTMENT`/`OWN_DEPARTMENTS` | `true` |
| Vigência início | `validFrom` | data/hora | Não | RN-IAM-93 | agora |
| Vigência término | `validUntil` | data/hora | Não | `> validFrom`; RN-IAM-93 | — |
| Motivo (revogação) | `revocationReason` | texto longo | Não | até 500 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Perfil/escopo obrigatórios ausentes | Front + API (Zod) | "Selecione o perfil e o escopo." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | Órgão/unidade ausente para o escopo informado | Front + API | "Informe o {campo} para este escopo." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-03 | Referência inexistente/inativa/outro tenant | API | "Selecione um {campo} válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | `validUntil` ≤ `validFrom` ou excede validade do vínculo externo | Front + API | "A vigência final deve ser posterior ao início e não pode superar a validade do vínculo." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-05 | Anti-escalonamento (POL-13) | API | "Você não pode atribuir um perfil com permissões que não possui." | `PRIVILEGE_ESCALATION_FORBIDDEN` |
| V-06 | Perfil de risco para vínculo externo (POL-15) | API | "Este perfil não pode ser atribuído a um vínculo externo." | `EXTERNAL_HIGH_RISK_ROLE` |
| V-07 | Atribuição duplicada ativa | API | "Este perfil já está atribuído neste escopo." | `ROLE_ASSIGNMENT_ALREADY_EXISTS` |
| V-08 | Revogar último `ADMIN_ORGAO` (POL-12) | API | "É preciso manter ao menos um administrador ativo." | `LAST_ADMIN_REQUIRED` |
| V-09 | Autoproteção (POL-16) | API | "Você não pode remover seu próprio último perfil administrativo." | `PERMISSION_DENIED` |
| V-10 | MFA não satisfeito (POL-14) | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` |

## Permissões
- **Permissão:** `ROLE_ASSIGN` (risco `H`) para atribuir/revogar; `ROLE_VIEW`/`USER_VIEW` para listar (`ROL-09`/`ROL-10`).
- **Políticas:** POL-12 (anti-bloqueio), POL-13 (anti-escalonamento), POL-14 (MFA), POL-15 (externos), POL-16 (autoproteção).
- **MFA:** exigido quando `security.mfaPolicy ∈ {ADMINS, ALL}`.
- **Sem permissão:** botões "Atribuir perfil"/"Revogar" ocultos; a API responde 403 `PERMISSION_DENIED` e audita `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `RoleAssigned` | `role.assigned` | Commit da atribuição | `roleAssignmentId`, `membershipId`, `roleId`, `scopeType`, `scopeId?`, `validUntil?` |
| `RoleRevoked` | `role.revoked` | Commit da revogação | `roleAssignmentId`, `membershipId`, `roleId` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma no MVP 1; o usuário percebe o novo acesso ao navegar. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Atribuir perfis com escopo e vigência

  Background:
    Given que o usuário "Carla" está autenticada no tenant "Prefeitura A" com o perfil "ADMIN_ORGAO"
    And o vínculo de "Bruno" está "ACTIVE"

  Scenario: [Sucesso] Atribuir perfil com escopo de unidade
    When "Carla" atribuir o perfil "REQUISITANTE" a "Bruno" com escopo "DEPARTMENT" na "Secretaria de Obras"
    Then a atribuição deve ser criada com "validFrom" igual a agora
    And deve gerar o evento "RoleAssigned"
    And deve gerar registro de auditoria "role.assign"
    And o cache de permissões efetivas de "Bruno" deve ser invalidado imediatamente

  Scenario: [Validação] Escopo de órgão sem órgão informado
    When "Carla" tentar atribuir um perfil com escopo "ORGANIZATION" sem informar o órgão
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "CONDITIONAL_REQUIRED" no campo "scopeOrganizationId"

  Scenario: [Permissão] Anti-escalonamento
    Given que "Carla" não possui "ROLE_MANAGE" nem detém o perfil "AUTORIDADE_COMPETENTE"
    When "Carla" tentar atribuir "AUTORIDADE_COMPETENTE" a "Bruno"
    Then a API deve responder 403 com código "PRIVILEGE_ESCALATION_FORBIDDEN"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Vínculo de outro tenant
    Given que "Bruno" não possui vínculo no tenant "Prefeitura A"
    When "Carla" enviar o "userId" de "Bruno" cujo único vínculo é da "Prefeitura B"
    Then a API deve responder 404 com código "USER_NOT_FOUND"
    And a resposta não deve revelar o vínculo de "Bruno" na "Prefeitura B"

  Scenario: [Duplicidade] Atribuição já existente
    Given que "Bruno" já possui "REQUISITANTE" ativo com escopo "TENANT"
    When "Carla" tentar atribuir "REQUISITANTE" a "Bruno" novamente com escopo "TENANT"
    Then a API deve responder 409 com código "ROLE_ASSIGNMENT_ALREADY_EXISTS"

  Scenario: [Concorrência] Duas atribuições idênticas simultâneas
    When duas requisições idênticas de atribuição forem enviadas ao mesmo tempo para "Bruno"
    Then apenas uma deve responder 201
    And a outra deve responder 409 com código "ROLE_ASSIGNMENT_ALREADY_EXISTS"

  Scenario: [Falha de banco] Banco indisponível na atribuição
    Given que o banco de dados fica indisponível durante a transação
    When "Carla" confirmar a atribuição
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma atribuição, auditoria ou evento deve ser persistido

  Scenario: [Falha de integração] Redis indisponível na invalidação de cache
    Given que o Redis de cache está indisponível
    When "Carla" revogar um perfil de "Bruno"
    Then a revogação deve ser persistida e a API deve responder 200
    And deve ser registrado log "warn" "cache.invalidation_unavailable"
    And a próxima leitura de permissões de "Bruno" deve recalcular sem usar cache desatualizado
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo obrigatório ausente | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos |
| Referência inexistente/inativa | 422 | `VALIDATION_ERROR` | "Selecione um {campo} válido." | Recarrega opções |
| Anti-escalonamento | 403 | `PRIVILEGE_ESCALATION_FORBIDDEN` | "Você não pode atribuir permissões que não possui." | Mantém formulário |
| Perfil de risco para externo | 422 | `EXTERNAL_HIGH_RISK_ROLE` | "Este perfil não pode ser atribuído a um vínculo externo." | Desabilita opção |
| Atribuição duplicada | 409 | `ROLE_ASSIGNMENT_ALREADY_EXISTS` | "Este perfil já está atribuído neste escopo." | Destaca atribuição existente |
| Último administrador | 409 | `LAST_ADMIN_REQUIRED` | "É preciso manter ao menos um administrador ativo." | Sugere atribuir outro antes |
| Autoproteção | 403 | `PERMISSION_DENIED` | "Você não pode remover seu próprio último perfil administrativo." | Oculta ação sobre si mesmo |
| MFA pendente | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Dispara step-up |
| Vínculo inativo | 403 | `MEMBERSHIP_INACTIVE` | "Este vínculo não está ativo." | Redireciona para a lista |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente." | Redireciona ao login |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-091 (convite grava atribuição inicial), US-094 (catálogo e perfis padrão). Relacionadas (não bloqueantes): US-095 (edição de perfis), US-097 (consome `RoleAssigned`/`RoleRevoked` para o cache de autorização).
- **Decisões/ADRs:** DEC-134, DEC-012, DEC-133.
- **Configurações:** `security.mfaPolicy`, `security.externalMembershipMaxDays`.
- **Lacunas nas fontes canônicas:** nenhuma (`ROLE_ASSIGNMENT_ALREADY_EXISTS` (409) registrado em api.md §2.2).

## Impacto técnico
Reaproveita o padrão de transação + auditoria + outbox já estabelecido (US-001). A verificação de anti-escalonamento (RN-IAM-91) reutiliza o mesmo cálculo de `EffectivePermissions` que o `AuthorizationService` da US-097 expõe. A invalidação de cache deve ser síncrona ao commit (publicação no outbox na mesma transação), não dependendo do relay para ter efeito perceptível pelo ator que acabou de agir.

## Backend
- **Módulo(s):** `access` (dono); usa `identity` (`TenantMembership`), `audit`, `platform` (`OutboxWriter`, `IdempotencyService`).
- **Casos de uso:** `AssignRoleCommand` → `AssignRoleHandler`; `RevokeRoleAssignmentCommand` → `RevokeRoleAssignmentHandler`.
- **Domínio:** `RoleAssignment.grant(props)` (aplica RN-IAM-89..94); `RoleAssignment.revoke(reason)` (aplica RN-IAM-95..97).
- **Integrações internas:** `AuthorizationService.computeEffectivePermissions` (anti-escalonamento); `PermissionCacheInvalidator`.
- **Transação:** inserção/revogação de `RoleAssignment` + `AuditLog` + evento no outbox, atômicas.

## Frontend
- **Tela(s):** SCR-029 (`/admin/usuarios/[userId]`, aba "Perfis e acessos").
- **Componentes:** `RoleSelect`, `ScopeFieldset` (com `OrganizationSelect`/`DepartmentTreeSelect` condicionais), `DateRangeFields`, `RoleAssignmentList`, `ConfirmRevokeDialog`.
- **Estados:** loading (skeleton da lista), vazio ("Nenhum perfil atribuído"), erro, sucesso (toast).
- **Acessibilidade e responsividade:** formulário em modal acessível por teclado (foco inicial no campo Perfil); lista responsiva em cartões < 768 px.

## Banco de dados
- **Tabelas:** `role_assignments` (leitura e escrita; já criada em entities.md §4).
- **Migrações:** nenhuma nova (reaproveita a tabela definida na US-094/US-095).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, membership_id, role_id, scope_type, COALESCE(scope_organization_id,…), COALESCE(scope_department_id,…)) WHERE revoked_at IS NULL`; check de coerência de escopo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ROL-09 | GET | `/roles/{id}/assignments` | — | `200 { data: [RoleAssignment] }` | 200, 403, 404 |
| ROL-10 | GET | `/users/{userId}/role-assignments` | — | `200 { data: [RoleAssignment] }` | 200, 403, 404 |
| ROL-11 | POST | `/users/{userId}/role-assignments` | `{ roleId, scopeType, scopeOrganizationId?, scopeDepartmentId?, includeSubtree?, validFrom?, validUntil? }` + `Idempotency-Key` | `201 { data: RoleAssignment }` | 201, 403, 404, 409, 422 |
| ROL-12 | POST | `/role-assignments/{id}/revoke` | `{ reason? }` + `If-Match` | `200 { data: RoleAssignment }` | 200, 403, 404, 409, 412 |

## Logs
- `info` `role.assignment_created` / `role.assignment_revoked` — `roleAssignmentId`, `membershipId`, `roleId`, `scopeType`, `correlationId`.
- `warn` `cache.invalidation_unavailable` — quando o Redis falhar na invalidação.
- `error` `role.assignment_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** `revocationReason` em nível acima de `debug`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `role.assign` | `ACCESS` | Commit da atribuição | `metadata`: `roleId`, `scopeType`, `scopeOrganizationId?`, `scopeDepartmentId?`, `validFrom`, `validUntil?` |
| `role.revoke` | `ACCESS` | Commit da revogação | `metadata`: `roleId`, `scopeType`, `hasReason` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/política | `reasonCode = ROLE_ASSIGN` ou `POL-12/13/15/16` |

## Testes necessários
- **Unitários:** POL-13 (matriz de escopos), POL-15 (externo + risco), POL-12 (último admin), POL-16 (autoproteção), RN-IAM-93 (vigência × validade do vínculo).
- **Integração (Testcontainers):** unicidade da atribuição ativa; RLS por tenant; invalidação de cache disparada pelo evento.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `If-Match`/`ETag`.
- **RBAC e multi-tenant:** matriz perfil × escopo; `userId` de outro tenant → 404.
- **Concorrência:** duas atribuições idênticas simultâneas → uma 201, outra 409.
- **E2E (Playwright):** atribuir e revogar na SCR-029, incluindo bloqueio por último administrador.
- **Acessibilidade/performance:** axe no modal; p95 < 400 ms para `ROL-11`/`ROL-12`.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] POL-12/13/14/15/16 aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria `role.assign`/`role.revoke` e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de ROL-09..12 compatível com api.md
- [ ] Logs sem dados sensíveis; invalidação de cache coberta por teste
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card) atualizada

## Estimativa
**M** — reaproveita padrões de transação, auditoria e cache já estabelecidos; a complexidade está nas políticas (anti-escalonamento, externos, anti-bloqueio, autoproteção), não em um CRUD extenso.

## Prioridade
**P0** — sem atribuição de perfis, o RBAC semeado (US-094/US-095) não concede acesso a ninguém além do que já constar no convite.
