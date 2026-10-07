---
id: US-062
title: "Painel de documentos do processo"
epic: EP-011
feature: FT-039
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-065]
modules: [document, workflow, access]
screens: [SCR-006]
endpoints: [DOC-01, DOC-03, DTY-01]
permissions: [PROCESS_VIEW, DOCUMENT_CREATE]
events: []
---

# US-062 — Painel de documentos do processo

## Título
Visualizar os documentos do processo organizados por tipo

## Descrição
**Como** usuário com acesso ao processo, **quero** ver todos os documentos do processo agrupados por tipo, com status e pendências claros, **para** entender rapidamente o que já foi produzido, o que está em aprovação e quais tipos ainda posso criar, sem precisar abrir cada documento individualmente.

A aba "Documentos" da tela de detalhe do processo (SCR-006) lista os documentos existentes agrupados por `DocumentType`, exibe o selo **"Em aprovação"** quando aplicável, mascara o resumo de documentos sigilosos e oferece um menu **"Criar documento"** restrito aos tipos permitidos na etapa atual do processo.

## Contexto
- Hoje os documentos do processo (memorandos, pareceres, anexos) ficam dispersos em e-mail e papel; não há visão consolidada do que já existe e do que falta.
- A Lei 14.133/2021 exige a formalização de diversos artefatos na fase preparatória (DFD, ETP, TR, mapa de riscos, pesquisa de preços), além de expediente comum (despachos, ofícios). O modelo documental híbrido (DEC-017) trata todos esses artefatos como `Document`, com `kind` `STRUCTURED`, `FREE_TEXT` ou `UPLOADED`.
- Relaciona-se com DEC-018 (ciclo de vida único de documento), DEC-030 (sigilo do orçamento estimado) e POL-02 (regras de edição/criação condicionadas à etapa do workflow). Depende de US-065 para o status técnico e para as ações permitidas (`allowedActions`) de cada documento.
- Esta é a tela de entrada para todas as demais stories deste épico: US-063 (documento livre), US-064 (documento externo) e os módulos tipados de outros épicos (DFD, ETP, TR, mapa de riscos, pesquisa de preços) são acessados a partir dela.

## Objetivo
Permitir que o usuário identifique, em poucos segundos, quais documentos existem, qual está em aprovação e quais tipos ainda podem ser criados na etapa atual — eliminando a necessidade de abrir cada documento só para saber seu status.

## Persona
- **Principal:** qualquer perfil com `PROCESS_VIEW` sobre o processo (Requisitante, Gestor de contratações, Planejamento, Compras, Gestor de contrato).
- **Secundárias:** perfis `SOMENTE_LEITURA` e participantes convidados (`OBSERVER`, `COLLABORATOR`, `CONSULTANT`).

## Pré-condições
- Usuário autenticado, com vínculo ativo e processo visível (DEC-024).
- Processo existente (em qualquer `ProcessStatus`); documentos podem ou não existir ainda.

## Fluxo principal
1. O usuário abre o processo (SCR-006) e seleciona a aba **"Documentos"**.
2. O sistema chama `DOC-01` (documentos do processo) e `DTY-01` (tipos ativos do tenant) em paralelo, e já possui a etapa atual do processo (com `WorkflowStage.documentTypeCodes`) carregada pela própria SCR-006.
3. O painel agrupa os documentos por `DocumentType` (ordenados por `sortOrder`): tipos `STRUCTURED` singulares (DFD, ETP, TR, mapa de riscos, pesquisa de preços) aparecem como um cartão único (documento existente ou "Não iniciado"); tipos `FREE_TEXT`/`UPLOADED` aparecem como lista dentro do próprio tipo.
4. Cada cartão mostra: código (ou "sem número"), título, status (rótulo pt-BR de `DocumentStatus`), selo **"Em aprovação"** quando `pendingApprovalId` estiver preenchido, responsável e data da última atualização.
5. O botão **"Criar documento"** abre um menu com os tipos ativos permitidos na etapa atual (`documentTypeCodes` vazio = todos) que o usuário tem permissão de criar e que ainda podem receber um novo documento (tipos singulares já existentes não aparecem).
6. Ao clicar em um documento existente, o usuário é levado ao visualizador/editor correspondente (SCR-105 para `FREE_TEXT`/`UPLOADED`; tela própria do módulo tipado para `STRUCTURED`, fora deste épico).
7. Ao escolher um tipo no menu "Criar documento", o usuário é levado ao fluxo de criação correspondente (US-063 para `FREE_TEXT`, US-064 para `UPLOADED`, ou à tela do módulo tipado para `STRUCTURED`, fora deste épico).

## Fluxos alternativos
- **FA-01 — Tipo singular sem documento ainda:** o cartão do tipo (ex.: "ETP") mostra "Não iniciado" com o botão de criação do módulo correspondente, visível apenas se o tipo estiver em `documentTypeCodes` da etapa atual e o usuário tiver a permissão de criação aplicável.
- **FA-02 — Tipo desativado:** some do menu "Criar documento" (US-061, RN-DOC-09/FA-01); documentos já criados desse tipo continuam visíveis e operáveis conforme seu ciclo de vida.
- **FA-03 — Documento com orçamento sigiloso:** quando `confidentiality = RESTRICTED`, o resumo do cartão mascara os campos monetários (POL-09) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; código, título e status continuam visíveis.
- **FA-04 — Processo sem nenhum documento:** painel exibe estado vazio "Nenhum documento ainda" com o menu "Criar documento" em destaque.
- **FA-05 — Tipo não permitido na etapa atual:** tipos ativos cujo `code` não conste em `documentTypeCodes` da etapa atual não aparecem no menu, mesmo que o usuário tenha permissão de criação.

## Regras de negócio
- **RN-DOC-13** — O painel agrupa os documentos do processo por `DocumentType` (ordenados por `sortOrder`, depois por título); tipos ainda sem documento aparecem como pendentes quando permitidos na etapa atual.
- **RN-DOC-14** — Tipo `STRUCTURED` com `allowMultiplePerProcess = false` (DFD, ETP, TR, mapa de riscos, pesquisa de preços): no máximo um documento não cancelado por processo (`singletonKey`); o cartão mostra o documento existente ou o estado "Não iniciado" com link para o fluxo de criação do módulo correspondente (fora deste épico).
- **RN-DOC-15** — O selo "Em aprovação" é exibido sempre que `pendingApprovalId` estiver preenchido, independentemente do `status` técnico do documento (DEC-018); o status técnico fica disponível ao abrir o documento.
- **RN-DOC-16** — O menu "Criar documento" lista somente tipos ativos permitidos na etapa atual (`WorkflowStage.documentTypeCodes` vazio = qualquer tipo ativo do tenant) para os quais o usuário tem a permissão de criação aplicável (`DOCUMENT_CREATE` para `FREE_TEXT`/`UPLOADED`; permissão específica do módulo tipado para `STRUCTURED`, definida em outro épico); tipos singulares já existentes e não cancelados não aparecem.
- **RN-DOC-17** — Em documentos com `confidentiality = RESTRICTED`, os campos monetários do resumo (ex.: valor total) seguem POL-09 (mascarados para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`); código, título, tipo e status permanecem visíveis a quem tem `PROCESS_VIEW`.
- **RN-DOC-18** — Cada documento do painel expõe `meta.allowedActions`, calculado pelo `DocumentLifecycleService` (US-065) a partir do status, da custódia/participação e de POL-02/POL-11; a UI habilita ou oculta ações conforme essa lista, nunca por conta própria.
- **RN-DOC-19** — Documentos cancelados permanecem visíveis no painel (com indicação "Cancelado"), preservando o histórico; não contam como pendência da etapa atual.
- **RN-DOC-20** — Filtros do painel (tipo, status, responsável, busca) operam sobre a lista já carregada (um processo tem, no máximo, dezenas de documentos); não há paginação própria nesta story.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Tipo | `type` (query) | multi-seleção de `documentTypeId` | Não | tipos ativos do tenant | todos |
| Status | `status` (query) | multi-seleção (`DocumentStatus`) | Não | enum | todos |
| Responsável | `responsibleId` (query) | seleção | Não | usuário com acesso ao processo | — |
| Busca | `q` (query) | texto curto | Não | mínimo 2 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `status`/`type` fora do enum/catálogo do tenant | Front + API | "Filtro inválido." | `VALIDATION_ERROR` (`INVALID_ENUM`/`REFERENCE_NOT_FOUND`) |
| V-02 | Busca com 1 caractere | Front | — (ignorada, sem chamada à API) | — |
| V-03 | Processo inexistente, de outro tenant ou não visível | API | "Processo não encontrado." | `PROCESS_NOT_FOUND` |

## Permissões
- **Permissão:** `PROCESS_VIEW` sobre o processo habilita a aba e `DOC-01`/`DOC-03`; cada item do menu "Criar documento" exige `DOCUMENT_CREATE` (tipos `FREE_TEXT`/`UPLOADED`) ou a permissão específica do módulo tipado (tipos `STRUCTURED`, fora deste épico).
- **Políticas:** POL-09 (mascara valores de resumo em documentos `RESTRICTED`). Nenhuma outra política contextual de leitura.
- **MFA:** não exigido (leitura; `PROCESS_VIEW` é risco baixo/médio).
- **Sem permissão:** processo não visível → aba inacessível e API responde 404 (DEC-024, nunca 403 para recurso invisível); visível sem permissão de criação de um tipo específico → item correspondente oculto do menu; chamada direta de criação → 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum. Story somente leitura; a criação de documentos gera `DocumentCreated` nas stories US-063/US-064 e nos módulos tipados (fora deste épico). |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (painel somente leitura). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Painel de documentos do processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" está na etapa "Estudos preliminares" (tipo "TASK")
    And a etapa atual permite os tipos de documento "ETP", "DESPACHO" e "OFICIO" (`documentTypeCodes`)
    And "Ana" tem vínculo ativo e `PROCESS_VIEW` sobre o processo "0012/2026"

  Scenario: [Sucesso] Ver documentos agrupados por tipo com selo "Em aprovação"
    Given que o processo tem um "ETP" com `pendingApprovalId` preenchido e um "DESPACHO" em "DRAFT"
    When "Ana" abrir a aba "Documentos"
    Then deve ver o cartão "ETP" com o selo "Em aprovação"
    And deve ver o cartão "DESPACHO" com o status "Rascunho"
    And o menu "Criar documento" deve oferecer "Ofício" e não deve oferecer "ETP"

  Scenario: [Validação] Filtro de status inválido
    When "Ana" chamar a listagem com "status=NAO_EXISTE"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_ENUM" no campo "status"

  Scenario: [Permissão] Usuário sem acesso ao processo
    Given que "Bruno" não tem `PROCESS_VIEW` nem `ProcessAccess` sobre o processo "0012/2026"
    When "Bruno" chamar "GET /api/v1/processes/{id}/documents"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And a tela deve exibir "Processo não encontrado"

  Scenario: [Tenant incorreto] Processo de outro tenant
    Given que o processo "0003/2026" pertence ao tenant "Prefeitura B"
    When "Ana", autenticada no tenant "Prefeitura de São José", chamar "GET /api/v1/processes/0003-2026/documents"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Tipo singular já existente não duplica a opção de criação
    Given que o processo já tem um "ETP" com status "APPROVED"
    When "Ana" abrir o menu "Criar documento"
    Then a opção "ETP" não deve aparecer
    When alguém chamar diretamente "POST /api/v1/processes/{id}/documents" com o tipo "ETP"
    Then a API deve responder 409 com código "DOCUMENT_ALREADY_EXISTS"

  Scenario: [Concorrência] Documento aprovado por outro usuário enquanto o painel está aberto
    Given que "Ana" está com o painel de documentos aberto
    When a aprovação do "ETP" for decidida como "APPROVED" por "Carla" em outra sessão
    And "Ana" revalidar a lista (foco da janela ou nova consulta)
    Then o cartão do "ETP" deve mostrar o status "Aprovado" sem exigir recarregar a página inteira

  Scenario: [Falha de banco] Banco indisponível ao carregar o painel
    Given que o banco de dados está indisponível
    When "Ana" abrir a aba "Documentos"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a tela deve exibir "Não foi possível carregar os documentos agora." com o botão "Tentar novamente"

  Scenario: [Falha de integração] Cache de tipos de documento indisponível
    Given que o Redis usado pelo cache de "DTY-01" está indisponível
    When "Ana" abrir a aba "Documentos"
    Then a lista de tipos deve ser obtida diretamente do banco, sem cache
    And o painel deve carregar normalmente, com log "warn" "document_type.cache_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Processo não visível/inexistente/outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Redireciona à lista de processos |
| Filtro inválido | 422 | `VALIDATION_ERROR` | "Filtro inválido." | Ignora o filtro e exibe aviso |
| Sem permissão para criar o tipo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para criar este tipo de documento." | Item do menu oculto; bloqueia chamada direta |
| Tipo singular já existente | 409 | `DOCUMENT_ALREADY_EXISTS` | "Este processo já tem um documento deste tipo." | Opção removida do menu |
| Tipo não permitido na etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "Este tipo de documento não é permitido na etapa atual." | Item do menu oculto |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar os documentos agora." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão para copiar o código |

## Dependências
- **Stories:** US-065 (status técnico e `allowedActions` de cada documento); US-061 (catálogo de tipos ativos via `DTY-01`). Relacionadas, não bloqueantes: US-063 (destino do menu para `FREE_TEXT`), US-064 (destino do menu para `UPLOADED`), módulos tipados DFD/ETP/TR/mapa de riscos/pesquisa de preços (fora deste épico, destino do menu para `STRUCTURED`).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-024, DEC-030; ADR-006.
- **Configurações:** nenhuma específica desta story.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Story somente leitura; atenção para não introduzir N+1 ao montar o painel (uma consulta de documentos com join do tipo, mais a lista de tipos ativos já cacheada por `DTY-01`).
- Os "tipos pendentes" (sem documento ainda) são calculados no servidor combinando `DTY-01` + `documentTypeCodes` da etapa atual + documentos existentes do processo; não é criado nenhum endpoint novo para isso.
- `meta.allowedActions` depende do mesmo cálculo usado pelas telas de documento (US-065); deve ser extraído como função pura reutilizável para não divergir entre o painel e o visualizador.

## Backend
- **Módulo(s):** `document` (dono); consome fachadas de `workflow` (etapa atual e `documentTypeCodes`) e `access` (`PROCESS_VIEW`, POL-09).
- **Casos de uso:** `GetProcessDocumentsQuery` → `GetProcessDocumentsHandler` (`DOC-01`); `GetDocumentQuery` → `GetDocumentHandler` (`DOC-03`).
- **Domínio:** nenhuma regra de escrita; `ProcessDocumentsPresenter` calcula `meta.allowedActions` (via `DocumentLifecycleService.allowedActions`, US-065) e aplica o mascaramento de POL-09.
- **Integrações internas:** `workflow.getCurrentStage(processId)` (para `documentTypeCodes`); `access.assertCan('PROCESS_VIEW', { processId })`.
- **Transação:** nenhuma (somente leitura).

## Frontend
- **Tela(s):** SCR-006, aba "Documentos" (`/processos/[id]`).
- **Componentes:** `DocumentsPanel`, `DocumentTypeCard`, `StatusBadge`, `PendingApprovalBadge`, `ConfidentialityLock`, `CreateDocumentMenu`, `EmptyState`.
- **Estados:** skeleton nos cartões enquanto carrega; vazio ("Nenhum documento ainda. Comece criando um documento."); erro com "Tentar novamente"; sucesso.
- **Acessibilidade:** badges com texto, não só cor; menu "Criar documento" navegável por teclado; foco visível.
- **Responsivo:** em telas < 768 px os cartões ficam em coluna única; o menu "Criar documento" vira folha inferior (bottom sheet).

## Banco de dados
- **Tabelas:** leitura de `documents`, `document_types`; nenhuma escrita.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita `(tenant_id, process_id, document_type_id)` de `documents` (já existente).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-01 | GET | `/api/v1/processes/{id}/documents` | Query: `type?`, `status?`, `responsibleId?`, `q?` | `200 { data: Document[] }` com `documentType`, `pendingApprovalId`, `confidentiality`, `meta.allowedActions` por item | 200, 403, 404, 503 |
| DOC-03 | GET | `/api/v1/documents/{id}` | — | `200 { data: Document }` (+POL-09) | 200, 403, 404, 503 |
| DTY-01 | GET | `/api/v1/document-types` | Query: `includeInactive?` | `200 { data: DocumentType[] }` (cache 10 min) | 200, 403, 503 |

## Logs
- `info` `document_panel.loaded` — `processId`, `documentCount`, `durationMs`.
- `warn` `document_type.cache_unavailable` — quando o Redis falhar na leitura de `DTY-01`.
- `error` `document_panel.load_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** título ou conteúdo de documentos com `confidentiality` diferente de `PUBLIC`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | Tentativa sem `PROCESS_VIEW` ou sem permissão de criação de um tipo | `reasonCode = PROCESS_VIEW` ou `DOCUMENT_CREATE`, `documentTypeCode?` |

## Testes necessários
- **Unitários:** cálculo de tipos pendentes (tipos ativos ∩ `documentTypeCodes` ∖ tipos singulares já existentes); mascaramento POL-09 no resumo.
- **Integração (Testcontainers PostgreSQL + Redis):** RLS impede listar documentos de outro tenant; visibilidade conforme DEC-024; cache de `DTY-01` com e sem Redis.
- **API/contrato:** respostas e erros conforme api.md; `meta.allowedActions` consistente com US-065.
- **RBAC e multi-tenant:** matriz de perfis × permissões para itens do menu "Criar documento"; processo de outro tenant → 404.
- **Concorrência:** atualização do painel após mudança de status feita por outro usuário (revalidação de consulta).
- **E2E (Playwright):** abrir a aba, ver selo "Em aprovação", criar documento pelo menu, abrir documento existente.
- **Acessibilidade/performance:** axe sem violações sérias; painel carrega em p95 < 500 ms com até 50 documentos.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PROCESS_VIEW` e permissões de criação por tipo aplicadas na API; UI oculta o que não é permitido
- [ ] `meta.allowedActions` validado contra a tabela de transições de US-065
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de `DOC-01`, `DOC-03` e `DTY-01` compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de carregamento do painel
- [ ] Acessibilidade (axe) e responsividade (360 px) verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — leitura composta de múltiplas fontes (tipos, etapa atual, documentos) com regras de mascaramento e cálculo de ações permitidas, sem nenhuma escrita.

## Prioridade
**P0** — é a porta de entrada para todas as demais ações de documento do processo; sem o painel, nenhuma outra story deste épico tem onde ser acionada a partir do processo.
