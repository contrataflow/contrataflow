---
id: US-099
title: "Provisionar tenant com dados padrão"
epic: EP-017
feature: FT-055
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-081, US-100]
modules: [tenancy, organization, identity, access, catalog, document, workflow, audit, platform]
screens: [SCR-032, SCR-111]
endpoints: [PLT-01, PLT-02, PLT-03, PLT-04, PLT-05]
permissions: [PLATFORM_TENANT_MANAGE]
events: [TenantProvisioned, TenantActivated, TenantSuspended]
---

# US-099 — Provisionar tenant com dados padrão

## Título
Provisionar tenant com dados padrão

## Descrição
**Como** operador da plataforma responsável pela implantação, **quero** criar uma nova instituição contratante (tenant) com um único comando — API de plataforma ou CLI — já com órgão principal, configurações, catálogos, perfis, tipos de documento, templates, workflows, feriados e o convite do primeiro administrador, **para** entregar ao cliente um ambiente pronto em minutos, de forma repetível, auditada e sem que a plataforma acesse dados de negócio.

O provisionamento executa um **checklist de etapas idempotentes e retomáveis**: cria o `Tenant` em `PROVISIONING`, o órgão principal, as configurações padrão (entities.md §6), executa os **seeders registrados pelos módulos donos** (catálogos — US-104; perfis — US-094; tipos de documento — US-061; biblioteca de templates — US-110; workflows — US-042; feriados — US-106), cria o vínculo do primeiro `ADMIN_ORGAO` (escopo `TENANT`) e, ao final, ativa o tenant e envia o convite. Se uma etapa falhar, o que já foi concluído é preservado e a reexecução continua de onde parou, sem duplicar dados. A story também entrega o ciclo de vida operado pela plataforma (suspensão, reativação, encerramento e desativação — DEC-132) e o assistente de implantação exibido ao administrador no primeiro acesso à estrutura.

## Contexto
- Onboarding (product-overview §11.3): a fase "Provisionamento" é automatizada e termina com o tenant `ACTIVE`; meta A6 — primeiro processo em até 10 dias úteis após o contrato.
- DEC-011 (tenant × órgão × unidade), DEC-012 (na interface o tenant é a **instituição contratante**), DEC-027 (catálogo-base copiado no provisionamento), DEC-035 (perfis semeados), DEC-015 e entities.md §7 (dois workflows semeados: padrão e contratação direta — art. 72), DEC-031 (feriados), DEC-059 (flags).
- DEC-132: `PROVISIONING`/`SUSPENDED` só atendem a plataforma; `OFFBOARDING` permite somente leitura e exportação a `ADMIN_ORGAO`/`AUDITOR`; `DEACTIVATED` não tem acesso. DEC-139: operadores não acessam dados de tenants por padrão.
- DT-07 (risks-and-decisions §6): não há UI de backoffice no MVP 1 — a CLI é o canal principal; a API de plataforma (PLT-01..05) atende automações internas e o backoffice do MVP 2. RM-07: seeds versionados e reaplicáveis.
- Cada módulo é dono do conteúdo que semeia (DEC-040/DEC-041): `tenancy` apenas orquestra, por um registro de seeders, sem importar infraestrutura de outros módulos.

## Objetivo
Provisionar um tenant completo em até 2 minutos (p95; típico < 30 s) com 100% das etapas do checklist em `DONE`, sem SQL manual, com reexecução sem duplicidades, auditoria `actorType = PLATFORM_OPERATOR` visível ao cliente e mudanças de status efetivas em todas as instâncias em até 60 s.

## Persona
- **Principal:** Operador da plataforma — Implantação/Sucesso do Cliente (`User.isPlatformOperator = true`, permissão de plataforma `PLATFORM_TENANT_MANAGE`, MFA obrigatório).
- **Secundárias:** Administrador do órgão (P01, perfil `ADMIN_ORGAO`, escopo `TENANT`) — recebe o convite e usa o assistente; Controle Interno e Auditor (P09/P13) — consultam a auditoria das ações da plataforma sobre o tenant (DEC-139).

## Pré-condições
- US-100 concluída (`TenantTransaction`, `SystemDbService`, RLS, papéis de banco e cache de status) e US-081 (Prisma e migrações).
- API: operador com `isPlatformOperator = true` e sessão com MFA. CLI: execução no ambiente de operação (tarefa avulsa na rede privada, papel IAM assumido com MFA) com `--operator <e-mail>` de um operador.
- Seeders registrados (os ausentes não aparecem no checklist): `tenancy.settings` (US-103), `catalog.items` (US-104), `access.defaultRoles` (US-094), `document.systemTypes` (US-061), `document.templateLibrary` (US-110), `workflow.seedWorkflows` (US-042), `catalog.holidays` (US-106); convite por `IdentityFacade` (US-091) e e-mail (US-112).
- Dados da fase 0 do onboarding: nome, tipo, UF e código IBGE do ente; nome, sigla, CNPJ e tipo do órgão principal; nome e e-mail do primeiro administrador.

## Fluxo principal
1. O operador preenche `tenant.json` (schema `provisionTenantSchema`, `packages/validation`) e executa `pnpm cf tenant:provision --file tenant.json --operator carla@contrataflow.com.br` (ou envia `POST /api/v1/platform/tenants` com `Idempotency-Key`).
2. O sistema valida o corpo (Zod) e RN-TEN-01..04 e autoriza: operador com MFA (API) ou operador válido no ambiente de operação (CLI).
3. **`tenancy.tenantRecord`** — via `SystemDbService` (US-100): insere `Tenant` com `status = PROVISIONING`, `plan = STANDARD`, fuso e idioma.
4. **`tenancy.primaryOrganization`** — em `TenantTransaction` do novo tenant: cria a `Organization` principal (regras de US-101) e define `tenants.primaryOrganizationId` pela função controlada `cf_set_primary_organization` (US-100).
5. **`tenancy.settings`** — grava todas as chaves do registro (entities.md §6 e flags `features.*` registradas) com o valor padrão.
6. **Seeders**, em ordem topológica de `dependsOn`, cada um em sua `TenantTransaction`: `catalog.items` (84 itens de sistema) → `access.defaultRoles` (15 perfis com a matriz de permissions.md; `ADMIN_ORGAO` `isProtected`; `allowExternalAssignment = true` em `AUDITOR` e `CONSULTOR_EXTERNO`) → `document.systemTypes` (11 tipos) → `document.templateLibrary` (template v1 publicado por tipo) → `workflow.seedWorkflows` ("Fase preparatória — Lei 14.133/2021", `isDefault`, e "Contratação direta — Lei 14.133/2021, art. 72") → `catalog.holidays` (ano corrente e seguinte).
7. **`identity.firstAdmin`** — via `IdentityFacade` (US-091): reutiliza ou cria o `User` pelo e-mail; cria `TenantMembership` `INTERNAL` `INVITED` (ainda sem token) e `RoleAssignment` `ADMIN_ORGAO` no escopo `TENANT`.
8. **`tenancy.complete`** — recalcula o checklist (`verify()` de cada etapa); com tudo `DONE`, grava a auditoria `tenant.provision` e o evento `TenantProvisioned` na mesma transação.
9. **Ativação** (padrão `activate = true`): `PROVISIONING → ACTIVE`, `activatedAt = now`, auditoria `tenant.activate` e evento `TenantActivated`; após o commit, `IdentityFacade.dispatchInvitation` gera o token (validade de 7 dias contada do envio) e enfileira o e-mail de convite.
10. A API responde **201** com o tenant e o checklist (`Location: /api/v1/platform/tenants/{id}`); a CLI imprime a tabela do checklist (ou JSON com `--json`) e termina com código 0.
11. O administrador aceita o convite (SCR-102, US-091) e, ao abrir a estrutura (SCR-032), vê o **assistente de implantação** (FA-09).

## Fluxos alternativos
- **FA-01 — Retomar provisionamento interrompido:** reexecutar o comando com o mesmo `slug`, CNPJ do órgão principal e e-mail do administrador, com o tenant em `PROVISIONING`, executa só as etapas `PENDING`; dados divergentes → 409 `TENANT_SLUG_TAKEN`. Na API, a mesma `Idempotency-Key` após erro 5xx também retoma (respostas 5xx não são memorizadas).
- **FA-02 — Provisionar sem ativar:** `--no-activate` / `"activate": false` mantém `PROVISIONING` com checklist completo (ex.: revisão de dados); `PLT-04`/`tenant:activate` ativa depois, exige checklist completo (senão 409 `INVALID_STATE` com as etapas pendentes) e então envia o convite.
- **FA-03 — Consultar:** `PLT-02` (filtros `status`, `stateCode`, `q` por nome/slug; paginação) e `PLT-03` (dados, `ETag` e checklist calculado); na CLI, `tenant:status <slug>`. Só metadados e contagens — nunca dados de negócio.
- **FA-04 — Suspender:** `PLT-05`/`tenant:suspend <slug> --reason "…"` muda `ACTIVE → SUSPENDED` (RN-TEN-11).
- **FA-05 — Reativar:** `PLT-04` sobre `SUSPENDED` (ou `OFFBOARDING`, revertendo o encerramento) volta a `ACTIVE`, limpa `suspendedAt`/`suspensionReason` e preserva o `activatedAt` original.
- **FA-06 — Encerrar e desativar (somente CLI no MVP 1):** `tenant:offboard <slug> --reason "…"` (`ACTIVE|SUSPENDED → OFFBOARDING`) e, ao fim do prazo contratual de encerramento, `tenant:deactivate <slug> --confirm-slug <slug>` (`OFFBOARDING|PROVISIONING → DEACTIVATED`).
- **FA-07 — Reenviar convite do primeiro administrador:** `tenant:resend-invite <slug>` repete `dispatchInvitation` quando o envio falhou ou expirou sem aceite (o administrador ainda não existe para usar `USR-04`).
- **FA-08 — Aplicar seeders novos a tenant existente:** `tenant:seed <slug> [--seeder <chave>] [--dry-run]` executa apenas seeders com `applyToExistingTenants = true` ainda pendentes, sem alterar dados existentes (RM-07).
- **FA-09 — Assistente de implantação:** com o órgão selecionado sem unidades, SCR-032 mostra "Monte a estrutura mínima" com as sugestões de entities.md §7 ("Gabinete"; "Secretaria de Administração" → "Setor de Compras"), editáveis; ao confirmar, cria as unidades por `DEP-03` (uma `Idempotency-Key` por unidade) e exibe "Primeiros passos": convidar usuários (SCR-029), definir titulares (SCR-032), indicar a unidade de Compras na etapa `PESQUISA_PRECOS` (SCR-034), revisar numeração (SCR-041), feriados locais (SCR-110) e templates (SCR-033).
- **FA-10 — Administrador com identidade existente:** se o e-mail já pertence a um `User` (ex.: consultor com vínculo em outro tenant), reutiliza a identidade e cria apenas o novo vínculo; nada do outro tenant é lido.
- **FA-11 — Simulação:** `--dry-run` valida o arquivo e mostra o plano (etapas e quantidades) sem gravar.

## Regras de negócio
- **RN-TEN-01** — `slug`: 3–63 caracteres, `^[a-z0-9](-?[a-z0-9])*$`; proibidos os reservados `admin`, `api`, `app`, `auth`, `www`, `static`, `assets`, `status`, `docs`, `ajuda`, `suporte`, `plataforma`, `platform`, `contrataflow`, `entrar`, `login`, `mail`, `cdn`, `demo`, `teste`, `homolog`, `staging` (reserva para eventuais domínios próprios por tenant — DEC-141).
- **RN-TEN-02** — `slug` é único na plataforma **para sempre** (inclusive de tenants `DEACTIVATED`) → 409 `TENANT_SLUG_TAKEN`; imutável após a ativação (trigger de banco).
- **RN-TEN-03** — Dados do ente: `type` (`TenantType`); `stateCode` na lista de UFs; `ibgeCityCode` com 7 dígitos e prefixo da UF (obrigatório para `MUNICIPALITY` e `CITY_COUNCIL`); `timezone` na allowlist de fusos IANA brasileiros (padrão `America/Sao_Paulo`); `locale = pt-BR`; `plan = STANDARD`, sem limites aplicados (PEND-17).
- **RN-TEN-04** — Órgão principal com as regras de US-101 (CNPJ com DV, inclusive alfanumérico; sigla única); administrador com e-mail válido (≤ 254, normalizado em minúsculas) e nome (3–200 caracteres).
- **RN-TEN-05** — Cada etapa é **idempotente por chave natural** (slug; CNPJ do órgão; `(tenant, key)` da configuração; `(catalogType, code)`; `key` do perfil; `code` do tipo; nome do template por tipo; `key` do workflow; `(date, name)` do feriado; e-mail do usuário), roda em transação própria e nunca sobrescreve dado existente.
- **RN-TEN-06** — O checklist é **calculado**: cada etapa expõe `verify()` → `DONE`/`PENDING` com contagens. Ativar a partir de `PROVISIONING` exige todas as etapas `DONE`.
- **RN-TEN-07** — Seeders são registrados pelos módulos donos (token `TENANT_SEEDERS`) com `key`, `version`, `dependsOn` e `applyToExistingTenants`; ordem topológica; ciclo ou dependência ausente impede o boot. As versões aplicadas constam da auditoria `tenant.provision`.
- **RN-TEN-08** — O primeiro administrador recebe vínculo `INTERNAL` com `ADMIN_ORGAO` no escopo `TENANT`; o convite **só é enviado com o tenant `ACTIVE`** e sua validade conta a partir do envio.
- **RN-TEN-09** — Transições de `TenantStatus`: `PROVISIONING → ACTIVE` (fim do provisionamento ou PLT-04); `ACTIVE → SUSPENDED` (PLT-05); `SUSPENDED → ACTIVE` (PLT-04); `ACTIVE|SUSPENDED → OFFBOARDING` (CLI); `OFFBOARDING → ACTIVE` (PLT-04, reversão); `OFFBOARDING|PROVISIONING → DEACTIVATED` (CLI). `DEACTIVATED` é final; qualquer outra → 409 `INVALID_STATE`.
- **RN-TEN-10** — Acesso por status (DEC-132): `ACTIVE` normal; `PROVISIONING`, `SUSPENDED` e `DEACTIVATED` → toda requisição de usuário recebe 403 `TENANT_SUSPENDED`; `OFFBOARDING` → somente leitura e rotas de exportação/download (lista em US-100) para vínculos com `ADMIN_ORGAO` ou `AUDITOR` vigente; comandos e demais usuários → 403 `TENANT_SUSPENDED`. O vínculo é verificado antes do status (US-100), para não revelar a situação do tenant a quem não tem vínculo.
- **RN-TEN-11** — Suspensão exige motivo (10–1.000 caracteres), gravado em `suspensionReason` e nunca exibido aos usuários do tenant. Efeito em ≤ 60 s em todas as instâncias; sessões não são destruídas — cada requisição é recusada. A suspensão do tenant **não pausa** prazos de etapas (diferente da suspensão de processo — DEC-031); na reativação o job `deadlines` processa os atrasos acumulados.
- **RN-TEN-12** — Jobs de tenant fora de `ACTIVE` terminam sem efeito (`skipped`), exceto `audit-seal` (sempre) e `document-render` em `OFFBOARDING` (exportação de PDFs); o relay do outbox não depende do status.
- **RN-TEN-13** — Encerramento exige motivo; desativação exige confirmação digitada do slug. Nenhuma das duas exclui dados (DEC-034, PEND-07): vínculos, documentos e auditoria são mantidos e o slug permanece reservado.
- **RN-TEN-14** — O provisionamento **nunca** cria vínculo para o operador (DEC-139); acesso de suporte é outro fluxo.
- **RN-TEN-15** — Ações de plataforma são auditadas com `actorType = PLATFORM_OPERATOR` **no tenant afetado** (visíveis ao administrador com `AUDIT_VIEW`); falhas anteriores à criação do tenant (ex.: slug em uso) vão para a auditoria de plataforma (`tenantId` nulo).
- **RN-TEN-16** — Idempotência: na API, `Idempotency-Key` com escopo `plataforma + operador + método + rota` (DEC-105); além disso, mesmo slug com mesmos CNPJ e e-mail em `PROVISIONING` é retomada (FA-01).
- **RN-TEN-17** — CLI e API usam os **mesmos casos de uso** de `tenancy/application`; a CLI roda em processo, só na rede privada, e registra `metadata.channel = CLI` e o identificador da execução.
- **RN-TEN-18** — O assistente de implantação aparece só para quem tem `DEPARTMENT_MANAGE` e quando o órgão selecionado não tem unidades; nada é criado sem confirmação; sugestões editáveis e descartáveis.

## Campos
| Campo (CLI/API) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Identificador | `slug` | texto | Sim | RN-TEN-01/02 | sugerido a partir do nome |
| Nome de exibição | `name` | texto | Sim | 3–200; exibido como instituição contratante | — |
| Denominação oficial | `legalName` | texto | Não | até 250 | — |
| Tipo de ente | `type` | `TenantType` | Sim | enum | — |
| UF | `stateCode` | char(2) | Sim | lista de UFs | — |
| Código IBGE | `ibgeCityCode` | char(7) | Condicional | RN-TEN-03 | — |
| Fuso horário | `timezone` | IANA | Não | allowlist BR | `America/Sao_Paulo` |
| Idioma / plano | `locale` / `plan` | texto | Não | `pt-BR` / PEND-17 | `pt-BR` / `STANDARD` |
| Órgão principal | `primaryOrganization.{name, shortName, cnpj, type, email?, phone?}` | objeto | Sim | regras de US-101 | — |
| Primeiro administrador | `firstAdmin.{email, name}` | objeto | Sim | RN-TEN-04 | — |
| Ativar ao final | `activate` | booleano | Não | — | `true` |
| Motivo (suspender/encerrar) | `reason` → `suspensionReason` | texto | Sim na ação | 10–1.000 | — |
| Confirmação (desativar) | `--confirm-slug` | texto | Sim na ação | igual ao slug | — |
| *(sistema)* | `status`, `primaryOrganizationId`, `activatedAt`, `suspendedAt`, `deactivatedAt`, `version` | — | — | RN-TEN-09..13 | gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Obrigatórios e tamanhos | CLI + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | Formato do slug ou slug reservado | CLI + API | "Use letras minúsculas, números e hífen; este identificador é reservado." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | Slug já usado (inclusive desativado) | API + índice único | "O identificador \"{slug}\" já está em uso." | `TENANT_SLUG_TAKEN` |
| V-04 | UF, tipo ou fuso fora da lista | CLI + API | "Selecione um valor válido." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-05 | IBGE ausente para município/câmara ou prefixo divergente da UF | API | "Informe o código IBGE de 7 dígitos do município da UF {uf}." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`INVALID_FORMAT`) |
| V-06 | CNPJ do órgão principal | CLI + API | "CNPJ inválido. Confira os dígitos verificadores." | `VALIDATION_ERROR` (`INVALID_CNPJ`) |
| V-07 | E-mail do administrador | CLI + API | "Informe um e-mail válido." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-08 | Transição de status não permitida / ativar com etapas pendentes | API | "Não é possível {ação}: a instituição está {status}." / "Há etapas pendentes no provisionamento." | `INVALID_STATE` |
| V-09 | Motivo ausente ou curto (suspender/encerrar) | CLI + API | "Informe o motivo (mín. 10 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`) |
| V-10 | Confirmação de slug divergente (desativar) | CLI | "A confirmação não corresponde ao identificador." | saída 1 (sem efeito) |
| V-11 | `If-Match` ausente/divergente (PLT-04/05) | API | "A instituição foi alterada por outra pessoa. Recarregue." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-12 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `PLATFORM_TENANT_MANAGE` (permissions.md §8), concedida a `User.isPlatformOperator`; não faz parte de perfis de tenant.
- **Políticas:** MFA sempre obrigatório nas rotas `/platform/*` (sem depender de `security.mfaPolicy`); na CLI, a garantia vem do papel IAM assumido com MFA + operador válido.
- **Sem permissão:** usuário comum (inclusive `ADMIN_ORGAO`) → 403 `PERMISSION_DENIED` e `access.denied` na auditoria de plataforma; operador sem MFA → 403 `MFA_REQUIRED`.
- **Isolamento:** o operador não ganha vínculo com o tenant; rotas de tenant respondem 403 `MEMBERSHIP_INACTIVE` (DEC-139).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `TenantProvisioned` | `tenant.provisioned` | Etapa `tenancy.complete` | `tenantId`, `slug`, `primaryOrganizationId`; uma única vez por tenant |
| `TenantActivated` | `tenant.activated` | Ativação e reativação | Invalida o cache de status (US-100) |
| `TenantSuspended` | `tenant.suspended` | Suspensão | Invalida o cache de status |

As fachadas chamadas emitem seus próprios eventos (ex.: `UserInvited`, `RoleAssigned`, `OrganizationCreated`) conforme as stories donas. Encerramento e desativação não têm evento canônico (ver Lacunas); o cache de status é invalidado diretamente pelo caso de uso.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| E-mail de convite (US-091/US-112) | Primeiro administrador | E-mail | Após a ativação (RN-TEN-08) |
| — | Usuários do tenant | — | Suspensão/encerramento não geram notificação: a comunicação contratual ocorre fora do sistema; a interface exibe SCR-111 |

## Critérios de aceite em Gherkin
```gherkin
Feature: Provisionar tenant com dados padrão

  Background:
    Given que "Carla" é operadora da plataforma, autenticada com MFA
    And os seeders "catalog.items", "access.defaultRoles", "document.systemTypes", "document.templateLibrary", "workflow.seedWorkflows" e "catalog.holidays" estão registrados
    And não existe tenant com o slug "sao-jose"
    And a data atual no fuso "America/Sao_Paulo" é 06/10/2026

  Scenario: [Sucesso] Provisionar e ativar uma prefeitura pela API de plataforma
    When "Carla" enviar POST "/api/v1/platform/tenants" com slug "sao-jose", nome "Prefeitura de São José", tipo "MUNICIPALITY", UF "SC", IBGE "4216602", órgão principal "Prefeitura Municipal de São José" (sigla "PMSJ", CNPJ "11.222.333/0001-81") e administrador "rafael.nogueira@pmsj.exemplo.gov.br"
    Then a API deve responder 201 com status "ACTIVE" e todas as etapas do checklist "DONE"
    And o tenant deve ter 1 órgão principal, todas as chaves do registro de configurações com o valor padrão, 84 itens de catálogo de sistema, 15 perfis padrão, 11 tipos de documento com template v1 publicado, 2 workflows publicados e 28 feriados de 2026 e 2027
    And deve existir vínculo "INVITED" do tipo "INTERNAL" para o administrador com "ADMIN_ORGAO" no escopo "TENANT"
    And o e-mail de convite deve ser enfileirado somente após a ativação
    And devem existir auditorias "tenant.provision" e "tenant.activate" com actorType "PLATFORM_OPERATOR" no tenant "sao-jose"
    And devem ser gerados os eventos "TenantProvisioned" e "TenantActivated"
    And "Carla" não deve possuir vínculo com o tenant "sao-jose"

  Scenario: [Sucesso] Suspender e reativar
    Given que o tenant "sao-jose" está "ACTIVE" com versão 3
    When "Carla" suspender o tenant com If-Match "3" e motivo "Contrato com pagamento em atraso"
    Then o status deve ser "SUSPENDED" e o evento "TenantSuspended" deve ser gerado
    And em até 60 segundos as requisições de "Rafael" devem receber 403 "TENANT_SUSPENDED" sem exibir o motivo
    And os jobs "deadlines" e "notifications" do tenant devem terminar sem efeito
    When "Carla" ativar o tenant com o If-Match atual
    Then o status deve voltar a "ACTIVE" preservando o "activatedAt" original

  Scenario: [Sucesso] Encerramento permite somente leitura e exportação a ADMIN_ORGAO e AUDITOR
    Given que o tenant "sao-jose" está "OFFBOARDING"
    When "Rafael" (ADMIN_ORGAO) baixar o PDF de um documento aprovado
    Then o download deve ser permitido e auditado como "document.download"
    When "Rafael" tentar encaminhar um processo
    Then a API deve responder 403 com código "TENANT_SUSPENDED"
    And um usuário apenas com "REQUISITANTE" deve receber 403 "TENANT_SUSPENDED" em qualquer rota

  Scenario: [Validação] Dados de cadastro inválidos
    When "Carla" enviar slug "São José", CNPJ "11.222.333/0001-82" e fuso "Europe/Lisbon"
    Then a API deve responder 422 com código "VALIDATION_ERROR"
    And "errors" deve conter "slug" com "INVALID_FORMAT", "primaryOrganization.cnpj" com "INVALID_CNPJ" e "timezone" com "INVALID_ENUM"
    And nenhum tenant deve ser criado

  Scenario: [Validação] Suspensão sem motivo
    When "Carla" suspender o tenant "sao-jose" sem motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REQUIRED" no campo "reason"

  Scenario: [Permissão] Administrador de tenant chama rota de plataforma
    Given que "Rafael" tem "ADMIN_ORGAO" no tenant "sao-jose" e não é operador
    When "Rafael" enviar POST "/api/v1/platform/tenants"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve existir auditoria de plataforma "access.denied" com reasonCode "PLATFORM_TENANT_MANAGE"

  Scenario: [Permissão] Operador sem MFA
    Given que "Carla" se autenticou sem segundo fator
    When "Carla" enviar POST "/api/v1/platform/tenants" com corpo válido
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Operador não acessa dados do tenant que provisionou
    When "Carla" enviar GET "/api/v1/processes" com "X-Tenant-Id" do tenant "sao-jose"
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: [Tenant incorreto] Seeders gravam somente no tenant novo
    Given que o tenant "palhoca" está ativo com itens de catálogo personalizados
    When o tenant "sao-jose" for provisionado
    Then nenhuma linha do tenant "palhoca" deve ser criada, alterada ou lida
    And todas as linhas criadas devem ter "tenant_id" do tenant "sao-jose"

  Scenario: [Duplicidade] Slug de tenant desativado não é reutilizado
    Given que existe o tenant "biguacu" com status "DEACTIVATED"
    When "Carla" provisionar outro tenant com o slug "biguacu"
    Then a API deve responder 409 com código "TENANT_SLUG_TAKEN"

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Carla" provisionou "sao-jose" com a chave "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo tenant e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único conjunto de dados semeados

  Scenario: [Concorrência] Dois provisionamentos simultâneos com o mesmo slug
    When dois operadores provisionarem ao mesmo tempo o slug "sao-jose" com CNPJs diferentes
    Then exatamente um deve receber 201 e o outro 409 com código "TENANT_SLUG_TAKEN"

  Scenario: [Concorrência] Suspensão com versão desatualizada
    Given que outro operador alterou o tenant e a versão passou de 4 para 5
    When "Carla" suspender o tenant com If-Match "4"
    Then a API deve responder 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Falha no meio do provisionamento e retomada
    Given que o banco falha durante o seeder "document.templateLibrary"
    When "Carla" executar "pnpm cf tenant:provision --file sao-jose.json"
    Then o tenant deve permanecer "PROVISIONING" com "document.templateLibrary", "workflow.seedWorkflows", "catalog.holidays" e "identity.firstAdmin" em "PENDING"
    And a CLI deve terminar com código de saída 2 e as etapas concluídas devem permanecer intactas
    When "Carla" executar o mesmo comando com o banco disponível
    Then somente as etapas pendentes devem ser executadas e os itens de catálogo devem continuar 84

  Scenario: [Falha de integração] Fila de e-mail indisponível na ativação
    Given que a fila "email" está indisponível
    When o provisionamento de "sao-jose" for concluído
    Then o tenant deve ficar "ACTIVE" e a resposta deve indicar "invitationDispatched" falso
    And "Carla" deve conseguir reenviar com "pnpm cf tenant:resend-invite sao-jose" quando a fila voltar

  Scenario: [Falha de integração] Identidade do administrador não pôde ser criada
    Given que o Authentik, usado pela fachada de convite, está indisponível
    When o provisionamento chegar à etapa "identity.firstAdmin"
    Then a etapa deve ficar "PENDING", o tenant deve permanecer "PROVISIONING" e a CLI deve terminar com código 2
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI/CLI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | CLI lista campo e motivo; saída 1 |
| Slug em uso | 409 | `TENANT_SLUG_TAKEN` | "O identificador \"{slug}\" já está em uso." | Sugere outro slug |
| Não é operador | 403 | `PERMISSION_DENIED` | "Acesso restrito a operadores da plataforma." | — |
| Sessão sem MFA | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator." | *Step-up* |
| Tenant inexistente | 404 | `TENANT_NOT_FOUND` | "Instituição não encontrada." | — |
| Transição inválida / etapas pendentes | 409 | `INVALID_STATE` | "Não é possível ativar: há etapas pendentes." | Lista as etapas |
| `If-Match` divergente / ausente | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "A instituição foi alterada por outra pessoa." | Recarrega e repete |
| Requisição idêntica em curso | 409 | `IDEMPOTENCY_IN_PROGRESS` | "O provisionamento já está em andamento." | Consultar `PLT-03` |
| Usuário em tenant fora de `ACTIVE` | 403 | `TENANT_SUSPENDED` | "O acesso a esta instituição está indisponível no momento. Procure o administrador." | SCR-111; oferece trocar de instituição |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Os passos concluídos foram mantidos." | CLI: saída 2; repetir o comando |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Erro inesperado. Código: {correlationId}." | Exibe o correlationId |

## Dependências
- **Stories:** US-100 e US-081 (base). Integração: US-101 (regras do órgão), US-103 (registro de configurações), US-104, US-094, US-061, US-110, US-042, US-106 (seeders), US-091 e US-112 (convite), US-073 (auditoria), US-082 (outbox), US-083 (jobs), US-102 (`DEP-03` no assistente), US-086 (SCR-111).
- **Decisões/ADRs:** DEC-011, DEC-012, DEC-015, DEC-027, DEC-031, DEC-034, DEC-035, DEC-059, DEC-080..082, DEC-105, DEC-132, DEC-139, DEC-161, DEC-164; DEC-141, PEND-07, PEND-17; ADR-002.
- **Configurações:** todas as chaves de entities.md §6 (semeadas com o padrão).
- **Lacunas nas fontes canônicas:** (1) não há rota de API para encerrar/desativar nem eventos `TenantOffboarded`/`TenantDeactivated`, e não existe ação `tenant.offboard` — adotado: CLI em processo e auditoria `tenant.deactivate` com `metadata.toStatus` (`OFFBOARDING`/`DEACTIVATED`); proposta: `PLT-06 POST /platform/tenants/{id}/offboard`, `PLT-07 POST /platform/tenants/{id}/deactivate` e os dois eventos; (2) não há rota para corrigir dados do tenant (nome, fuso, IBGE) — proposta `PLT-08 PATCH /platform/tenants/{id}`; (3) `Tenant` não tem campo para o fim do prazo de encerramento — controlado pelo contrato/operador; proposta `offboardingEndsAt`; (4) transições de `TenantStatus` só constam como proposta (product-overview §11.2; `multi-tenancy.md` ainda não existe) — registrar RN-TEN-09 em decisions.md; (5) assistente de implantação sem SCR próprio — implementado em SCR-032; (6) nenhuma story do MVP 1 cobre o acesso de suporte (DEC-139, `PLATFORM_SUPPORT_ACCESS`, `support.access_*`).

## Impacto técnico
- Estabelece o padrão **seeder registrado por módulo** (versão, dependências, `verify()`), reutilizado na evolução dos seeds (RM-07) e nas fixtures de teste (dois tenants da suíte "tenant leak" — US-100).
- Uma transação por etapa: falhas parciais são retomáveis e nenhuma transação longa bloqueia o banco; o seeder mais pesado (templates) usa inserções em lote.
- `SystemDbService` (conexão de plataforma) só toca `tenants`, auditoria de plataforma e outbox do agregado `Tenant`; todo dado de negócio é gravado por `TenantTransaction` do tenant novo, sob RLS.
- Mudança de status invalida o `TenantStatusCache` (TTL 30 s) por evento e por remoção direta após o commit; a base `TenantJob` (US-100) aplica RN-TEN-12.
- A CLI é um *entrypoint* Nest (`nest-commander`) na mesma imagem da API; a mesma CLI com `--in-process` cria tenants nas fixtures de integração e E2E.

## Backend
- **Módulo:** `tenancy` (dono). Casos de uso: `ProvisionTenantCommand`, `ActivateTenantCommand`, `SuspendTenantCommand`, `OffboardTenantCommand`, `DeactivateTenantCommand`, `ApplyTenantSeedersCommand`, `ResendFirstAdminInvitationCommand`; consultas `ListTenantsQuery`, `GetTenantQuery` (com `ProvisioningChecklistService`).
- **Domínio:** agregado `Tenant` com a máquina de estados de RN-TEN-09; VOs `TenantSlug`, `IbgeCityCode`, `BrazilianTimezone`; `Cnpj` de `packages/validation`.
- **Contrato de seeder** (`tenancy/application/seeding`):
  ```ts
  export interface TenantSeeder {
    key: string; module: string; version: string;      // ex.: 'catalog.items', 'catalog', '2026.10.1'
    dependsOn: string[]; applyToExistingTenants: boolean;
    seed(ctx: SeedContext): Promise<SeedResult>;          // idempotente por chave natural
    verify(ctx: SeedContext): Promise<SeedStatus>;        // DONE | PENDING + contagens
  }
  ```
- **Integrações internas:** `IdentityFacade.createPendingInvitation`/`dispatchInvitation` (US-091), `AuditService`, `OutboxWriter`, `TenantTransaction`, `SystemDbService`, `TenantStatusCache` (US-100).
- **Apresentação:** `PlatformTenantsController` (`/platform/tenants`, `PlatformOperatorGuard` + MFA); CLI `apps/api/src/cli/tenant.cli.ts` (`tenant:provision|status|activate|suspend|offboard|deactivate|seed|resend-invite`); códigos de saída 0 (ok), 1 (validação/autorização), 2 (incompleto ou dependência indisponível).
- **Transação:** etapas 3–8 em transações independentes; mudança de status + auditoria + outbox em uma transação na conexão de plataforma; envio do convite após o commit.

## Frontend
- **Sem backoffice** (DT-07). Do lado do tenant: SCR-111 com a variante "Acesso indisponível" para `TENANT_SUSPENDED` ("O acesso a esta instituição está indisponível no momento. Procure o administrador."), com "Trocar de instituição" (SCR-101) para quem tem outros vínculos.
- **`OFFBOARDING`:** faixa fixa "Instituição em encerramento — somente consulta e exportação" e ações de comando ocultas (o status vem em `ME-01`).
- **Assistente (SCR-032):** `ImplementationAssistant` (empty state) com `SuggestedStructureForm` (nome, tipo e hierarquia editáveis; checkbox por unidade) e `FirstStepsChecklist` (links); progresso por unidade criada; falha parcial mostra o que foi criado e permite repetir.
- **Acessibilidade:** progresso anunciado em `aria-live`; foco no título após concluir; tudo operável por teclado.

## Banco de dados
- **Tabelas escritas:** `tenants`, `organizations`, `tenant_settings`, `catalog_items`, `roles`, `role_permissions`, `document_types`, `document_templates`, `document_template_versions`, `workflows`, `workflow_versions`, `workflow_stages`, `workflow_transitions`, `workflow_rules`, `holidays`, `users`, `tenant_memberships`, `role_assignments`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma tabela nova (`tenants` é criada em US-100); trigger `tenants_slug_immutable` (bloqueia `UPDATE` de `slug` fora de `PROVISIONING`); lista de slugs reservados em `packages/types/src/tenancy.ts`.
- **Constraints relevantes:** `UNIQUE (slug)`; `CHECK (status <> 'SUSPENDED' OR suspension_reason IS NOT NULL)`; índice `tenants(status)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PLT-01 | POST | `/api/v1/platform/tenants` | `{ slug, name, legalName?, type, stateCode, ibgeCityCode?, timezone?, plan?, primaryOrganization{…}, firstAdmin{ email, name }, activate? }` + `Idempotency-Key` | `201 { data: Tenant + provisioning{ complete, steps[] } + firstAdmin{ email (mascarado), membershipStatus, invitationDispatched } }` | 201, 403, 409, 422, 503 |
| PLT-02 | GET | `/api/v1/platform/tenants?status=&stateCode=&q=&page=&pageSize=` | — | `{ data: [{ id, slug, name, type, status, stateCode, plan, activatedAt, suspendedAt }], meta }` | 200, 403 |
| PLT-03 | GET | `/api/v1/platform/tenants/{id}` | — | `{ data: Tenant + provisioning }` + `ETag` | 200, 403, 404 |
| PLT-04 | POST | `/api/v1/platform/tenants/{id}/activate` | `{}` + `If-Match` | `{ data: Tenant }` | 200, 409, 412, 428 |
| PLT-05 | POST | `/api/v1/platform/tenants/{id}/suspend` | `{ reason }` + `If-Match` | `{ data: Tenant }` | 200, 409, 412, 422, 428 |

Trecho da resposta `201`: `"status": "ACTIVE", "version": 3, "provisioning": { "complete": true, "steps": [{ "key": "tenancy.tenantRecord", "status": "DONE" }, { "key": "catalog.items", "status": "DONE", "details": { "items": 84 } }, …, { "key": "identity.firstAdmin", "status": "DONE" }] }, "firstAdmin": { "email": "r***@pmsj.exemplo.gov.br", "membershipStatus": "INVITED", "invitationDispatched": true }`.

## Logs
- `info` `tenant.provision.started` — `slug`, `channel`, `operatorId`, `correlationId`.
- `info` `tenant.provision.step_completed` — `tenantId`, `step`, `version`, `created`, `skipped`, `durationMs`.
- `warn` `tenant.provision.step_failed` — `tenantId`, `step`, `errorCode`.
- `info` `tenant.status_changed` — `tenantId`, `from`, `to`, `channel`.
- `warn` `tenant.invitation_dispatch_failed` — `tenantId`, `membershipId`.
- **Nunca logar:** e-mail completo do administrador (mascarar), texto do motivo de suspensão/encerramento (só `hasReason`), tokens de convite.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `tenant.provision` | `SYSTEM` | Conclusão (`SUCCESS`) ou falha de etapa (`FAILURE`) | `metadata`: `slug`, `channel`, `seedVersions`, `steps`, `durationMs`, `idempotencyKey`; em falha `failedStep`, `errorCode` |
| `tenant.activate` | `SYSTEM` | Ativação e reativação | `changes`: `status`; `metadata`: `fromStatus`, `toStatus` |
| `tenant.suspend` | `SYSTEM` | Suspensão | `changes`: `status`, `suspendedAt`; `metadata`: motivo informado |
| `tenant.deactivate` | `SYSTEM` | Encerramento e desativação | `metadata`: `fromStatus`, `toStatus` (`OFFBOARDING`/`DEACTIVATED`), motivo, `channel = CLI` |
| `access.denied` | `ACCESS` | Não operador em rota de plataforma (auditoria de plataforma) | `reasonCode = PLATFORM_TENANT_MANAGE` |

## Testes necessários
- **Unitários:** slug (válidos, inválidos, reservados); IBGE × UF; allowlist de fusos; máquina de estados (todas as transições válidas e inválidas); ordenação topológica (ciclo e dependência ausente); cálculo do checklist.
- **Integração (Testcontainers PostgreSQL + Redis + MinIO):** provisionamento completo; reexecução sem nenhuma linha nova (contagem por tabela); falha injetada em cada etapa + retomada; seeders escrevem só no tenant novo; operador sem vínculo; auditoria e outbox na mesma transação da mudança de status.
- **API/contrato:** PLT-01..05 conforme api.md; `Location`, `ETag`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** não operador → 403; sem MFA → 403; matriz DEC-132 (status × leitura/comando/exportação × `ADMIN_ORGAO`/`AUDITOR`/`REQUISITANTE`).
- **Concorrência:** mesmo slug em paralelo; `If-Match`; suspensão com requisições em curso (efeito ≤ 60 s).
- **E2E (Playwright):** CLI provisiona → convite no Mailpit → aceite → assistente cria a estrutura → "Primeiros passos".
- **Performance:** provisionamento p95 < 2 min em ambiente de homologação.

## Definition of Done
- [ ] Cenários Gherkin automatizados (API, CLI e E2E) e passando no CI
- [ ] Checklist calculado, retomada comprovada por falha injetada em cada etapa
- [ ] Matriz de acesso por status (DEC-132) coberta por testes
- [ ] Auditorias `tenant.*` e eventos `Tenant*` verificados em teste
- [ ] Fixtures de dois tenants usadas pela suíte "tenant leak" geradas por este provisionamento
- [ ] OpenAPI de PLT-01..05 compatível com api.md
- [ ] Logs sem e-mail completo nem motivos; métricas `cf_tenant_provisioning_duration_seconds` e `cf_tenant_status_changes_total`
- [ ] Runbook de operação da CLI (provisionar, retomar, suspender, encerrar, desativar) publicado
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — orquestração e máquina de estados (o conteúdo semeado pertence a outras stories), CLI, cinco endpoints de plataforma, matriz de acesso por status e o assistente; o risco técnico é controlado pela base de US-100.

## Prioridade
**P0** — sem provisionamento não existe tenant para o piloto (marco M1, sprint 4) nem fixtures confiáveis para os testes de isolamento.
