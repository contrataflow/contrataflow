---
id: US-102
title: "Gerenciar secretarias e setores"
epic: EP-017
feature: FT-056
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-101]
modules: [organization, tenancy, access, audit, platform]
screens: [SCR-032]
endpoints: [DEP-01, DEP-02, DEP-03, DEP-04, DEP-05, DEP-06, DEP-07, DEP-08, DEP-09]
permissions: [DEPARTMENT_MANAGE]
events: [DepartmentCreated, DepartmentUpdated, DepartmentMoved, DepartmentDeactivated]
---

# US-102 — Gerenciar secretarias e setores

## Título
Gerenciar secretarias e setores

## Descrição
**Como** administrador do órgão, **quero** cadastrar e organizar secretarias, departamentos e setores em uma árvore por órgão, definindo tipo, titular e substituto de cada unidade, **para** que a criação de processos, a tramitação, as aprovações e a fila de trabalho encontrem sempre a unidade e o responsável corretos.

A gestão acontece na aba "Secretarias" de SCR-032: árvore navegável por órgão, com criar, editar, mover (arrastar ou diálogo), ativar/desativar e excluir (quando sem referências). Mover uma unidade recalcula o caminho de toda a subárvore na mesma transação; o sistema impede ciclos.

## Contexto
- A estrutura varia muito entre entes: prefeituras com secretarias → departamentos → setores; autarquias com dois ou três níveis; câmaras com "diretorias" no lugar de "secretarias" (rótulo configurável — US-103, `labels.secretariat`).
- DEC-011 define `Department` como unidade administrativa em árvore, com tipo configurável (`SECRETARIAT`, `BOARD`, `DEPARTMENT`, `DIVISION`, `SECTOR`, `COMMITTEE`, `OTHER`). "Secretaria solicitante" (RN-PROC-02, US-001) é a unidade de nível 1 (tipo `SECRETARIAT`/`BOARD` ou raiz); "setor solicitante" é qualquer unidade da subárvore.
- Titular (`headUserId`) e substituto (`deputyUserId`) não são só um cadastro: alimentam a resolução de aprovador `DEPARTMENT_HEAD` (POL-03, US-051/US-052), a regra de atribuição de processo (POL-05, US-050) e a fila da unidade na caixa de tarefas (US-056, RN-INBOX-04). Manter esses campos corretos é prioridade.
- Provisionamento (US-099) não cria unidades obrigatórias; o assistente de implantação sugere uma estrutura mínima, mas o cadastro completo é desta story.

## Objetivo
Permitir que o administrador monte a árvore completa de um órgão (criação, edição, movimentação, titular/substituto, ativação/inativação) sem inconsistências de ciclo ou duplicidade, disponibilizando a estrutura para processos, aprovações e filas desde o primeiro cadastro.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Demais perfis como leitores implícitos (seletores de unidade em processos, aprovações, atribuição).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` com `DEPARTMENT_MANAGE`.
- Existe ao menos um `Organization` ativo (US-101).

## Fluxo principal
1. O administrador acessa SCR-032, aba "Secretarias", seleciona o órgão; o sistema carrega a árvore (`DEP-01`).
2. Clica em **"Nova unidade"** (na raiz ou sob uma unidade existente), escolhe tipo, nome, sigla, código, titular e substituto (busca por `GET /departments/lookup`/`/users/lookup`).
3. O front valida (Zod) e envia `POST /api/v1/departments` (`DEP-03`) com `parentId` (vazio = raiz).
4. A API valida unicidade, pertencimento ao mesmo órgão, titular/substituto elegíveis, calcula `path`/`depth`, insere o `Department`, grava `department.create` e publica `DepartmentCreated`.
5. A árvore é atualizada com a nova unidade; o administrador pode repetir para montar toda a estrutura.
6. Para editar, abre a unidade (`DEP-04`), altera campos e salva (`PATCH` `DEP-05`, com `If-Match`).
7. Para mover, arrasta a unidade ou usa "Mover para…"; o front envia `POST /departments/{id}/move` (`DEP-06`) com o novo `parentId`; a API valida ausência de ciclo, recalcula `path`/`depth` de toda a subárvore na mesma transação e publica `DepartmentMoved`.
8. Para desativar/ativar, usa o menu de ações (`DEP-07`/`DEP-08`).
9. Para excluir uma unidade sem uso (criada por engano), usa "Excluir" (`DEP-09`); sem referências, a API remove definitivamente; com referências, orienta a desativar.

## Fluxos alternativos
- **FA-01 — Unidade raiz sem secretaria:** órgãos pequenos podem ter um único nível (`parentId` nulo, qualquer `type`); essa unidade conta como "Secretaria" para RN-PROC-02.
- **FA-02 — Mover criaria ciclo:** o sistema bloqueia e explica "Não é possível mover uma unidade para dentro dela mesma ou de uma subunidade".
- **FA-03 — Titular sem vínculo elegível:** ao salvar `headUserId` de alguém sem lotação nem escopo sobre a unidade, a API rejeita com orientação para lotar a pessoa primeiro (US-093) ou escolher outra.
- **FA-04 — Desativar unidade com processos em andamento:** permitido; processos existentes mantêm acesso histórico (DEC-024, `access.historicalDepartmentsCanView`); a unidade só some das opções de **novos** vínculos e processos.
- **FA-05 — Excluir unidade referenciada:** bloqueado com `DEPARTMENT_HAS_REFERENCES`; a UI sugere "Desativar" em vez de excluir.
- **FA-06 — Rótulo customizado:** telas exibem "Secretaria"/"Setor" conforme `labels.secretariat`/`labels.department` (US-103); por padrão, esses textos.

## Regras de negócio
- **RN-TEN-44** — Obrigatórios: `organizationId`, `type`, `name`; `parentId` deve pertencer ao mesmo `organizationId` (senão `VALIDATION_ERROR`/`REFERENCE_NOT_FOUND`); uma unidade não pode ser pai de si mesma.
- **RN-TEN-45** — `path`/`depth` são calculados e mantidos exclusivamente pela aplicação (nunca aceitos do cliente): raiz tem `depth = 0`; cada filho herda `path` do pai + o próprio `id`.
- **RN-TEN-46** — Mover (`DEP-06`): o novo `parentId` não pode ser a própria unidade nem um descendente dela (`DEPARTMENT_CYCLE`, 422) nem de outro órgão (`REFERENCE_NOT_FOUND`); a subárvore inteira é recalculada (`path`/`depth`) na mesma transação.
- **RN-TEN-47** — Unicidade: `acronym` único por `(tenant, organizationId)` quando informado; `name` único entre unidades de mesmo `parentId` (ou raízes do órgão), sem diferenciar maiúsculas/minúsculas.
- **RN-TEN-48** — `headUserId` ≠ `deputyUserId`; cada um, quando informado, exige `TenantMembership` `ACTIVE` não expirado com lotação na própria unidade **ou** `RoleAssignment` com escopo `DEPARTMENT`/`OWN_DEPARTMENTS`/`ORGANIZATION`/`TENANT` que a cubra — senão `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) no campo. Consumidos por POL-05 (atribuição, US-050), resolução de aprovador `DEPARTMENT_HEAD` (POL-03, US-051/US-052) e fila da unidade (US-056, RN-INBOX-04); alterar o titular não afeta aprovações já resolvidas (snapshot em `Approval.approverUserId`).
- **RN-TEN-49** — "Secretaria" (RN-PROC-02, US-001) = unidades `type` `SECRETARIAT`/`BOARD` ou raízes (`depth = 0`) do órgão; rótulo exibido conforme `labels.secretariat`/`labels.department` (US-103).
- **RN-TEN-50** — Desativar (`DEP-07`): `isActive = false`; a unidade não recebe novos processos nem novas lotações; acesso histórico mantido (DEC-024). Ativar (`DEP-08`) exige `organizationId` com `isActive = true` (senão `VALIDATION_ERROR`/`REFERENCE_INACTIVE`).
- **RN-TEN-51** — Excluir (`DEP-09`) somente sem nenhuma referência: sem sub-unidades, sem processo (`requestingDepartmentId`/`currentDepartmentId`), sem `ProcessAccess`, sem lotação ativa, sem ser `headUserId`/`deputyUserId` de outra unidade e sem regra de etapa `departmentResolution = FIXED` apontando para ela; caso contrário `DEPARTMENT_HAS_REFERENCES` (409); exclusão é física (`ON DELETE RESTRICT` nas FKs garante a checagem).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Órgão | `organizationId` | seleção | Sim | ativo | órgão da tela |
| Unidade superior | `parentId` | seleção em árvore | Não | RN-TEN-44/46 | vazio = raiz |
| Tipo | `type` | seleção (`DepartmentType`) | Sim | enum | — |
| Nome | `name` | texto curto | Sim | 3–200; único entre irmãos | — |
| Sigla | `acronym` | texto curto | Não | até 30; único no órgão | — |
| Código | `code` | texto curto | Não | até 40 | — |
| E-mail da unidade | `email` | e-mail | Não | formato válido | — |
| Telefone | `phone` | texto curto | Não | até 20 | — |
| Titular | `headUserId` | seleção (lookup) | Não | RN-TEN-48 | — |
| Substituto | `deputyUserId` | seleção (lookup) | Não | RN-TEN-48; ≠ titular | — |
| Ativa | `isActive` | interruptor | — | RN-TEN-50 | `true` |
| Ordem | `sortOrder` | número | Não | — | `0` |
| *(sistema)* Caminho/profundidade | `path`, `depth` | — | — | RN-TEN-45 | calculados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios ausentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | `parentId` de outro órgão ou inexistente | API | "Selecione uma unidade superior válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | Nome duplicado entre irmãos | API | "Já existe uma unidade com este nome no mesmo nível." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-04 | Sigla duplicada no órgão | API | "Esta sigla já está em uso no órgão." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-05 | Mover geraria ciclo | API | "Não é possível mover uma unidade para dentro dela mesma ou de uma subunidade." | `DEPARTMENT_CYCLE` |
| V-06 | Titular/substituto sem lotação nem escopo na unidade | Front + API | "Esta pessoa não está lotada nem tem escopo sobre a unidade." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-07 | Titular e substituto iguais | Front + API | "Titular e substituto devem ser pessoas diferentes." | `VALIDATION_ERROR` |
| V-08 | Excluir unidade referenciada | API | "Esta unidade está em uso e não pode ser excluída. Desative-a." | `DEPARTMENT_HAS_REFERENCES` |
| V-09 | Ativar sob órgão inativo | API | "O órgão desta unidade está inativo." | `VALIDATION_ERROR` (`REFERENCE_INACTIVE`) |

## Permissões
- **Permissão:** `DEPARTMENT_MANAGE`, risco `M`, sem variação de escopo (sempre `TENANT`).
- **Políticas:** nenhuma própria; leitura (`DEP-01/02/04`) é capacidade implícita de qualquer vínculo `ACTIVE`.
- **MFA:** não exigido (risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** ações de criar/editar/mover/(des)ativar/excluir ocultas; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DepartmentCreated` | `department.created` | Commit da criação | `departmentId` |
| `DepartmentUpdated` | `department.updated` | Commit de edição ou ativação | `departmentId`, `changedFields[]` |
| `DepartmentMoved` | `department.moved` | Commit do `move` | `departmentId`, `fromParentId?`, `toParentId?` |
| `DepartmentDeactivated` | `department.deactivated` | Commit da desativação | `departmentId` |

`PermissionCacheInvalidator` consome `department.moved` para invalidar escopos `DEPARTMENT`/`OWN_DEPARTMENTS` em cache.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; mudanças de estrutura não notificam usuários finais no MVP 1. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar secretarias e setores

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com o órgão "Prefeitura Municipal"
    And "Carla" possui o perfil "ADMIN_ORGAO" com escopo "TENANT"

  Scenario: [Sucesso] Criar uma secretaria na raiz
    When "Carla" criar a unidade "Secretaria de Obras", tipo "SECRETARIAT", sem unidade superior
    Then a unidade deve ser criada com "depth" igual a 0 e "isActive" verdadeiro
    And deve gerar registro de auditoria "department.create"
    And deve gerar o evento "DepartmentCreated"

  Scenario: [Validação] Titular sem lotação nem escopo na unidade
    Given que "Pedro" não tem lotação nem escopo sobre a "Secretaria de Obras"
    When "Carla" definir "Pedro" como titular da "Secretaria de Obras"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "headUserId"

  Scenario: [Permissão] Usuário sem DEPARTMENT_MANAGE
    Given que "Bruno" não possui "DEPARTMENT_MANAGE"
    When "Bruno" enviar POST para "/api/v1/departments"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Referência a unidade de outro tenant
    Given que existe a unidade "Setor X" no tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar "parentId" do "Setor X"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "parentId"
    And a resposta não deve revelar que a unidade existe em outro tenant

  Scenario: [Duplicidade] Sigla repetida no mesmo órgão
    Given que já existe a unidade de sigla "SOB" no órgão "Prefeitura Municipal"
    When "Carla" criar outra unidade com sigla "SOB" no mesmo órgão
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_FORMAT" no campo "acronym"

  Scenario: [Concorrência] Mover duas unidades para o mesmo destino simultaneamente
    Given que "Setor A" e "Setor B" estão sob "Secretaria de Obras"
    When dois administradores moverem "Setor A" para dentro de "Setor B" e "Setor B" para dentro de "Setor A" ao mesmo tempo
    Then apenas uma movimentação deve ser aplicada
    And a outra deve falhar com "DEPARTMENT_CYCLE" ou "VERSION_CONFLICT"
    And a árvore deve permanecer sem ciclos

  Scenario: [Falha de banco] Banco indisponível ao mover
    Given que o banco de dados está indisponível
    When "Carla" tentar mover uma unidade
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And "path"/"depth" da subárvore não devem ser alterados

  Scenario: [Falha de integração] Outbox indisponível ao criar
    Given que o relay do outbox está indisponível
    When "Carla" criar uma unidade válida
    Then a unidade deve ser criada e a API deve responder 201
    And o evento "DepartmentCreated" deve permanecer "PENDING" até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Campo obrigatório ausente | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos |
| `parentId`/`headUserId`/`deputyUserId` inválidos | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um valor válido." | Recarrega opções |
| Mover geraria ciclo | 422 | `DEPARTMENT_CYCLE` | "Esta movimentação criaria um ciclo." | Cancela o arrastar |
| Excluir com referências | 409 | `DEPARTMENT_HAS_REFERENCES` | "Esta unidade está em uso. Desative-a em vez de excluir." | Oferece "Desativar" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar a estrutura." | Oculta ações |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Esta unidade foi alterada por outra pessoa. Recarregue." | Recarrega nó da árvore |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Mantém árvore anterior |

## Dependências
- **Stories:** US-101 (órgão ativo); usada por US-001 (RN-PROC-02/03), US-050 (POL-05), US-051/US-052 (`DEPARTMENT_HEAD`, POL-03), US-056 (fila da unidade, RN-INBOX-04), US-093 (lotação).
- **Decisões/ADRs:** DEC-011, DEC-024, DEC-080..083, DEC-104; ADR-002.
- **Configurações:** `labels.secretariat`, `labels.department`, `access.historicalDepartmentsCanView` (US-103).
- **Lacunas nas fontes canônicas:** nenhuma — campos, enums e códigos de erro necessários já existem em entities.md/api.md.

## Impacto técnico
- Caminho materializado (`path`) com índice `text_pattern_ops`: consultas de subárvore (`WHERE path LIKE 'prefix%'`) em O(log n); mover uma subárvore grande é O(tamanho da subárvore) na mesma transação — deve permanecer rápido mesmo em estruturas com centenas de unidades.
- Mudança de `headUserId`/`deputyUserId` ou `department.moved` deve invalidar caches de escopo (`PermissionCacheInvalidator`) para refletir imediatamente em POL-03/POL-05 e na fila (US-056).
- Reaproveita o padrão transacional de US-001.

## Backend
- **Módulo(s):** `organization` (dono); usa `access` (`AuthorizationService`, invalidação de cache de escopo), `tenancy` (`Organization.assertActive`).
- **Casos de uso:** `CreateDepartmentCommand`, `UpdateDepartmentCommand`, `MoveDepartmentCommand`, `ActivateDepartmentCommand`, `DeactivateDepartmentCommand`, `DeleteDepartmentCommand`; `ListDepartmentsQuery`, `LookupDepartmentsQuery`, `GetDepartmentQuery`.
- **Domínio:** `Department.create/update/move(props)` aplicando RN-TEN-44..51; `DepartmentTree` (serviço de recálculo de `path`/`depth` por subárvore).
- **Transação:** criação/edição/movimentação, auditoria e outbox na mesma transação; `move` bloqueia as linhas da subárvore (`SELECT … FOR UPDATE`) para evitar condição de corrida com outro `move` concorrente.

## Frontend
- **Tela(s):** SCR-032 (`/admin/estrutura`), aba "Secretarias".
- **Componentes:** `DepartmentTree` (arrastar e soltar, expandir/colapsar), `DepartmentFormDialog`, `UserLookupSelect` (titular/substituto), `MoveDepartmentDialog`.
- **Estados:** skeleton na árvore; vazio ("Nenhuma unidade cadastrada para este órgão"); erro com "Tentar novamente"; indicador de movimentação em progresso.
- **Acessibilidade e responsividade:** árvore navegável por teclado (setas/Enter); "Mover para…" como alternativa acessível ao arrastar; em telas < 768 px, árvore em lista indentada.

## Banco de dados
- **Tabelas:** `departments`.
- **Migrações:** nenhuma nova (tabela já definida em entities.md §4).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, organization_id, acronym) WHERE acronym IS NOT NULL`; `UNIQUE (tenant_id, organization_id, COALESCE(parent_id, '0…0'), lower(name))`; índice `(tenant_id, path text_pattern_ops)`; checks `head_user_id IS DISTINCT FROM deputy_user_id` e `parent_id <> id`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DEP-01 | GET | `/departments` | `?organizationId=&isActive=&q=` | `200 { data: [Department], meta }` (árvore ou lista plana) | 200 |
| DEP-02 | GET | `/departments/lookup` | `?organizationId=&q=` | `200 { data: [{ id, name, type, path }] }` | 200 |
| DEP-03 | POST | `/departments` | `{ organizationId, parentId?, type, name, acronym?, code?, email?, phone?, headUserId?, deputyUserId? }` | `201 { data: Department }` | 201, 403, 422 |
| DEP-04 | GET | `/departments/{id}` | — | `200 { data: Department }` | 200, 403, 404 |
| DEP-05 | PATCH | `/departments/{id}` | Campos de `DEP-03` + `If-Match` | `200 { data: Department }` | 200, 403, 404, 412, 422, 428 |
| DEP-06 | POST | `/departments/{id}/move` | `{ parentId }` + `If-Match` | `200 { data: Department }` | 200, 403, 404, 412, 422 (`DEPARTMENT_CYCLE`) |
| DEP-07 | POST | `/departments/{id}/deactivate` | `If-Match` | `200 { data: Department }` | 200, 403, 404, 412 |
| DEP-08 | POST | `/departments/{id}/activate` | `If-Match` | `200 { data: Department }` | 200, 403, 404, 412, 422 (`REFERENCE_INACTIVE`) |
| DEP-09 | DELETE | `/departments/{id}` | `If-Match` | `204` | 204, 403, 404, 409 (`DEPARTMENT_HAS_REFERENCES`), 412 |

## Logs
- `info` `department.created` / `.updated` / `.moved` / `.deactivated` — `departmentId`, `organizationId`, `tenantId`, `userId`, `correlationId`.
- `warn` `department.move_blocked_cycle` — tentativa de mover para descendente.
- `error` `department.save_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** e-mail/telefone da unidade.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `department.create` | `DATA_CHANGE` | Commit da criação | `changes`: campos iniciais |
| `department.update` | `DATA_CHANGE` | Commit de edição ou ativação | `changes`: anterior/novo dos campos alterados |
| `department.move` | `DATA_CHANGE` | Commit do `move` | `metadata`: `fromParentId`, `toParentId`, quantidade de descendentes recalculados |
| `department.deactivate` | `DATA_CHANGE` | Commit da desativação | — |
| `department.delete` | `DATA_CHANGE` | Commit da exclusão | `metadata`: dados da unidade removida |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = DEPARTMENT_MANAGE` |

## Testes necessários
- **Unitários:** `DepartmentTree` (cálculo de `path`/`depth`, detecção de ciclo); RN-TEN-44..51.
- **Integração (Testcontainers):** mover subárvore de 3 níveis recalcula todos os descendentes em uma transação; `DEPARTMENT_HAS_REFERENCES` com processo/lotação/sub-unidade; RLS entre tenants.
- **API/contrato:** respostas e erros de `DEP-01..09` conforme api.md.
- **RBAC e multi-tenant:** com/sem `DEPARTMENT_MANAGE`; referência de outro tenant/órgão → `REFERENCE_NOT_FOUND`.
- **Concorrência:** dois `move` cruzados simultâneos (cenário Gherkin acima); duas edições do mesmo nó.
- **E2E (Playwright):** montar árvore de 3 níveis, mover por arrastar, desativar e tentar excluir unidade em uso.
- **Acessibilidade/performance:** axe na árvore; árvore com 300 unidades carrega e expande sem bloquear a UI.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `DEPARTMENT_MANAGE` aplicado na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de DEP-01..09 atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — árvore com movimentação transacional, detecção de ciclo e regras de titular/substituto consumidas por três outras stories; sem concorrência de numeração.

## Prioridade
**P0** — pré-requisito direto da criação de processos (US-001) e da fila de trabalho por unidade (US-056).
