---
id: US-101
title: "Gerenciar órgãos/entidades"
epic: EP-017
feature: FT-056
mvp: 1
priority: P0
estimate: S
status: Especificada
depends_on: [US-100]
modules: [tenancy, access, attachment, audit, platform]
screens: [SCR-032]
endpoints: [ORG-01, ORG-02, ORG-03, ORG-04]
permissions: [ORGANIZATION_MANAGE]
events: [OrganizationCreated, OrganizationUpdated]
---

# US-101 — Gerenciar órgãos/entidades

## Título
Gerenciar órgãos/entidades

## Descrição
**Como** administrador do órgão, **quero** cadastrar e manter os dados dos órgãos/entidades do tenant (razão social, sigla, CNPJ, tipo, contato, logotipo), **para** que processos, numeração e identidade visual estejam corretos desde a primeira contratação.

Tela de administração (SCR-032) lista os órgãos do tenant, permite criar novos e editar os existentes. O órgão principal é criado no provisionamento (US-099); esta story cobre a gestão contínua: múltiplos órgãos por tenant (ex.: Prefeitura + Fundo Municipal de Saúde + autarquia), cada um com CNPJ próprio e sigla usada na numeração de processos.

## Contexto
- Um tenant (município/ente) pode abranger mais de um órgão com CNPJ próprio (DEC-011): a administração direta, fundos, autarquias. Cada órgão é a base para numeração por órgão (`numbering.process.scope = ORGANIZATION`, DEC-028) e, no MVP 3, para o PNCP.
- Em 2026 a Receita Federal passou a emitir CNPJ alfanumérico; a validação do dígito verificador precisa aceitar ambos os formatos.
- Hoje os órgãos de um mesmo município mantêm cadastros soltos em papel/planilha; sigla e CNPJ divergentes geram numeração e prestação de contas incorretas.
- Esta story depende do contexto de tenant e isolamento (US-100) e é pré-condição para estrutura organizacional (US-102) e para a criação de processos (US-001, RN-PROC-01/02).

## Objetivo
Permitir que o administrador cadastre e mantenha 100% dos órgãos do tenant com CNPJ e sigla validados e únicos, de forma que todo processo possa ser aberto com `organizationId` correto desde o primeiro dia.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Demais perfis, como leitores implícitos (seleção de órgão em formulários — US-001, US-102).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `ORGANIZATION_MANAGE`.
- Tenant provisionado com ao menos o órgão principal (US-099).

## Fluxo principal
1. O administrador acessa **Administração → Estrutura** (SCR-032), aba "Órgãos".
2. O sistema lista os órgãos do tenant (`ORG-01`) com nome, sigla, CNPJ, tipo e status.
3. O administrador clica em **"Novo órgão"**, preenche nome, sigla, CNPJ, tipo e, opcionalmente, contato, endereço e logotipo.
4. O front valida com `createOrganizationSchema` (Zod) e envia `POST /api/v1/organizations` (`ORG-02`).
5. A API valida unicidade de sigla e CNPJ no tenant e o dígito verificador do CNPJ, cria o `Organization` (`isActive = true`), grava auditoria `organization.create` e publica `OrganizationCreated`.
6. A API responde **201**; o front mostra o novo órgão na lista e o torna disponível em seletores (criação de processo, estrutura organizacional).
7. Para editar, o administrador abre o órgão (`ORG-03`), altera os campos permitidos e salva; o front envia `PATCH /api/v1/organizations/{id}` (`ORG-04`) com `If-Match`.
8. A API reaplica as validações, atualiza o registro, grava `organization.update` (com `changedFields`) e publica `OrganizationUpdated`.

## Fluxos alternativos
- **FA-01 — Upload de logotipo:** o administrador envia a imagem pelo fluxo genérico de anexos (`ATT-02`/`ATT-03`, US-068) com `targetType = TENANT_ASSET` e `targetId` do órgão; ao concluir, informa `logoAttachmentId` no `PATCH` do órgão.
- **FA-02 — Tenant com um único órgão:** a aba "Órgãos" fica oculta em telas que assumem órgão único (ex.: passo 2 do wizard de processo — US-001, FA-04), mas continua acessível em SCR-032.
- **FA-03 — Inativar órgão:** `isActive = false` via `PATCH`; o órgão some das opções de novos processos, mas permanece visível no histórico.
- **FA-04 — Tentativa de inativar o único órgão ativo ou o órgão principal:** bloqueada (RN-TEN-41); a UI explica o motivo e sugere ativar outro órgão antes.
- **FA-05 — Reenvio após falha de rede:** o front repete o `PATCH` com o mesmo `If-Match`; se já aplicado, recebe `VERSION_CONFLICT` e recarrega o registro atual.

## Regras de negócio
- **RN-TEN-38** — Obrigatórios: `name`, `shortName`, `cnpj`, `type`.
- **RN-TEN-39** — `shortName` único por tenant (usado no token `{org}` da numeração — DEC-028); 2–30 caracteres, apenas letras, números e hífen, exibido em maiúsculas.
- **RN-TEN-40** — `cnpj` único por tenant; 14 caracteres, dígito verificador válido (formato numérico tradicional ou alfanumérico vigente); erro `INVALID_CNPJ`.
- **RN-TEN-41** — `isActive` não pode virar `false` quando o órgão é `tenants.primaryOrganizationId` ou é o único órgão `isActive = true` do tenant → `PRIMARY_ORGANIZATION_REQUIRED` (409, análogo a `LAST_ADMIN_REQUIRED`/POL-12).
- **RN-TEN-42** — `logoAttachmentId`, quando informado, deve referenciar `Attachment` `AVAILABLE`, `targetType = TENANT_ASSET`, do mesmo tenant (fluxo `ATT-02`/`ATT-03`, US-068); `website`, quando informado, deve ser URL `https`.
- **RN-TEN-43** — `metadata` é somente leitura pela API no MVP 1 (reservado a integrações futuras — MVP 3); qualquer valor enviado pelo cliente é ignorado.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `name` | texto curto | Sim | 3–250 caracteres; trim | — |
| Sigla | `shortName` | texto curto | Sim | 2–30; `[A-Z0-9-]`; único no tenant | — |
| CNPJ | `cnpj` | texto curto | Sim | 14; DV válido; único no tenant | — |
| Tipo | `type` | seleção (`OrganizationType`) | Sim | enum | — |
| Ativo | `isActive` | interruptor | — | RN-TEN-41 | `true` |
| E-mail | `email` | e-mail | Não | formato válido | — |
| Telefone | `phone` | texto curto | Não | até 20 | — |
| Site | `website` | URL | Não | `https://` | — |
| Endereço (logradouro, número, complemento, bairro, cidade, UF, CEP) | `addressStreet`…`addressZipCode` | texto/seleção | Não | UF = 2 letras; CEP = 8 dígitos | — |
| Município (IBGE) | `ibgeCityCode` | texto curto | Não | 7 dígitos | — |
| Logotipo | `logoAttachmentId` | referência | Não | RN-TEN-42 | — |
| *(sistema)* Metadados | `metadata` | objeto | — | RN-TEN-43 | `{}` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios ausentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | `shortName` fora do padrão ou duplicado | Front + API | "Use 2 a 30 letras, números ou hífen, sem repetir uma sigla existente." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | `cnpj` com dígito verificador inválido | Front + API | "Informe um CNPJ válido." | `VALIDATION_ERROR` (`INVALID_CNPJ`) |
| V-04 | `cnpj` duplicado no tenant | API (+ índice único) | "Já existe um órgão com este CNPJ." | `VALIDATION_ERROR` (`INVALID_CNPJ`) |
| V-05 | `website` sem `https` | Front + API | "Informe um endereço começando com https://." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-06 | Inativar órgão principal/único ativo | API | "Este é o único órgão ativo do tenant e não pode ser inativado." | `PRIMARY_ORGANIZATION_REQUIRED` |
| V-07 | `logoAttachmentId` de outro tenant, inexistente ou não `AVAILABLE` | API | "Não foi possível usar esta imagem como logotipo." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |

## Permissões
- **Permissão:** `ORGANIZATION_MANAGE`, risco `H`, sem variação de escopo (sempre `TENANT`).
- **Políticas:** nenhuma política contextual própria; leitura (`ORG-01`/`ORG-03`) é capacidade implícita de qualquer vínculo `ACTIVE` (seletores).
- **MFA:** exigido quando `security.mfaPolicy` é `ADMINS` ou `ALL` (POL-14, permissão `HIGH`).
- **Sem permissão:** "Novo órgão"/"Editar" ocultos; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `OrganizationCreated` | `organization.created` | Commit da criação | Payload: `organizationId` |
| `OrganizationUpdated` | `organization.updated` | Commit da atualização | Payload: `organizationId`, `changedFields[]` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; alteração de cadastro não notifica (cadastro de baixa frequência, visível na lista). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar órgãos/entidades

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And "Carla" possui o perfil "ADMIN_ORGAO" com escopo "TENANT"

  Scenario: [Sucesso] Criar órgão com dados válidos
    When "Carla" criar o órgão "Fundo Municipal de Saúde", sigla "FMS", CNPJ válido e tipo "FUND"
    Then o órgão deve ser criado com "isActive" verdadeiro
    And deve gerar registro de auditoria "organization.create"
    And deve gerar o evento "OrganizationCreated"

  Scenario: [Validação] CNPJ com dígito verificador inválido
    When "Carla" enviar CNPJ "11.111.111/1111-00"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_CNPJ" no campo "cnpj"

  Scenario: [Permissão] Usuário sem ORGANIZATION_MANAGE
    Given que "Bruno" não possui "ORGANIZATION_MANAGE"
    When "Bruno" enviar POST para "/api/v1/organizations"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Sigla já usada em outro tenant não bloqueia
    Given que existe um órgão de sigla "SEC" no tenant "Prefeitura B"
    When "Carla" criar, no tenant "Prefeitura de São José", um órgão de sigla "SEC"
    Then o órgão deve ser criado normalmente
    And nenhum dado do tenant "Prefeitura B" deve ser lido ou alterado

  Scenario: [Duplicidade] Sigla já usada no mesmo tenant
    Given que já existe o órgão de sigla "PMSJ" no tenant "Prefeitura de São José"
    When "Carla" criar outro órgão com sigla "PMSJ"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_FORMAT" no campo "shortName"

  Scenario: [Concorrência] Edições simultâneas do mesmo órgão
    Given que "Carla" e "Diego" abriram o mesmo órgão na versão 3
    When "Carla" salvar primeiro e "Diego" enviar "If-Match: \"3\""
    Then a resposta a "Diego" deve ser 412 com código "VERSION_CONFLICT" e "currentVersion" igual a 4

  Scenario: [Falha de banco] Banco indisponível ao salvar
    Given que o banco de dados está indisponível
    When "Carla" tentar criar um órgão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhum órgão deve ser persistido

  Scenario: [Falha de integração] Outbox indisponível
    Given que o relay do outbox está indisponível
    When "Carla" criar um órgão válido
    Then o órgão deve ser criado e a API deve responder 201
    And o evento "OrganizationCreated" deve permanecer "PENDING" até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo obrigatório ausente | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos |
| CNPJ inválido ou duplicado | 422/409 | `VALIDATION_ERROR` (`INVALID_CNPJ`) | "Informe um CNPJ válido." / "Já existe um órgão com este CNPJ." | Erro no campo |
| Sigla inválida ou duplicada | 422 | `VALIDATION_ERROR` (`INVALID_FORMAT`) | "Use outra sigla." | Erro no campo |
| Inativar órgão principal/único | 409 | `PRIMARY_ORGANIZATION_REQUIRED` | "Este é o único órgão ativo e não pode ser inativado." | Mantém `isActive` |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar órgãos." | Oculta ações |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Abre desafio de MFA |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Este órgão foi alterado por outra pessoa. Recarregue." | Recarrega registro |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Botão de novo |

## Dependências
- **Stories:** US-100 (contexto de tenant); US-099 (órgão principal semeado); usada por US-001 (RN-PROC-01/02), US-102 (órgão da unidade), US-068 (anexos/logotipo).
- **Decisões/ADRs:** DEC-011, DEC-028, DEC-080..083, DEC-104; ADR-002.
- **Configurações:** nenhuma chave própria (consome `numbering.process.scope`, definida em US-103/US-105).
- **Lacunas nas fontes canônicas:** nenhuma (`PRIMARY_ORGANIZATION_REQUIRED` registrado em api.md §2.2).

## Impacto técnico
- Volume baixo (dezenas de órgãos por tenant); sem riscos de performance.
- `shortName` é lido pela `NumberingFacade` (US-105) a cada numeração por órgão — alterá-lo não renumera processos já emitidos.
- Reaproveita o padrão transacional e de auditoria estabelecido em US-001 (`TenantTransaction` → validação → domínio → `AuditService` → `OutboxWriter`).

## Backend
- **Módulo(s):** `tenancy` (dono); usa `access` (`AuthorizationService.assertCan('ORGANIZATION_MANAGE')`), `attachment` (validação de `logoAttachmentId`).
- **Casos de uso:** `CreateOrganizationCommand`, `UpdateOrganizationCommand`; `ListOrganizationsQuery`, `GetOrganizationQuery`; seeder `PrimaryOrganizationSeeder` (`tenancy.primaryOrganization`, US-099). Exceção de nível registrada em decisions.md (DEC-041): `tenancy` importa as fachadas de `access` e `identity`.
- **Domínio:** `Organization.create(props)`/`.update(props)` aplicando RN-TEN-38..43; VO `Cnpj` (`packages/validation`, aceita numérico e alfanumérico).
- **Integrações internas:** `attachment.assertAvailable(id, { targetType: 'TENANT_ASSET', tenantId })` — até a US-068 existir, a porta `OrganizationLogoPort` recusa todo `logoAttachmentId` (`REFERENCE_NOT_FOUND`); o `files` a implementa depois. O `AttachmentPicker` do logotipo também aguarda a US-068 (a tela mostra um aviso).
- **Transação:** criação/atualização, auditoria e outbox na mesma transação com `app.tenant_id`.

## Frontend
- **Tela(s):** SCR-032 (`/admin/estrutura`), aba "Órgãos".
- **Componentes:** `OrganizationList`, `OrganizationFormDialog` (React Hook Form + `zodResolver`), `CnpjInput` (máscara + validação), `AttachmentPicker` (logotipo).
- **Estados:** skeleton na lista; vazio ("Nenhum órgão cadastrado"); erro com "Tentar novamente"; botão salvar com estado de carregamento.
- **Acessibilidade e responsividade:** foco no primeiro campo ao abrir o diálogo; erros em `aria-live`; diálogo em tela cheia em telas < 768 px.

## Banco de dados
- **Tabelas:** `organizations`.
- **Migrações:** `20261015220000_organizations` — enum `organization_type`, tabela `organizations` (entities.md §4: checks de formato, trigger de imutabilidade do tenant, RLS, sem `DELETE`) e a FK composta `tenants(id, primary_organization_id) → organizations(tenant_id, id)`. A FK de `logo_attachment_id` → `attachments` entra com a US-068.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, cnpj)`, `UNIQUE (tenant_id, short_name)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ORG-01 | GET | `/organizations` | `?isActive=&q=` | `200 { data: [Organization], meta }` | 200 |
| ORG-02 | POST | `/organizations` | `{ name, shortName, cnpj, type, email?, phone?, website?, address*?, ibgeCityCode? }` | `201 { data: Organization }` | 201, 401, 403, 422 |
| ORG-03 | GET | `/organizations/{id}` | — | `200 { data: Organization }` | 200, 403, 404 |
| ORG-04 | PATCH | `/organizations/{id}` | Campos de ORG-02 + `isActive?`, `logoAttachmentId?` + `If-Match` | `200 { data: Organization }` | 200, 403, 404, 409, 412, 422, 428 |

## Logs
- `info` `organization.created` / `organization.updated` — `organizationId`, `changedFields`, `tenantId`, `userId`, `correlationId`.
- `warn` `organization.deactivate_blocked` — tentativa sobre órgão principal/único ativo.
- `error` `organization.save_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** CNPJ completo (logar apenas os 4 últimos dígitos), e-mail, telefone, endereço.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `organization.create` | `DATA_CHANGE` | Commit da criação | `changes`: todos os campos não sensíveis |
| `organization.update` | `DATA_CHANGE` | Commit da atualização | `changes`: valores anterior/novo dos campos alterados |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = ORGANIZATION_MANAGE` |

## Testes necessários
- **Unitários:** VO `Cnpj` (numérico e alfanumérico, DVs válidos/inválidos); formato de `shortName`; RN-TEN-41.
- **Integração (Testcontainers):** unicidade de `cnpj`/`shortName` por índice; RLS entre tenants; bloqueio de inativação do último órgão ativo.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `ETag`/`If-Match`.
- **RBAC e multi-tenant:** com/sem `ORGANIZATION_MANAGE`; referência de outro tenant em `logoAttachmentId` → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas edições simultâneas → uma 200, outra 412.
- **E2E (Playwright):** criar, editar, tentar inativar o único órgão ativo.
- **Acessibilidade/performance:** axe no diálogo; lista com 50 órgãos sem degradação perceptível.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `ORGANIZATION_MANAGE` aplicado na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de ORG-01..04 atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis (CNPJ mascarado); métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**S** — CRUD de um único agregado simples, sem árvore nem concorrência de numeração; validações objetivas (CNPJ, unicidade).

## Prioridade
**P0** — pré-requisito para estrutura organizacional (US-102) e para a criação de processos (US-001).
