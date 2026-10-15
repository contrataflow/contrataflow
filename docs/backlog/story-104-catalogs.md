---
id: US-104
title: "Catálogos parametrizáveis"
epic: EP-017
feature: FT-057
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-100]
modules: [catalog]
screens: [SCR-109]
endpoints: [CAT-01, CAT-02, CAT-03, CAT-04, CAT-05, CAT-06]
permissions: [CATALOG_MANAGE]
events: [CatalogItemChanged]
---

# US-104 — Catálogos parametrizáveis

## Título
Gerenciar catálogos parametrizáveis

## Descrição
**Como** administrador do órgão, **quero** manter os itens dos catálogos parametrizáveis do tenant (tipo de contratação, modalidade, origem do processo, unidade de medida, categoria de risco, tipo de fonte de preço, critério de julgamento e categoria de anexo), **para** adaptar as opções disponíveis nos formulários do sistema à realidade do meu órgão, sem depender de alteração de código.

Cada catálogo é uma lista de `CatalogItem` por tenant e por `catalogType`. O catálogo-base da plataforma é copiado no provisionamento (US-099, seeder `catalog.items`) com itens de sistema; esta story cobre a gestão contínua: criar itens próprios, editar, ativar/desativar e reordenar, sem nunca permitir excluir ou renomear o `code` de um item de sistema.

## Contexto
- Hoje "tipo de contratação", "modalidade" etc. são listas fixas ou mantidas em planilhas; cada órgão tem nuances (uma categoria de risco adicional, uma unidade de medida que não usa).
- DEC-027 define `CatalogItem` com `catalogType` (`CatalogType`: `CONTRACTING_TYPE`, `MODALITY`, `PROCESS_ORIGIN`, `UNIT_OF_MEASURE`, `RISK_CATEGORY`, `PRICE_SOURCE_TYPE`, `JUDGMENT_CRITERION`, `ATTACHMENT_CATEGORY`), `code` estável (usado em regras e integrações, ex.: `PREGAO`, `AQUISICAO_BENS`), itens de sistema (`isSystem`) renomeáveis/desativáveis mas nunca excluídos, e `metadata` em JSONB validada por tipo (entities.md §5.9).
- É consumida por praticamente todo o produto: a criação de processo (US-001, RN-PROC-16) valida `contractingTypeId`/`modalityId`/`originId` ativos; pesquisa de preço (US-029) usa `PRICE_SOURCE_TYPE`; mapa de riscos (US-035) usa `RISK_CATEGORY`; anexos (US-068) usam `ATTACHMENT_CATEGORY`.

## Objetivo
Permitir que o administrador mantenha os 8 catálogos com itens ativos, inativos e personalizados, garantindo que 100% das referências a um `CatalogItem` em outras entidades validem item ativo, do `catalogType` correto e do mesmo tenant — e que nenhum item de sistema seja excluído ou tenha o `code` alterado.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Demais perfis, como leitores implícitos (seletores de catálogo em formulários — US-001, US-029, US-035, US-068).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `CATALOG_MANAGE`.
- Catálogos semeados pelo provisionamento (US-099, seeder `catalog.items`).

## Fluxo principal
1. O administrador acessa **Administração → Catálogos** (SCR-109) e seleciona o catálogo (ex.: "Tipos de contratação").
2. O sistema lista os itens (`CAT-01`) ordenados por `sortOrder`, com `code`, `label`, selo "Padrão do sistema" quando `isSystem`, e status ativo/inativo.
3. O administrador clica em **"Novo item"**, informa `code`, `label`, `description` e os campos de `metadata` específicos do catálogo (ex.: em `MODALITY`, `legalBasis` e `isDirectContracting`); o front valida com o schema Zod do `catalogType` e envia `POST /catalogs/{catalogType}/items` (`CAT-02`).
4. A API valida unicidade do `code` no tenant/catálogo e o schema de `metadata`, cria o item (`isSystem = false`), grava `catalog.create` e publica `CatalogItemChanged` (`change = CREATED`).
5. Para editar, o administrador abre o item e altera `label`, `description`, `metadata` ou `sortOrder`; o front envia `PATCH /catalog-items/{id}` (`CAT-03`) com `If-Match`; `code` é somente leitura após a criação.
6. Para ativar/desativar, usa os botões correspondentes (`CAT-04`/`CAT-05`, ambos com `If-Match`).
7. Para reordenar, arrasta os itens na lista; o front envia a lista completa de IDs na nova ordem via `PUT /catalogs/{catalogType}/order` (`CAT-06`).

## Fluxos alternativos
- **FA-01 — Item de sistema:** `code` nunca é editável (campo bloqueado na UI) e a ação "Excluir" não existe para nenhum item (ver RN-TEN-64); tentar alterar `code` por API responde `CATALOG_ITEM_SYSTEM`.
- **FA-02 — Desativar item em uso:** permitido; a UI avisa "Este item deixará de aparecer em novas seleções; registros existentes não são afetados." Registros que já referenciam o item continuam exibindo-o normalmente (entities.md).
- **FA-03 — `metadata` inválida para o tipo:** a API rejeita com `VALIDATION_ERROR` antes de gravar.
- **FA-04 — Catálogo sem nenhum item ativo:** a lista mostra estado vazio ("Nenhum item ativo neste catálogo") orientando a ativar ou criar um item; formulários que dependem do catálogo ficam bloqueados por aquelas stories (fora do escopo desta).

## Regras de negócio
- **RN-TEN-59** — `CatalogItem` pertence a exatamente um `catalogType` (`CatalogType`); `code` em `SCREAMING_SNAKE_CASE`, único por `(tenant, catalogType, code)` e imutável após a criação.
- **RN-TEN-60** — `isSystem = true`: `label`, `description`, `metadata`, `sortOrder` e `isActive` são editáveis; `code` nunca é editável, pelo sistema ou pelo cliente.
- **RN-TEN-61** — `isActive = false`: o item não aparece em seleções de novos registros; registros existentes que já o referenciam mantêm a referência e continuam exibindo-o (sem efeito retroativo).
- **RN-TEN-62** — `metadata` é validada pelo schema Zod do `catalogType` (entities.md §5.9); chaves fora do schema do tipo são rejeitadas.
- **RN-TEN-63** — `parentId`, quando informado, deve referenciar outro `CatalogItem` do mesmo `catalogType` e tenant; não pode apontar para si mesmo.
- **RN-TEN-64** — Não há exclusão física de `CatalogItem` pela API (somente criação, edição, ativação/desativação e reordenação — `CAT-01..06`); o ciclo de vida de todo item, inclusive os não-sistema, é por desativação.
- **RN-TEN-65** — Reordenação (`CAT-06`) recebe a lista completa de IDs do `catalogType` na ordem final; `sortOrder` é recalculado sequencialmente; algum ID que não pertença ao `catalogType`/tenant informado bloqueia a operação inteira.
- **RN-TEN-66** — `CATALOG_MANAGE` não varia por escopo (sempre `TENANT`); não há política contextual adicional.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Catálogo | `catalogType` (parâmetro de rota) | seleção (`CatalogType`) | Sim | enum | — |
| Código | `code` | texto curto | Sim na criação | `SCREAMING_SNAKE_CASE`; único; imutável | — |
| Rótulo | `label` | texto curto | Sim | 1–150 caracteres | — |
| Descrição | `description` | texto longo | Não | até 1.000 caracteres | — |
| Item do sistema | `isSystem` | booleano (leitura) | — | RN-TEN-60 | `false` |
| Ativo | `isActive` | interruptor | — | RN-TEN-61 | `true` |
| Ordem | `sortOrder` | número | Não | RN-TEN-65 | `0` |
| Item superior | `parentId` | seleção | Não | RN-TEN-63 | — |
| Metadados | `metadata` | objeto (conforme tipo) | Condicional | entities.md §5.9; RN-TEN-62 | `{}` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios ausentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | `code` fora do padrão ou duplicado no catálogo | Front + API | "Use letras maiúsculas, números e sublinhado, sem repetir um código existente." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-03 | `metadata` fora do schema do `catalogType` | Front + API | "Revise os campos específicos deste catálogo." | `VALIDATION_ERROR` |
| V-04 | `parentId` de outro `catalogType`, outro tenant ou inexistente | API | "Selecione um item superior válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | Alterar `code` ou excluir item de sistema | API | "Itens padrão do sistema não podem ser excluídos ou ter o código alterado." | `CATALOG_ITEM_SYSTEM` |
| V-06 | `If-Match` divergente | API | "Este item foi alterado por outra pessoa. Recarregue a lista." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `CATALOG_MANAGE`, risco `M`, sem variação de escopo (sempre `TENANT`); leitura (`CAT-01`) é capacidade implícita de qualquer vínculo `ACTIVE`.
- **Políticas:** nenhuma política contextual própria.
- **MFA:** exigido somente se `security.mfaPolicy = ALL`.
- **Sem permissão:** tela de catálogos oculta edição (lista permanece visível); API responde 403 `PERMISSION_DENIED` em `CAT-02..06` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `CatalogItemChanged` | `catalog.item_changed` | Commit de criar/editar/ativar/desativar/reordenar | `change` = `CREATED`\|`UPDATED`\|`ACTIVATED`\|`DEACTIVATED` (reordenação usa `UPDATED` por item afetado) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; alteração de catálogo não gera notificação. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar catálogos parametrizáveis

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo com a permissão "CATALOG_MANAGE"

  Scenario: [Sucesso] Criar item em um catálogo
    When o administrador criar o item "OUTRO_SERVICO" no catálogo "ATTACHMENT_CATEGORY" com rótulo "Outro"
    Then o item deve aparecer na lista com status ativo
    And deve gerar registro de auditoria "catalog.create"
    And deve gerar o evento "CatalogItemChanged" com "change" igual a "CREATED"

  Scenario: [Validação] Código fora do padrão
    When o administrador tentar criar um item com código "servico novo"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "code"
    And nenhum item deve ser criado

  Scenario: [Permissão] Usuário sem CATALOG_MANAGE
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" enviar POST para criar um item de catálogo
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] parentId de outro tenant
    Given que existe o item "X" no catálogo "RISK_CATEGORY" do tenant "Prefeitura B"
    When o administrador, no tenant "Prefeitura de São José", enviar "parentId" do item "X"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "parentId"
    And a resposta não deve revelar que o item existe em outro tenant

  Scenario: [Duplicidade] Código já usado no mesmo catálogo
    Given que existe o item "PREGAO" no catálogo "MODALITY"
    When o administrador tentar criar outro item "PREGAO" no catálogo "MODALITY"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "code"

  Scenario: [Concorrência] Edições simultâneas do mesmo item
    Given que o item "AQUISICAO_BENS" está na versão 3
    When dois administradores enviarem "PATCH" simultâneos com "If-Match: \"3\""
    Then apenas um deve receber 200 com a versão 4
    And o outro deve receber 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao criar item
    Given que o banco de dados fica indisponível
    When o administrador tentar criar um item de catálogo
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum item deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When o administrador criar um item de catálogo válido
    Then o item deve ser criado e a API deve responder 201
    And o evento "CatalogItemChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]` |
| `code` duplicado no catálogo | 422 | `VALIDATION_ERROR` | "Já existe um item com este código neste catálogo." | Erro no campo `code` |
| Alterar/excluir item de sistema | 409 | `CATALOG_ITEM_SYSTEM` | "Itens padrão do sistema não podem ser excluídos ou ter o código alterado." | Campo `code` bloqueado; sem botão "Excluir" |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este item foi alterado por outra pessoa. Recarregue a lista." | Recarrega o item |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar catálogos." | Oculta ações de edição |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-100 (contexto de tenant e isolamento); US-099 (seeder `catalog.items`, catálogo-base de sistema). Consumida por US-001 (RN-PROC-16), US-029 (`PRICE_SOURCE_TYPE`), US-035 (`RISK_CATEGORY`), US-068 (`ATTACHMENT_CATEGORY`), entre outras.
- **Decisões/ADRs:** DEC-027, DEC-080, DEC-081, DEC-082, DEC-083, DEC-104; ADR-002.
- **Configurações:** nenhuma chave própria.
- **Lacunas nas fontes canônicas:** DEC-027 registra que itens **não-sistema** poderiam, em tese, ser excluídos (a ressalva "nunca excluídos" é dita apenas dos itens de sistema); porém o catálogo de endpoints do épico só define `CAT-01..06` (sem `DELETE`). Adotamos o conceito canônico mais próximo — ciclo de vida só por ativação/desativação para todo item, sem exclusão física (RN-TEN-64) — e registramos a lacuna; proposta: se um `DELETE /catalog-items/{id}` vier a ser necessário, reaproveitar `CATALOG_ITEM_SYSTEM` (409) para itens de sistema e `ITEM_IN_USE` (409) para itens referenciados.
- **Decisões de implementação (a story não fixa):** (1) o item novo entra no fim da lista (`sortOrder = max + 1`), em vez do `0` do quadro de campos — com `0` ele apareceria antes dos demais; (2) `CAT-01` ordena por `sortOrder` e depois `code`, devolve ativos e inativos (filtro `isActive`) e usa a paginação padrão com `pageSize` 100 por padrão; (3) a reordenação recebe a lista COMPLETA do catálogo (ativos e inativos): ID alheio ou lista incompleta → 422 `VALIDATION_ERROR` em `orderedIds` (`REFERENCE_NOT_FOUND`/`CONDITIONAL_REQUIRED`), e `sortOrder` vira 1..n; (4) `CAT-03` aceita `code` no corpo só para recusá-lo: item de sistema → 409 `CATALOG_ITEM_SYSTEM`; item comum → 422 `NOT_ALLOWED` (RN-TEN-59); (5) `metadata` no PATCH substitui o objeto inteiro e é revalidada pelo schema do tipo; (6) `parentId` também recusa ciclo (a cadeia de ancestrais não pode passar pelo próprio item); (7) CAT-04/05 em item já no estado pedido → 200 sem nova versão, auditoria nem evento (mesma regra de ORG-04); (8) `CATALOG_MANAGE` é risco M: a sessão sem MFA só é recusada com `security.mfaPolicy = ALL` (POL-14), e `GESTOR_CONTRATACOES` também a tem (permissions.md §8); (9) a aba "Etiquetas" do SCR-109 (US-007/`TAG_MANAGE`) não faz parte desta entrega.

## Impacto técnico
- `metadata` validada por um schema Zod por `catalogType` (entities.md §5.9), resolvido dinamicamente por um registro `CatalogMetadataSchemas` no módulo `catalog`.
- `CatalogFacade.assertActive(catalogType, id)` é o ponto único reaproveitado por outros módulos (ex.: `process` em US-001) para validar referência ativa — mudanças de contrato aqui afetam todo o produto.
- Volume baixo por tenant (dezenas de itens por catálogo); sem riscos de performance.

## Backend
- **Módulo(s):** `catalog` (dono); usa `access` (`AccessFacade.assertCan('CATALOG_MANAGE')`) e `identity` (`IdentityFacade.mfaPolicy`) — exceção de nível registrada em decisions.md §3. Implementação: o schema de `metadata` por tipo (`catalogMetadataSchema`) e os contratos CAT-01..06 ficam em `packages/validation/src/catalog`, compartilhados com a SCR-109; o catálogo-base de sistema (84 itens, com `metadata`) em `catalog/domain/catalog-seed.ts`.
- **Casos de uso:** `CreateCatalogItemCommand`, `UpdateCatalogItemCommand`, `ActivateCatalogItemCommand`, `DeactivateCatalogItemCommand`, `ReorderCatalogItemsCommand`; `ListCatalogItemsQuery`.
- **Domínio:** `CatalogItem.create/update(props)` aplicando RN-TEN-59..63; `CatalogFacade.assertActive(catalogType, id)` reaproveitada por outros módulos.
- **Transação:** criação/edição/ativação/desativação/reordenação, auditoria e outbox na mesma transação com `app.tenant_id`. A reordenação trava as linhas do catálogo (`SELECT … FOR UPDATE` por `id`) para que reordenações concorrentes serializem. O seeder `catalog.items` (`TenantSeeder`, US-099) grava só os itens de sistema cujo `(catalogType, code)` ainda não existe (`ON CONFLICT DO NOTHING`), é idempotente e reaplicável a tenants existentes (`tenant:seed`); `verify()` fecha a etapa quando os 84 itens estão presentes.

## Frontend
- **Tela(s):** SCR-109 (`/admin/catalogos`).
- **Componentes:** `CatalogTypeTabs`, `CatalogItemTable` (arrastar para reordenar), `CatalogItemFormDialog` (campos dinâmicos de `metadata` por `catalogType`), `SystemBadge`.
- **Estados:** skeleton na lista; vazio ("Nenhum item neste catálogo"); erro com "Tentar novamente"; indicador de salvamento.
- **Acessibilidade e responsividade:** reordenação por arrastar tem alternativa por teclado ("Mover para cima/baixo"); diálogo em tela cheia em telas < 768 px.

## Banco de dados
- **Tabelas:** `catalog_items`.
- **Migrações:** `20261015260000_catalog_items` — enum `catalog_type` e tabela `catalog_items` (entities.md §4: check do formato do `code`, FK composta do pai `(tenant_id, catalog_type, parent_id)`, trigger de imutabilidade de tenant, catálogo, `code` e `is_system`, RLS, sem `DELETE`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, catalog_type, code)`; índice `(tenant_id, catalog_type, is_active, sort_order)`; `UNIQUE (tenant_id, catalog_type, id)` (alvo da FK do pai) e `UNIQUE (tenant_id, id)` (alvo das FKs de outros módulos — DEC-081).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| CAT-01 | GET | `/catalogs/{catalogType}/items` | `?isActive=&q=` | `200 { data: [CatalogItem], meta }` | 200 |
| CAT-02 | POST | `/catalogs/{catalogType}/items` | `{ code, label, description?, parentId?, metadata? }` | `201 { data: CatalogItem }` | 201, 403, 422 |
| CAT-03 | PATCH | `/catalog-items/{id}` | `{ label?, description?, parentId?, sortOrder?, metadata? }` + `If-Match` | `200 { data: CatalogItem }` | 200, 403, 404, 409, 412, 422, 428 |
| CAT-04 | POST | `/catalog-items/{id}/activate` | `If-Match` | `200 { data: CatalogItem }` | 200, 403, 404, 412 |
| CAT-05 | POST | `/catalog-items/{id}/deactivate` | `If-Match` | `200 { data: CatalogItem }` | 200, 403, 404, 412 |
| CAT-06 | PUT | `/catalogs/{catalogType}/order` | `{ orderedIds: [uuid] }` | `200 { data: [CatalogItem] }` | 200, 403, 422 |

## Logs
- `info` `catalog.item_created` / `catalog.item_updated` — `catalogType`, `catalogItemId`, `code`, `tenantId`, `userId`.
- `warn` `catalog.system_change_blocked` — tentativa de alterar `code`/excluir item de sistema.
- `error` `catalog.operation_failed` — `errorCode`, correlationId.
- **Nunca logar:** conteúdo de `description`/`metadata` além dos campos já citados.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `catalog.create` | `CONFIGURATION` | Commit de `CAT-02` | `changes`: `code`, `label`, `metadata` |
| `catalog.update` | `CONFIGURATION` | Commit de `CAT-03`, `CAT-04` (reativação) e `CAT-06` | `changes`: campos alterados / nova ordem |
| `catalog.deactivate` | `CONFIGURATION` | Commit de `CAT-05` | `metadata`: `catalogItemId` |

## Testes necessários
- **Unitários:** validação de `metadata` por `catalogType` (entities.md §5.9); imutabilidade de `code`; bloqueio de item de sistema.
- **Integração (Testcontainers PostgreSQL):** RLS impede leitura/escrita entre tenants; índice único `(tenant_id, catalog_type, code)`.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `ETag`/`If-Match`.
- **RBAC e multi-tenant:** com/sem `CATALOG_MANAGE`; `parentId` de outro tenant → 422 `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas edições simultâneas do mesmo item → uma 200, outra 412 `VERSION_CONFLICT`; reordenação concorrente não corrompe `sortOrder`.
- **E2E (Playwright):** criar, editar, desativar e reordenar itens em um catálogo.
- **Acessibilidade/performance:** axe na tela de catálogos; reordenação acessível por teclado.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `CATALOG_MANAGE` aplicado na API; ações de edição ocultas sem permissão
- [ ] Imutabilidade de `code` e proteção de itens de sistema cobertas por teste
- [ ] Auditoria `catalog.create`/`update`/`deactivate` e evento `CatalogItemChanged` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `CAT-01..06` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — oito catálogos com `metadata` tipada por tipo e um padrão de CRUD + ativação/desativação + reordenação já estabelecido; sem orquestração transacional complexa.

## Prioridade
**P0** — catálogos ativos são pré-condição para a criação de processos (US-001) e de vários documentos estruturados.
