---
id: US-054
title: "Histórico de tramitações"
epic: EP-008
feature: FT-035
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-047]
modules: [process, access, audit]
screens: [SCR-006]
endpoints: [PRC-11]
permissions: [PROCESS_VIEW, AUDIT_VIEW]
events: []
---

# US-054 — Histórico de tramitações

## Título
Consultar o histórico de tramitações do processo

## Descrição
**Como** qualquer pessoa com visibilidade do processo, **quero** consultar o histórico completo de tramitações — quem agiu, quando, de onde para onde, com qual comentário, prazo e documentos —, **para** entender a linha do tempo processual e prestar contas, sem precisar reconstruir a história a partir de despachos físicos ou memória de quem participou.

A aba **"Tramitação"** de SCR-006 lista, em ordem cronológica inversa e paginada, cada `ProcessMovement` já registrado pelas demais stories do épico (criação, encaminhamento, devolução, assunção, atribuição, decisões de aprovação, retiradas, suspensão/retomada, cancelamento, conclusão). O campo de IP de origem só é exibido a quem tem `AUDIT_VIEW`; os demais campos seguem a mesma visibilidade do processo.

## Contexto
- Hoje, em processos físicos, a tramitação é reconstruída por despachos manuscritos, carimbos e memória dos envolvidos — fonte comum de divergência em auditorias e no Controle Interno (Lei 14.133/2021, art. 169).
- `ProcessMovement` (DEC-010, DEC-014) é **imutável** e já concentra todos os dados exigidos — origem, destino, usuário, data/hora, comentário, prazo, documentos, IP, metadata — desde a primeira escrita em US-047. Esta story é a **leitura** consolidada desse registro; não introduz nenhuma escrita nova.
- Toda transição de etapa/status registrada pelas stories US-047 a US-053 (e pelas futuras US-008/009/010 de ciclo de vida) aparece aqui automaticamente, sem exigir mudança nesta story quando novas ações forem adicionadas ao `MovementAction`.
- Visibilidade segue DEC-024 (a mesma regra que decide se o usuário vê o processo decide se ele vê a tramitação); o IP é tratado como dado sensível de acesso, restrito a quem tem `AUDIT_VIEW` (consistente com o tratamento de dados de auditoria em geral).

## Objetivo
Permitir que qualquer pessoa com visibilidade do processo reconstrua sua linha do tempo completa em até 1 s (p95, até 1.000 tramitações, com paginação), sem exigir consulta a outra tela ou a terceiros.

## Persona
- **Principal:** qualquer usuário com visibilidade do processo (`PROCESS_VIEW` em algum escopo, ou `ProcessAccess` individual — DEC-024).
- **Secundária:** Controle Interno/Auditoria (`AUDIT_VIEW`), que adicionalmente vê o IP de origem de cada ação.

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`.
- Processo visível ao usuário (DEC-024); caso contrário, **404**.

## Fluxo principal
1. O usuário abre o processo (SCR-006) e seleciona a aba **"Tramitação"**.
2. O front chama `GET /api/v1/processes/{id}/movements` (`PRC-11`) com paginação por cursor (`?cursor=&limit=50`), ordenação padrão `sequence` decrescente (mais recente primeiro).
3. A API:
   1. verifica a visibilidade do processo (DEC-024); se não visível, **404** `PROCESS_NOT_FOUND`;
   2. busca a página de `ProcessMovement` do processo pelo índice `(tenant_id, process_id, occurred_at DESC)`;
   3. hidrata, em lote (sem N+1), os nomes de etapas (`WorkflowStage.name`), unidades (`Department.name`) e usuários (`User.name`) referenciados pelos ids armazenados no movimento;
   4. inclui o campo `ip` somente se o usuário tiver `AUDIT_VIEW`; caso contrário, o campo retorna `null`;
   5. para movimentos com `approvalId`, inclui um resumo da aprovação (`title`, `decision` quando já decidida) para permitir o link "Ver decisão".
4. A API responde **200** com a página (`data[]` + `meta: { nextCursor, hasMore }`).
5. O front renderiza a linha do tempo: ícone por `action`, "de → para" (etapa/unidade/usuário), ator, comentário, documentos anexados (link para a versão exata), prazo atribuído e, quando houver, o link da aprovação. Rola para carregar mais páginas (infinite scroll) ou usa paginação explícita.

## Fluxos alternativos
- **FA-01 — Filtros combinados:** o usuário filtra por ação (`action` — múltiplos valores, OU), unidade de origem/destino, ator ou período (`occurredFrom`/`occurredTo`); os filtros são combinados com E, conforme api.md §1.2.
- **FA-02 — Usuário sem `AUDIT_VIEW`:** a coluna/campo "IP" não é exibido na interface (em vez de mostrar vazio); o front simplesmente omite a coluna quando `meta.canViewIp = false`.
- **FA-03 — Movimento vinculado a uma decisão de aprovação:** a linha exibe o selo "Decisão de aprovação" com link para `/aprovacoes/{approvalId}` (US-052).
- **FA-04 — Processo ainda em `DRAFT`:** a lista mostra apenas o registro `CREATE` (US-001).
- **FA-05 — Unidade ou usuário referenciado foi posteriormente inativado:** como `Department`/`User` usam exclusão lógica (`+SD`), o nome histórico continua disponível; a interface exibe o nome com o selo "(inativo)".
- **FA-06 — Processo sem nenhuma tramitação visível a filtros aplicados:** exibe o estado vazio "Nenhuma tramitação encontrada para os filtros selecionados." com atalho para limpar os filtros.

## Regras de negócio
- **RN-TRAM-72** — A listagem traz todas as `ProcessMovement` do processo, ordenadas por `sequence` decrescente por padrão (mais recente primeiro); `sequence` é a numeração canônica, sequencial e sem lacunas (1..n).
- **RN-TRAM-73** — Cada item expõe: `action`, etapa/unidade/usuário de origem e destino (nomes hidratados a partir dos ids no momento da consulta — o registro em si não armazena nomes), `statusFrom`/`statusTo`, ator (`actorType`, `actorId`, `actorDepartmentId`), `comment`, `dueAt` atribuído, `documents[]` (snapshot `MovementDocumentRef`), `approvalId` (quando houver) e `occurredAt`.
- **RN-TRAM-74** — O campo `ip` só é retornado para usuários com `AUDIT_VIEW`; para os demais, o campo é `null`. `userAgent` e `correlationId` seguem a visibilidade normal de `PROCESS_VIEW` (não são restritos).
- **RN-TRAM-75** — Filtros suportados: `action` (lista, OU), `fromDepartmentId`, `toDepartmentId`, `actorId`, `occurredFrom`/`occurredTo` (inclusivos); paginação por cursor (`cursor`, `limit`, máx. 100) conforme api.md §1.2.
- **RN-TRAM-76** — A consulta é somente leitura; nenhuma tramitação pode ser criada, editada ou excluída por este endpoint (`ProcessMovement` é imutável — entities.md §4.4, trigger de banco bloqueia `UPDATE`/`DELETE`).
- **RN-TRAM-77** — A visibilidade do histórico é exatamente a visibilidade do processo (DEC-024): não existe uma permissão de tramitação separada da visibilidade do processo, exceto a restrição adicional de IP (RN-TRAM-74).

## Campos
| Campo (resposta) | Campo técnico | Tipo | Sempre exibido | Regras | Origem |
|---|---|---|---|---|---|
| Ação | `action` | enum (`MovementAction`) | Sim | — | `process_movements.action` |
| De / Para (etapa, unidade, usuário) | `fromStage`/`toStage`, `fromDepartment`/`toDepartment`, `fromUser`/`toUser` | objetos `{id, name}` | Sim (quando aplicável à ação) | nomes hidratados na leitura | ids em `process_movements` |
| Status de / para | `statusFrom`/`statusTo` | enum (`ProcessStatus`) | Quando houver mudança | — | `process_movements` |
| Ator | `actor` | objeto `{type, id, name, departmentName}` | Sim | `ActorType` | `process_movements.actor*` |
| Comentário | `comment` | texto | Quando informado | obrigatório na origem para `RETURN`/`REJECT`/`CANCEL`/`SUSPEND` | `process_movements.comment` |
| Prazo atribuído | `dueAt` | datetime | Quando houver | — | `process_movements.due_at` |
| Documentos | `documents` | lista `MovementDocumentRef` | Quando houver | — | `process_movements.documents` |
| Aprovação vinculada | `approvalId`, `approvalSummary` | uuid / objeto | Quando houver | FA-03 | `process_movements.approval_id` |
| Data/hora | `occurredAt` | datetime (ISO 8601 UTC) | Sim | — | `process_movements.occurred_at` |
| IP de origem | `ip` | string \| null | Só com `AUDIT_VIEW` | RN-TRAM-74 | `process_movements.ip` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `action` fora do enum `MovementAction` | Front + API | "Filtro de ação inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | `occurredFrom` posterior a `occurredTo` | Front + API | "O período inicial deve ser anterior ao final." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-03 | `limit` acima do máximo (100) | API | — (front ajusta automaticamente) | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-04 | `cursor` inválido ou expirado | API | "Não foi possível continuar a lista. Recarregue." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |

## Permissões
- **Permissão:** `PROCESS_VIEW` (em qualquer escopo que torne o processo visível) **ou** concessão individual via `ProcessAccess` (DEC-024). `AUDIT_VIEW` adicional para o campo `ip`.
- **Políticas:** DEC-024 (visibilidade de processos) — nenhuma política contextual extra.
- **MFA:** não exigido (consulta de leitura).
- **Sem permissão:** processo não visível → **404** `PROCESS_NOT_FOUND` (nunca revela a existência do processo); visível mas sem `AUDIT_VIEW` → histórico completo, exceto `ip` (não é erro, é omissão de campo).

## Eventos gerados
Nenhum. Consulta de leitura; não produz eventos de domínio nem altera estado.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma — consulta somente leitura. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Histórico de tramitações

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" tem 5 tramitações registradas: CREATE, FORWARD, RETURN, FORWARD, APPROVE
    And "Ana" tem "PROCESS_VIEW" com escopo que cobre o processo

  Scenario: [Sucesso] Listar o histórico em ordem cronológica inversa
    When "Ana" abrir a aba "Tramitação"
    Then as 5 tramitações devem aparecer da mais recente para a mais antiga
    And cada item deve mostrar ação, origem, destino, ator, comentário (quando houver) e data/hora

  Scenario: [Validação] Filtro de ação inválido
    When "Ana" filtrar por uma ação que não existe no enum
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "action"

  Scenario: [Permissão] Usuário sem AUDIT_VIEW não vê o IP de origem
    Given que "Ana" não possui "AUDIT_VIEW"
    When "Ana" consultar o histórico
    Then cada item deve retornar o campo "ip" como nulo
    And a interface não deve exibir a coluna de IP

  Scenario: [Permissão] Auditor com AUDIT_VIEW vê o IP de origem
    Given que "Rafael" possui "AUDIT_VIEW"
    When "Rafael" consultar o histórico
    Then cada item deve retornar o "ip" registrado na tramitação

  Scenario: [Tenant incorreto] Processo de outro tenant
    Given que o processo "0099/2026" pertence ao tenant "Prefeitura B"
    When um usuário do tenant "Prefeitura de São José" consultar "/processes/0099.../movements"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Duplicidade] Repetir a mesma consulta não altera o histórico
    When "Ana" consultar a mesma página duas vezes seguidas
    Then as duas respostas devem conter exatamente os mesmos itens
    And nenhuma tramitação deve ser duplicada ou criada pela consulta

  Scenario: [Concorrência] Nova tramitação ocorre durante a paginação
    Given que "Ana" está navegando pela página 2 (cursor "C2")
    When uma nova tramitação for registrada no processo por outro usuário
    Then continuar a paginação a partir de "C2" não deve repetir nem omitir itens já listados

  Scenario: [Falha de banco] Banco indisponível durante a consulta
    Given que o banco de dados fica indisponível
    When "Ana" abrir a aba "Tramitação"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a interface deve exibir "Não foi possível carregar o histórico agora." com botão "Tentar novamente"

  Scenario: [Falha de integração] Cache de permissões indisponível
    Given que o Redis (cache de permissões) está indisponível
    When "Ana" consultar o histórico
    Then a lista deve ser retornada normalmente
    And o campo "ip" deve ser tratado como não autorizado por padrão (postura segura) até o cache se recuperar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Filtro inválido | 422 | `VALIDATION_ERROR` | "Revise os filtros aplicados." | Marca o filtro inválido |
| Cursor inválido/expirado | 422 | `VALIDATION_ERROR` (`INVALID_FORMAT`) | "Não foi possível continuar a lista. Recarregue." | Reinicia a paginação do início |
| Processo não visível/outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Redireciona para a lista de processos |
| Vínculo/tenant inativo | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso não está ativo." | Redireciona para SCR-111 |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Indisponibilidade crítica | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar o histórico agora." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-047 (origem do primeiro `ProcessMovement` além da criação), US-048/US-049/US-050 (demais ações já cobertas por este histórico), US-052/US-053 (ações de aprovação com `approvalId`), US-073 (auditoria e `AUDIT_VIEW`).
- **Decisões/ADRs:** DEC-010, DEC-013, DEC-024.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma — `ProcessMovement` (entities.md §4.4) e `PRC-11` (catálogo de endpoints do pacote) já cobrem integralmente esta story.

## Impacto técnico
- Risco principal é **N+1** na hidratação de nomes (etapa, unidade, usuário) por item da página; usar carregamento em lote (`DataLoader`/`IN (...)`) por página, nunca por item.
- Paginação por cursor usa `sequence` (estável mesmo com novas tramitações concorrentes) em vez de offset, evitando itens duplicados/perdidos durante a rolagem (DEC-106).
- Índice `(tenant_id, process_id, occurred_at DESC)` já existe (entities.md §4.4) e é suficiente; nenhuma migração nova.
- A restrição de IP é aplicada na camada de apresentação (`ProcessMovementPresenter`), nunca no banco — evita duplicar a regra em múltiplos pontos.

## Backend
- **Módulo(s):** `process` (dono, leitura); usa `access` (`AuthorizationService` para `PROCESS_VIEW`/DEC-024), `identity`/`organization` (hidratação de nomes de usuário/unidade), `audit` (checagem de `AUDIT_VIEW`).
- **Casos de uso:** `ListProcessMovementsQuery` → `ListProcessMovementsHandler`.
- **Domínio:** nenhuma regra de escrita; apenas projeção de leitura sobre `ProcessMovement` (já imutável).
- **Transação:** nenhuma (leitura; `READ COMMITTED` padrão).

## Frontend
- **Tela(s):** SCR-006, aba "Tramitação" (`/processos/[id]`).
- **Componentes:** `MovementTimeline`, `MovementFilterBar` (ação, unidade, ator, período), `MovementRow` (ícone por `action`), `ApprovalLinkBadge`, `EmptyState`.
- **Dados:** TanStack Query infinite query `['t', tenantId, 'processes', id, 'movements', filters]` (cursor-based), `staleTime` curto (30 s, a lista cresce com a atividade do processo).
- **Estados:** skeleton na primeira carga; estado vazio com filtros aplicados; erro com "Tentar novamente"; indicador de carregamento ao avançar páginas.
- **Acessibilidade e responsividade:** lista como estrutura semântica navegável por teclado (cada item focável), `aria-live` ao carregar mais itens; filtros colapsam em painel no mobile (< 768 px).

## Banco de dados
- **Tabelas:** `process_movements` (leitura); `workflow_stages`, `departments`, `users` (leitura para hidratação).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** `(tenant_id, process_id, occurred_at DESC)` (já existente, usado pela paginação); `(tenant_id, process_id, sequence)` único (garante estabilidade do cursor).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-11 | GET | `/api/v1/processes/{id}/movements` | `?cursor?&limit?&action?&fromDepartmentId?&toDepartmentId?&actorId?&occurredFrom?&occurredTo?` | `200 { data: MovementItem[], meta: { nextCursor, hasMore, canViewIp } }` | 200, 401, 403, 404, 422, 429, 500, 503 |

## Logs
- `info` `process.movements_listed` — `processId`, `itemCount`, `durationMs`, `correlationId`.
- `warn` `process.movements_hydration_partial` — quando um id referenciado (unidade/usuário) não pôde ser hidratado (nome ausente); a API retorna o id com nome `null` em vez de falhar a lista inteira.
- `error` `process.movements_list_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo de `comment` nem IP em texto claro nos logs de aplicação (fica apenas no dado retornado à UI autorizada).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | Processo não visível ou vínculo inativo | `reasonCode = PROCESS_VIEW`, `processId` |

Não há ação de auditoria dedicada para a simples consulta do histórico (leitura comum, como as demais consultas auxiliares do produto); o acesso aos dados de auditoria propriamente ditos é tratado por `audit.search` (US-073), fora desta story.

## Testes necessários
- **Unitários:** hidratação em lote (sem N+1); omissão do campo `ip` sem `AUDIT_VIEW`; parsing de filtros e cursor.
- **Integração (Testcontainers):** RLS impede leitura de `process_movements` de outro tenant; paginação estável com inserções concorrentes; índice usado pelo plano de consulta (`EXPLAIN`).
- **API/contrato:** resposta e erros conforme api.md; `meta.nextCursor`/`hasMore`/`canViewIp`.
- **RBAC e multi-tenant:** usuário com/sem `AUDIT_VIEW`; usuário sem visibilidade do processo → 404; processo de outro tenant → 404.
- **Concorrência:** 1.000 tramitações pré-existentes + inserções durante a paginação → nenhum item duplicado/perdido.
- **E2E (Playwright):** abrir aba, filtrar, paginar, abrir decisão de aprovação vinculada.
- **Acessibilidade/performance:** axe na aba; p95 < 1 s com 1.000 tramitações e `limit = 50`.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando no CI
- [ ] `PROCESS_VIEW`/DEC-024 aplicados na API; `AUDIT_VIEW` restringe o campo `ip`
- [ ] Hidratação em lote verificada (sem N+1) em teste de performance
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-11 compatível com api.md
- [ ] Logs sem dados sensíveis (comentário e IP nunca em texto claro nos logs)
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — é uma projeção de leitura sobre um agregado já existente e imutável (`ProcessMovement`); a complexidade está na hidratação eficiente, nos filtros e na paginação estável, não em regras de negócio novas.

## Prioridade
**P0** — transparência da tramitação é essencial desde o primeiro processo em produção; sem ela, não há como prestar contas do trâmite.
