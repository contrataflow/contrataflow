---
id: US-185
title: "Reativar perfil desativado (DT-13)"
epic: EP-029
feature: FT-085
mvp: 2
priority: P2
estimate: S
status: Especificada
depends_on: [US-095]
modules: [access, audit, platform]
screens: [SCR-030, SCR-031]
endpoints: [ROL-13, ROL-02, ROL-04]
permissions: [ROLE_MANAGE, ROLE_VIEW]
events: [RoleReactivated]
---

# US-185 — Reativar perfil desativado (DT-13)

## Título
Reativar perfil desativado

## Descrição
**Como** administrador do órgão (`ADMIN_ORGAO`) com `ROLE_MANAGE`, **quero** reativar um perfil que foi desativado, vendo antes o resumo das permissões que ele concede e de quantas atribuições voltam a valer, **para** devolver o acesso a quem o tinha sem recriar o perfil, sem duplicá-lo e sem perder o histórico de atribuições.

No MVP 1 só era possível **desativar** (ROL-08) e, para voltar a usar um perfil inativo, duplicá-lo (ROL-07), o que gera um perfil novo, sem as atribuições antigas e com outro histórico. Esta story acrescenta a operação inversa, `POST /roles/{id}/reactivate` (ROL-13), par de ROL-08: o perfil volta a `isActive = true` com as **mesmas permissões e as mesmas atribuições** de antes, e o cache de permissões dos portadores é invalidado. A operação é feita na lista de perfis (SCR-030) e no detalhe (SCR-031), com confirmação explícita.

## Contexto
- DT-13 (DEC-209): "reativação de perfil desativado (hoje só duplicar — ROL-07)". A US-095 deixou a reativação fora do escopo (FA-07 e a lacuna registrada em "Dependências") e a RN-IAM-84 já garante que desativar **preserva** as `RoleAssignment`, que só deixam de conceder permissão enquanto o perfil está inativo. Reativar é, portanto, trocar o estado do perfil; nenhuma atribuição é recriada.
- RN-PLAT-15 (FT-085): reativar exige `ROLE_MANAGE`; o perfil volta com as mesmas permissões e atribuições, sem alterar restrições, e o cache de permissões dos portadores é invalidado. Risco apontado na feature: devolver permissões antigas a quem não deveria — mitigado por confirmação com resumo das permissões e dos portadores, auditoria `role.reactivate` e pelas regras desta story (POL-13, MFA).
- DEC-134: `Role`/`RolePermission` por tenant; o cache de permissões efetivas (Redis, TTL 5 min, RN-IAM-102) é invalidado pelo `PermissionCacheInvalidator` nos eventos `role.*`; o evento novo `RoleReactivated` (`role.reactivated`, consumidor `C`) cai no mesmo roteamento.
- `Role.deactivatedAt` e `Role.deactivatedById` entram em entities.md §5.13 (MVP 2) e passam a ser gravados por ROL-08; na reativação voltam a nulo e o histórico fica na auditoria (`role.deactivate`, `role.reactivate`).
- Perfis semeados (`isSystem = true`, DEC-035) e personalizados seguem a mesma regra. O `ADMIN_ORGAO` nunca fica inativo (POL-12 bloqueia a desativação), logo nunca é alvo da reativação.

## Objetivo
Permitir que o `ADMIN_ORGAO` reative um perfil desativado em até 1 minuto, com 100% das reativações precedidas da confirmação com o resumo de permissões e portadores, 0 concessão de permissão que o ator não possua (POL-13) e efeito nas permissões efetivas dos portadores em até 5 minutos (TTL do cache) no pior caso e imediato com o relay do outbox saudável.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, escopo `TENANT`), com `ROLE_MANAGE`.
- **Secundárias:** Auditor (`AUDITOR`), que vê a reativação na auditoria (`AUDIT_VIEW`) e a lista de perfis em leitura (`ROLE_VIEW`); gestor de contratações com `ROLE_MANAGE` concedido pelo tenant, sujeito à POL-13.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `ROLE_MANAGE` e, se `security.mfaPolicy` for `ADMINS` ou `ALL`, sessão com MFA (POL-14).
- O perfil existe no tenant e está **inativo** (`isActive = false`).
- Os endpoints ROL-02, ROL-04 e ROL-09 da US-095/US-096 estão disponíveis (a lista e o detalhe alimentam a confirmação).

## Fluxo principal
1. Na lista de perfis (SCR-030, `/admin/perfis`), o administrador marca o filtro **"Mostrar desativados"** (`isActive=false` em ROL-02). A lista mostra, para cada perfil inativo, "Desativado em {data} por {nome}" (`deactivatedAt`, `deactivatedBy`) e a ação **"Reativar"**.
2. Ele aciona "Reativar" na linha, ou abre o detalhe do perfil (SCR-031, `/admin/perfis/[roleId]`), que exibe a faixa "Este perfil está desativado" com o botão **"Reativar perfil"**.
3. O front chama ROL-04 do perfil. Para um perfil inativo a resposta traz, além das permissões, `meta.reactivationPreview` (`permissionsCount`, `highRiskPermissionsCount`, `restorableAssignmentsCount`, `externalMembershipsCount`).
4. O front abre o diálogo **"Reativar {nome do perfil}?"** com: (a) as permissões agrupadas por módulo, com `RiskLevelBadge` e destaque nas de risco alto; (b) "{N} atribuições voltam a valer" com link para a lista de portadores (ROL-09); (c) o aviso "As pessoas que tinham este perfil voltam a ter estas permissões imediatamente."; (d) a caixa **"Entendo e quero reativar"**, que habilita o botão "Reativar perfil".
5. Ao confirmar, o front envia `POST /roles/{id}/reactivate` (ROL-13) com `If-Match` e `{ confirmReactivate: true }`.
6. A API, em uma transação: autoriza `ROLE_MANAGE`; confere que o perfil está inativo; aplica a POL-13 e, se for o caso, a exigência de MFA (RN-PLAT-243, RN-PLAT-248); confere unicidade de nome e chave; define `isActive = true`, `deactivatedAt = null`, `deactivatedById = null` e incrementa `version`; grava a auditoria `role.reactivate`; publica `RoleReactivated`; confirma.
7. A API responde **200** com o perfil, `ETag` novo e `meta.restoredAssignmentsCount`; o front mostra "Perfil reativado. {N} atribuições voltaram a valer." e atualiza a lista.
8. O `PermissionCacheInvalidator` consome `role.reactivated` e remove (`DEL`, idempotente) o cache de permissões efetivas dos vínculos com atribuição do perfil. O perfil volta a aparecer entre os perfis ativos oferecidos pelo ROL-11 (atribuir perfil).

## Fluxos alternativos
- **FA-01 — Perfil com permissões de risco alto:** o diálogo destaca "{n} permissões de risco alto"; a operação segue a política de MFA do tenant (`ROLE_MANAGE` é risco `H`, POL-14).
- **FA-02 — Atribuições que não voltam:** atribuições revogadas, vencidas (`validUntil` no passado), ainda não vigentes ou de vínculos que não estão `ACTIVE` continuam sem efeito; o diálogo conta só as que realmente voltam (`restorableAssignmentsCount`) e informa "As atribuições revogadas ou vencidas não voltam."
- **FA-03 — Perfil sem portadores:** `restorableAssignmentsCount = 0`; o diálogo diz "Nenhuma atribuição será reativada; atribua o perfil a alguém depois." e a reativação segue normalmente.
- **FA-04 — Perfil que permite vínculo externo:** com `allowExternalAssignment = true` e permissão de risco alto, a reativação exige sessão com MFA mesmo com `security.mfaPolicy = NONE` (RN-PLAT-248); sem MFA → `403 MFA_REQUIRED` e o front abre o *step-up*.
- **FA-05 — Ator sem as permissões do perfil:** sem `ADMIN_ORGAO` com escopo `TENANT`, o ator só reativa perfil cujas permissões ele próprio possui; senão `403 PRIVILEGE_ESCALATION_FORBIDDEN` (RN-PLAT-243) e a UI desabilita "Reativar" com a dica "Você não possui todas as permissões deste perfil."
- **FA-06 — Perfil já ativo:** se outra pessoa o reativou antes, a chamada com `If-Match` atual responde `409 INVALID_STATE` ("O perfil já está ativo.") e a UI recarrega a lista.
- **FA-07 — Nome ou chave em uso por outro perfil:** a API responde `409 ROLE_ALREADY_EXISTS` e nada muda (RN-PLAT-245); a UI orienta a renomear o perfil inativo em ROL-05 e tentar de novo.
- **FA-08 — Edição concorrente:** `If-Match` divergente → `412 VERSION_CONFLICT`; a UI recarrega o perfil e refaz a confirmação com os números atuais.
- **FA-09 — Perfil desativado no MVP 1:** perfis desativados antes desta story não têm `deactivatedAt`/`deactivatedById` (ou têm, se a migração os recuperou da auditoria — RN-PLAT-251); a lista mostra "Desativado" sem data quando nulos.

## Regras de negócio
- **RN-PLAT-240** — Reativar (ROL-13) exige `ROLE_MANAGE` e perfil com `isActive = false` (RN-PLAT-15). Perfil já ativo → `409 INVALID_STATE`; perfil inexistente ou de outro tenant → `404 ROLE_NOT_FOUND`. A operação vale para perfis `isSystem` e personalizados; o `ADMIN_ORGAO` nunca está inativo (POL-12) e a chamada sobre ele cai em `INVALID_STATE`.
- **RN-PLAT-241** — Efeito: `isActive = true`; `deactivatedAt` e `deactivatedById` voltam a nulo; `version` é incrementada. Permissões (`RolePermission`), `allowExternalAssignment`, `key`, `name`, `isSystem` e `isProtected` **não mudam**; nenhuma restrição do perfil é alterada (RN-PLAT-15).
- **RN-PLAT-242** — Atribuições: nenhuma `RoleAssignment` é criada, alterada ou apagada. As que estavam vigentes (não revogadas, dentro de `validFrom`/`validUntil`, de vínculo `ACTIVE`) voltam a conceder permissão assim que o cache é invalidado; as demais seguem sem efeito. O estado "inativo" do perfil nunca apagou atribuições (RN-IAM-84).
- **RN-PLAT-243** — POL-13 aplicada à reativação: reativar devolve poderes a todos os portadores, então equivale a uma concessão. Um ator sem atribuição vigente de `ADMIN_ORGAO` com escopo `TENANT` só reativa o perfil se possuir **todas** as permissões dele (efetivas da requisição, em qualquer escopo); senão `403 PRIVILEGE_ESCALATION_FORBIDDEN` com `access.denied`. A isenção do `ADMIN_ORGAO` é a da RN-IAM-81.
- **RN-PLAT-244** — Confirmação explícita: o corpo exige `confirmReactivate: true`; ausente ou falso → `422 VALIDATION_ERROR` (`REQUIRED` em `confirmReactivate`). O resumo mostrado ao usuário (permissões, contagem de portadores) vem de ROL-04 (`meta.reactivationPreview`) e de ROL-09, calculados na hora, no mesmo critério que a API usará ao reativar.
- **RN-PLAT-245** — Unicidade: antes de reativar, a API confere que nenhum outro perfil do tenant ocupa o mesmo `name` (sem diferença de caixa) ou a mesma `key` entre os perfis ativos; conflito → `409 ROLE_ALREADY_EXISTS`. Com o índice único atual `(tenant_id, lower(name))`, que cobre também perfis inativos, o conflito não ocorre no uso normal; a conferência é defensiva (dados legados, importações, índice futuro apenas para perfis ativos).
- **RN-PLAT-246** — Concorrência: `If-Match` obrigatório (ausente → `428 PRECONDITION_REQUIRED`; divergente → `412 VERSION_CONFLICT` com `currentVersion`). Sem `Idempotency-Key`, como em ROL-08: o segundo envio com a versão antiga recebe 412 e, com a versão nova, `409 INVALID_STATE`.
- **RN-PLAT-247** — Atomicidade: atualização do perfil, auditoria `role.reactivate` (categoria `SECURITY`) e evento `RoleReactivated` (`roleId`, `key`) em uma transação, com `app.tenant_id`. A invalidação do cache é assíncrona pelo outbox (RN-IAM-88): com o relay indisponível, o perfil fica reativado e o efeito nas permissões efetivas aparece em até 5 minutos (TTL do cache), como em `RoleUpdated`.
- **RN-PLAT-248** — MFA: `ROLE_MANAGE` é risco `H` e segue `security.mfaPolicy` (POL-14). Além disso, reativar um perfil com `allowExternalAssignment = true` e ao menos uma permissão de risco `HIGH` exige sessão com MFA independentemente da política (mesma lógica da RN-IAM-83, porque vínculos externos voltam a ter poderes); sem MFA → `403 MFA_REQUIRED`.
- **RN-PLAT-249** — Sem aviso aos portadores: a reativação não gera notificação (`ROLE_CHANGED` só dispara em `RoleAssigned`/`RoleRevoked`, US-096), nem entrada na timeline de processo. A rastreabilidade é a auditoria `role.reactivate` e o evento (decisão desta story; ver lacuna 6).
- **RN-PLAT-250** — Leitura: ROL-02 e ROL-04 passam a devolver `deactivatedAt` e `deactivatedBy { id, name }` (nulos em perfil ativo) e, em ROL-04 de perfil inativo, `meta.reactivationPreview` (RN-PLAT-244). Os campos são aditivos (DEC-108): clientes do MVP 1 continuam funcionando.
- **RN-PLAT-251** — ROL-08 (desativar) passa a gravar `deactivatedAt = agora` e `deactivatedById = ator`, sem outra mudança de contrato. A migração preenche os dois campos dos perfis já inativos a partir do registro mais recente de `role.deactivate` da auditoria quando existir; sem registro, ficam nulos. A reativação limpa os campos.
- **RN-PLAT-252** — Reativar não revalida a matriz: permissões removidas do catálogo ou desativadas pela plataforma entre a desativação e a reativação são ignoradas pelo motor de autorização como em qualquer perfil ativo (US-097); a UI mostra só as permissões vigentes do catálogo.
- **RN-PLAT-253** — Autoproteção: o ator pode reativar um perfil que ele mesmo portaria; não há bloqueio, pois reativar nunca remove acesso (POL-12 e POL-16 não se aplicam).
- **RN-PLAT-254** — O endpoint não aceita `permissions[]`, `name` nem outros campos: o corpo só tem `confirmReactivate`; campo desconhecido → `422 VALIDATION_ERROR` (`UNKNOWN_FIELD`). Para alterar o perfil, usa-se ROL-05/ROL-06 depois de reativado (ou antes, ROL-05, que continua permitido em perfil inativo).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Confirmo a reativação | `confirmReactivate` | booleano | Sim | deve ser `true` (RN-PLAT-244) | caixa do diálogo |
| Versão esperada | cabeçalho `If-Match` | texto (`ETag`) | Sim | RN-PLAT-246 | `ETag` de ROL-04 |
| *(sistema)* Desativado em / por | `deactivatedAt`, `deactivatedById` | timestamptz / uuid | — | RN-PLAT-241, RN-PLAT-251 | ROL-08 |
| *(sistema)* Resumo da reativação | `meta.reactivationPreview` | objeto | — | `permissionsCount`, `highRiskPermissionsCount`, `restorableAssignmentsCount`, `externalMembershipsCount` | ROL-04 |
| *(sistema)* Atribuições restauradas | `meta.restoredAssignmentsCount` | inteiro | — | resposta de ROL-13 | cálculo |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `confirmReactivate` ausente ou falso | Front + API (Zod) | "Confirme a reativação para continuar." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | Perfil já ativo ou `ADMIN_ORGAO` | API | "O perfil já está ativo." | `INVALID_STATE` |
| V-03 | Ator sem as permissões do perfil (POL-13) | API | "Você não pode reativar um perfil com permissões que você mesmo não possui." | `PRIVILEGE_ESCALATION_FORBIDDEN` |
| V-04 | Nome ou chave em uso por outro perfil | API | "Já existe um perfil com esse nome. Renomeie o perfil desativado antes de reativá-lo." | `ROLE_ALREADY_EXISTS` |
| V-05 | Perfil com vínculo externo e permissão de risco alto, sem MFA | API | "Confirme sua identidade para continuar." | `MFA_REQUIRED` |
| V-06 | `If-Match` ausente | API | "Recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` |
| V-07 | `If-Match` divergente | API | "Este perfil foi alterado por outra pessoa. Recarregue para ver a versão atual." | `VERSION_CONFLICT` |
| V-08 | Campo desconhecido no corpo | API (Zod) | "Revise os campos enviados." | `VALIDATION_ERROR` (`UNKNOWN_FIELD`) |

## Permissões
- **Permissão:** `ROLE_MANAGE` (risco `H`, sem escopo de unidade) para ROL-13; `ROLE_VIEW` para ver perfis inativos, `deactivatedBy` e o resumo (ROL-02/ROL-04).
- **Políticas:** POL-13 (RN-PLAT-243), POL-14 (MFA, RN-PLAT-248); POL-12 e POL-16 não se aplicam (reativar não reduz acesso).
- **MFA:** conforme `security.mfaPolicy` (`ADMINS`/`ALL`) e, adicionalmente, no caso da RN-PLAT-248; sem MFA → `403 MFA_REQUIRED` e *step-up* no BFF.
- **Sem permissão:** sem `ROLE_MANAGE`, "Reativar" e "Reativar perfil" ficam ocultos e a API responde `403 PERMISSION_DENIED` com `access.denied` (`reasonCode = ROLE_MANAGE`); sem `ROLE_VIEW`, o item "Perfis" não aparece no menu. Perfil de outro tenant: `404 ROLE_NOT_FOUND`, sem revelar existência.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `RoleReactivated` | `role.reactivated` | Commit de ROL-13 | Payload: `roleId`, `key`. Consumidor `C` (`PermissionCacheInvalidator`, roteamento `role.*`), que invalida o cache dos vínculos com atribuição do perfil |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma | — | Reativar um perfil não notifica os portadores nem o administrador (RN-PLAT-249); o registro está na auditoria e no evento. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Reativar perfil desativado

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Ana" possui o perfil "ADMIN_ORGAO" com escopo "TENANT"
    And o perfil "Fiscal de Obras" está desativado na versão 3 com as permissões "SUPPLIER_VIEW" e "PROCESS_VIEW"
    And "Bruno" e "Eva" têm atribuições vigentes do perfil "Fiscal de Obras"
    And "Carla" tem uma atribuição revogada do perfil "Fiscal de Obras"

  Scenario: [Sucesso] Reativar o perfil com as mesmas permissões e atribuições
    When "Ana" reativar o perfil "Fiscal de Obras" com "confirmReactivate" verdadeiro e "If-Match: \"3\""
    Then a API deve responder 200 com "isActive" verdadeiro e "ETag" igual a "4"
    And "deactivatedAt" e "deactivatedById" devem ser nulos
    And as permissões do perfil devem continuar sendo "SUPPLIER_VIEW" e "PROCESS_VIEW"
    And "meta.restoredAssignmentsCount" deve ser 2
    And deve gerar registro de auditoria "role.reactivate" na categoria "SECURITY"
    And deve gerar o evento "RoleReactivated"

  Scenario: [Sucesso] Os portadores recuperam as permissões e quem foi revogado não
    Given que o perfil foi reativado e o cache de "Bruno" foi invalidado
    When "Bruno" consultar suas permissões efetivas
    Then "Bruno" deve ter "SUPPLIER_VIEW" e "PROCESS_VIEW"
    And "Carla" não deve ter nenhuma permissão do perfil
    And o perfil deve voltar a ser oferecido na atribuição de perfis

  Scenario: [Sucesso] Resumo de confirmação antes de reativar
    When "Ana" abrir o detalhe do perfil desativado
    Then "meta.reactivationPreview" deve trazer "permissionsCount" 2 e "restorableAssignmentsCount" 2
    And o botão "Reativar perfil" deve exigir a caixa "Entendo e quero reativar"

  Scenario: [Sucesso] Perfil semeado também pode ser reativado
    Given que o perfil semeado "COMPRAS" foi desativado
    When "Ana" reativar o perfil "COMPRAS"
    Then a API deve responder 200 e "isSystem" deve continuar verdadeiro

  Scenario: [Validação] Sem confirmação explícita
    When "Ana" enviar a reativação sem "confirmReactivate"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" no campo "confirmReactivate"
    And o perfil deve continuar desativado

  Scenario: [Validação] Perfil já ativo
    Given que "Ana" reativou o perfil e recarregou a página
    When "Ana" enviar a reativação outra vez com o "ETag" novo
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Validação] Nome do perfil em uso por outro perfil ativo
    Given que, por dado legado, outro perfil ativo tem o nome "Fiscal de Obras"
    When "Ana" tentar reativar o perfil desativado de mesmo nome
    Then a API deve responder 409 com código "ROLE_ALREADY_EXISTS"
    And o perfil deve continuar desativado

  Scenario: [Permissão] Sem ROLE_MANAGE
    Given que "Davi" possui apenas "ROLE_VIEW"
    When "Davi" tentar reativar o perfil "Fiscal de Obras"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" igual a "ROLE_MANAGE"
    And o botão "Reativar" não deve aparecer para "Davi"

  Scenario: [Permissão] Anti-escalonamento na reativação
    Given que "Carlos" possui "ROLE_MANAGE" mas não possui "PROCESS_VIEW"
    When "Carlos" tentar reativar o perfil "Fiscal de Obras"
    Then a API deve responder 403 com código "PRIVILEGE_ESCALATION_FORBIDDEN"
    And o perfil deve continuar desativado

  Scenario: [Permissão] Perfil externo com permissão de risco alto exige MFA
    Given que o perfil "Auditor Externo" tem "allowExternalAssignment" e uma permissão de risco "HIGH"
    And "security.mfaPolicy" é "NONE" e a sessão de "Ana" não tem MFA
    When "Ana" tentar reativar o perfil "Auditor Externo"
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Perfil de outro tenant
    Given que o perfil "Fiscal de Obras" desativado pertence ao tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", reativar o perfil com o id desse perfil
    Then a API deve responder 404 com código "ROLE_NOT_FOUND"
    And o perfil de "Prefeitura B" deve continuar desativado

  Scenario: [Duplicidade] Segundo clique com a versão antiga
    Given que "Ana" enviou a reativação com "If-Match: \"3\"" e recebeu 200
    When o front reenviar a mesma requisição com "If-Match: \"3\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And nenhum segundo evento "RoleReactivated" deve ser gerado

  Scenario: [Concorrência] Duas pessoas reativam ao mesmo tempo
    Given que "Ana" e "Marcos" têm "ROLE_MANAGE" e abriram o perfil na versão 3
    When os dois enviarem a reativação com "If-Match: \"3\"" quase simultaneamente
    Then apenas uma reativação deve ser aplicada, avançando para a versão 4
    And a outra deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" igual a 4

  Scenario: [Concorrência] Matriz editada durante a confirmação
    Given que "Ana" abriu o diálogo de reativação na versão 3
    And "Marcos" acrescentou a permissão "CATALOG_MANAGE" ao perfil inativo, avançando para a versão 4
    When "Ana" confirmar a reativação com "If-Match: \"3\""
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And o diálogo deve ser recarregado com o resumo atualizado

  Scenario: [Falha de banco] Banco indisponível ao reativar
    Given que o banco de dados fica indisponível durante a reativação
    When "Ana" tentar reativar o perfil "Fiscal de Obras"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o perfil deve continuar desativado e nenhum evento deve ser gerado

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Ana" reativar o perfil "Fiscal de Obras"
    Then a API deve responder 200 e o perfil deve ficar ativo
    And o evento "RoleReactivated" deve permanecer "PENDING" no outbox até o relay voltar
    And as permissões efetivas dos portadores podem demorar até 5 minutos (TTL do cache) para refletir a reativação

  Scenario: [Falha de integração] Redis indisponível ao invalidar o cache
    Given que o Redis de cache está indisponível
    When "Bruno" consultar suas permissões depois da reativação
    Then a API deve recalcular as permissões sem cache e devolver as do perfil reativado
    And deve registrar log "warn" "authorization.cache_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Confirmação ausente | 422 | `VALIDATION_ERROR` (`REQUIRED`) | "Confirme a reativação para continuar." | Mantém o diálogo aberto |
| Perfil já ativo | 409 | `INVALID_STATE` | "O perfil já está ativo." | Recarrega a lista |
| Nome ou chave em uso | 409 | `ROLE_ALREADY_EXISTS` | "Já existe um perfil com esse nome. Renomeie o perfil desativado antes de reativá-lo." | Oferece "Renomear perfil" |
| Anti-escalonamento | 403 | `PRIVILEGE_ESCALATION_FORBIDDEN` | "Você não pode reativar um perfil com permissões que você mesmo não possui." | Desabilita "Reativar" |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Dispara *step-up* |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar perfis." | Oculta as ações |
| Perfil não encontrado/outro tenant | 404 | `ROLE_NOT_FOUND` | "Perfil não encontrado." | Volta à lista |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega o perfil |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este perfil foi alterado por outra pessoa. Recarregue para ver a versão atual." | Recarrega e refaz o resumo |
| Muitas requisições | 429 | `RATE_LIMITED` | "Muitas tentativas em pouco tempo. Aguarde alguns instantes." | Reabilita após `Retry-After` |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-095 (perfis, ROL-02/04/05/06/07/08, POL-12/13, RN-IAM-84/88; esta story substitui o FA-07 dela). Indiretas: US-096 (atribuições e ROL-09/ROL-11), US-097 (cache de permissões efetivas e `PermissionCacheInvalidator`), US-090 (MFA e *step-up*), US-073 (auditoria).
- **Decisões/ADRs:** DEC-209 (DT-13), DEC-035, DEC-134, DEC-133, DEC-104 (`If-Match`/`ETag`), DEC-108 (mudanças aditivas), DEC-161 (outbox), ADR-009; POL-12, POL-13, POL-14.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. `deactivatedAt`/`deactivatedById` constam em entities.md §5.13 e na FT-085, mas o ROL-08 do MVP 1 não os grava: esta story estende o ROL-08 (RN-PLAT-251) e a migração recupera o histórico da auditoria quando existir; perfis desativados antes ficam sem data se não houver registro.
  2. A FT-085 diz "limpos ou preservados no histórico": adotado **limpar** os campos na reativação e manter o histórico na auditoria (`role.deactivate`/`role.reactivate`) e nos eventos.
  3. `ROL-13` é o ID indicativo (`POST /roles/{id}/reactivate`, par de ROL-08); o `api.md` do MVP 2 o confirma. ROL-09..12 já são da US-096.
  4. A POL-13 não cita a reativação: aplicada por analogia (devolver permissões a portadores é conceder), na linha da RN-IAM-81; confirmar com a segurança do produto.
  5. A exigência de MFA para perfil externo com permissão `HIGH` (RN-PLAT-248) é uma extensão da RN-IAM-83; sem ela, vínculos externos recuperariam poderes sem *step-up*.
  6. **Dúvida de produto:** os portadores devem ser avisados quando o perfil volta (hoje só `RoleAssigned`/`RoleRevoked` geram `ROLE_CHANGED`)? Adotado "não avisar".
  7. A premissa "outro perfil ativo criado depois com o mesmo nome" não ocorre com o índice atual `UNIQUE (tenant_id, lower(name))` (cobre inativos); a conferência da RN-PLAT-245 é defensiva. Se o produto preferir liberar o nome de perfis desativados (índice parcial por `isActive`), a regra passa a ser o caminho comum e a RN-IAM-87 muda.
  8. `meta.reactivationPreview` (ROL-04) e `deactivatedBy` (ROL-02/04) são campos novos do contrato; entram no `api.md` do MVP 2.
  9. Confirmar que o seeder `access.defaultRoles` (`applyToExistingTenants`) não reativa nem sobrescreve perfil semeado desativado por um administrador.

## Impacto técnico
- **Performance:** operação de uma linha de `roles` mais a contagem de atribuições restauráveis; meta p95 < 300 ms para ROL-13 (mesma classe de ROL-06) e < 150 ms para o resumo em ROL-04.
- **Segurança:** é uma superfície de escalonamento, como a gestão de perfis (POL-13, MFA, confirmação explícita, auditoria `SECURITY`); a resposta e os logs não listam as permissões efetivas de outros usuários.
- **Consistência:** invalidação do cache por evento (pior caso 5 min) e fallback sem cache quando o Redis cai (US-097 FA-01).
- **Compatibilidade:** campos novos em ROL-02/ROL-04 são aditivos; ROL-08 continua igual, apenas grava mais dois campos.

## Backend
- **Módulo(s):** `access` (dono: `Role`, `RolePermission`, `RoleAssignment`); usa `audit` (`AuditService`) e `platform` (`OutboxWriter`).
- **Casos de uso:** `ReactivateRoleCommand` (ROL-13); ajustes em `ListRolesQuery`/`GetRoleQuery` (campos e `reactivationPreview`) e em `DeactivateRoleCommand` (grava `deactivatedAt`/`deactivatedById`).
- **Domínio:** `Role.reactivate(actorPermissions, now)` (RN-PLAT-240..245, RN-PLAT-248); `RoleReactivationPreview` (permissões, risco, atribuições restauráveis, vínculos externos).
- **Integrações internas:** `RoleActorResolver` (permissões efetivas do ator — POL-13), `RoleAssignmentCounter` (atribuições restauráveis), `IdentityFacade.mfaPolicy`, `PermissionCacheInvalidator` (consumidor de `role.*`).
- **Transação:** única, com `app.tenant_id`: validação, `UPDATE roles` (com `version` esperada), auditoria e outbox.

## Frontend
- **Tela(s):** SCR-030 (`/admin/perfis`: filtro "Mostrar desativados", coluna "Desativado em/por", ação "Reativar") e SCR-031 (`/admin/perfis/[roleId]`: faixa de perfil inativo e botão "Reativar perfil").
- **Componentes:** `ReactivateRoleDialog`, `RolePermissionSummary` (por módulo, com `RiskLevelBadge`), `InactiveRoleBanner`, `RoleStatusFilter`.
- **Dados:** TanStack Query; a mutação invalida `['t', tenantId, 'roles']`, `['t', tenantId, 'roles', roleId]` e, se o próprio ator for portador, `['t', tenantId, 'me', 'permissions']`.
- **Estados:** carregando o resumo (skeleton), erro com "Tentar novamente", botão com estado de carregamento, caixa de confirmação desmarcada por padrão, sucesso com contagem de atribuições restauradas.
- **Acessibilidade e responsividade:** o diálogo anuncia o resumo por `aria-live`; situação do perfil por texto e ícone, nunca só por cor; confirmação com foco na caixa; diálogo em tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas:** `roles` (escrita), `role_permissions` e `role_assignments` (leitura), `audit_logs`, `outbox_events`.
- **Migrações:** `roles` ganha `deactivated_at timestamptz null` e `deactivated_by_id uuid null` (FK para `users`); preenchimento dos perfis já inativos a partir da auditoria (`role.deactivate`), quando existir.
- **Índices/constraints relevantes:** reaproveita `UNIQUE (tenant_id, key)` e `UNIQUE (tenant_id, lower(name))`; índice `(tenant_id, role_id) WHERE revoked_at IS NULL` em `role_assignments` para a contagem de restauráveis.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ROL-13` | POST | `/api/v1/roles/{id}/reactivate` | `{ confirmReactivate: true }` + `If-Match` | `200 { data: Role, meta: { restoredAssignmentsCount } }` com `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 429, 503 |
| `ROL-02` *(ajuste)* | GET | `/api/v1/roles` | `search?`, `isActive?` | `data[]` ganha `deactivatedAt`, `deactivatedBy { id, name }` | 200, 401, 403 |
| `ROL-04` *(ajuste)* | GET | `/api/v1/roles/{id}` | — | `data` ganha `deactivatedAt`, `deactivatedBy`; perfil inativo traz `meta.reactivationPreview` | 200, 401, 403, 404 |

## Logs
- `info` `role.reactivated` — `roleId`, `key`, `actorId`, `restoredAssignmentsCount`, `correlationId`.
- `warn` `role.permission_cache_invalidation_delayed` — quando o outbox atrasa a publicação além de 30 s (reaproveitado da US-095).
- `error` `role.reactivate_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** a lista de permissões efetivas de outros usuários nem os nomes dos portadores em nível `info`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `role.reactivate` | `SECURITY` | Commit de ROL-13 | `changes`: `isActive` (falso → verdadeiro); `metadata`: `restoredAssignmentsCount`, `permissionsCount`, `previousDeactivatedAt` |
| `role.deactivate` *(ajuste)* | `SECURITY` | Commit de ROL-08 | Sem mudança de conteúdo; `deactivatedAt` e `deactivatedById` passam a constar em `changes` |
| `access.denied` | `ACCESS` | Sem `ROLE_MANAGE` ou violação da POL-13 | `reasonCode` = `ROLE_MANAGE` ou `PRIVILEGE_ESCALATION_FORBIDDEN`, `roleId` |

## Testes necessários
- **Unitários:** `Role.reactivate` (estado, limpeza de `deactivatedAt`/`deactivatedById`, `ADMIN_ORGAO`, perfil já ativo); POL-13 sobre o conjunto de permissões do perfil; `RoleReactivationPreview` (vigentes × revogadas × vencidas × vínculo inativo).
- **Integração (Testcontainers PostgreSQL + Redis):** reativação fim a fim com invalidação do cache pelo `PermissionCacheInvalidator`; portadores recuperam as permissões e revogados não; migração de `deactivated_at` a partir da auditoria; conflito de nome simulado por inserção direta.
- **API/contrato:** ROL-13 e os campos novos de ROL-02/ROL-04 conforme o `api.md`; cabeçalhos `If-Match`/`ETag`; códigos de erro.
- **RBAC e multi-tenant:** `ROLE_MANAGE` × `ROLE_VIEW`; POL-13; MFA do perfil externo; perfil de outro tenant → 404 `ROLE_NOT_FOUND` (suíte `test/tenant-leak`).
- **Concorrência:** duas reativações simultâneas → uma 200 e outra 412; reativação × edição da matriz.
- **E2E (Playwright):** desativar → mostrar desativados → resumo → reativar → portador vê a permissão; *step-up* de MFA.
- **Acessibilidade/performance:** axe no diálogo; ROL-13 com p95 < 300 ms na suíte de performance (endurecimento).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas (POL-13, POL-14) aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria `role.reactivate` e evento `RoleReactivated` verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de ROL-13 e dos ajustes de ROL-02/ROL-04 compatível com o `api.md`
- [ ] Logs sem dados sensíveis; métricas e traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Invalidação do cache de permissões após `RoleReactivated` coberta por teste de integração
- [ ] Migração de `deactivated_at`/`deactivated_by_id` testada com e sem histórico na auditoria

## Estimativa
**S** — o caso de uso é a inversa de ROL-08 e reaproveita as políticas, a auditoria, o outbox e o invalidador de cache da US-095; o esforço está no resumo de confirmação, na POL-13 aplicada à reativação e na migração dos campos de desativação.

## Prioridade
**P2** — débito do MVP 1 (DT-13) com alternativa de contorno (duplicar o perfil); o ganho é preservar atribuições e histórico, sem bloquear outras stories.
