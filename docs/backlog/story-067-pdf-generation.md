---
id: US-067
title: "Gerar PDF de documentos"
epic: EP-011
feature: FT-041
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-066, US-083]
modules: [document]
screens: [SCR-106]
endpoints: [DOC-20, DOC-21, DOC-22, DOC-23]
permissions: [PROCESS_VIEW]
events: [DocumentRenditionReady, DocumentRenditionFailed]
---

# US-067 — Gerar PDF de documentos

## Título
Gerar PDF de documentos

## Descrição
**Como** redator, aprovador ou qualquer pessoa com acesso ao processo, **quero** gerar e baixar o PDF de um documento — seja uma prévia do rascunho atual, seja o PDF oficial de uma versão —, **para** ler, imprimir, anexar a outros sistemas ou assinar fisicamente o documento fora da plataforma quando necessário.

A geração é assíncrona: o pedido cria um registro `DocumentRendition` (`PENDING`) e devolve imediatamente; um worker dedicado (fila `document-render`) monta o HTML a partir do snapshot (ou do rascunho, para prévia), envia ao Gotenberg, calcula hash/tamanho/páginas e grava o PDF no armazenamento de objetos. O rascunho sempre gera uma prévia com marca d'água "RASCUNHO" e validade de 24 horas; uma versão gera o PDF "oficial" (com o hash no rodapé), reaproveitado em downloads futuros da mesma versão.

## Contexto
- A DEC-060 e o ADR-007 definem o pipeline completo (worker → HTML → Gotenberg → hash → S3 → `DocumentRendition`); esta story implementa as pontas de API e a orquestração fim a fim descrita ali.
- A fila `document-render` (queues.md §4.4) já define payload, política de tentativas e SLO; esta story aplica esse contrato aos dois tipos de pedido (`DOC-20` prévia, `DOC-21` definitiva).
- O PDF é o formato que efetivamente "sai" do sistema para assinatura externa, protocolo e publicação — por isso leva o hash do conteúdo no rodapé (verificabilidade, DEC-060) e nunca é gerado a partir de dado sigiloso não mascarado (POL-09 também vale para o PDF).
- US-066 fornece o snapshot imutável (`DocumentVersion.content`) que alimenta a renderização de `CONTENT`/`APPROVAL_STAMPED`; prévias usam o rascunho atual (`Document.draftContent`), que muda a cada autosave — por isso carregam `draftRevision`, não `documentVersionId`.

## Objetivo
Permitir que qualquer PDF solicitado fique pronto em até 15 s (p95, prévia) ou 30 s (p95, versão oficial), com hash verificável e sem nunca expor conteúdo sigiloso não mascarado.

## Persona
- **Principal:** Redator do documento (solicita prévia enquanto escreve) e aprovador/custodiante (solicita o PDF oficial para anexar/assinar fora da plataforma).
- **Secundárias:** Qualquer usuário com `PROCESS_VIEW` que precise baixar o PDF já gerado.

## Pré-condições
- Documento visível (DEC-024); para `DOC-21`, existe ao menos uma `DocumentVersion`.
- Para tipos `STRUCTURED`/`FREE_TEXT`: o documento tem um `DocumentTemplateVersion` publicado associado (US-108) com `layout` válido.

## Fluxo principal
1. Na tela do documento (SCR-105) ou na aba de versões (SCR-106), o usuário aciona **"Gerar prévia em PDF"** (rascunho) ou, sobre uma versão específica, **"Gerar PDF desta versão"**.
2. O front chama, respectivamente, `POST /api/v1/documents/{id}/preview` (`DOC-20`) ou `POST /api/v1/document-versions/{versionId}/renditions` (`DOC-21`).
3. A API, em uma transação: verifica `PROCESS_VIEW` (+ POL-09 se o documento tiver campos sigilosos); cria `DocumentRendition` (`PENDING`, `kind = PREVIEW` ou `CONTENT`, `requestedById`, `requestedAt`, e `draftRevision` ou `documentVersionId` conforme o caso); confirma.
4. Após o commit, a API enfileira o job `document-render` (`jobId = renditionId`) e responde **202** com o recurso `PENDING` e seu `id`.
5. O front passa a consultar `GET /document-renditions/{renditionId}` (`DOC-22`) por *polling* (ou recebe `DocumentRenditionReady` pela central de notificações, fora deste épico) até `status = READY` ou `FAILED`.
6. O worker: trava o registro (`PROCESSING`), carrega o snapshot (`DOC-21`) ou o rascunho atual (`DOC-20`), resolve as variáveis do layout (`{{document.hash}}`, `{{process.code}}` etc.), gera o HTML com `packages/editor`, envia ao Gotenberg, recebe o PDF, calcula SHA-256/tamanho/páginas, grava no bucket `renditions` e atualiza `READY` + publica `DocumentRenditionReady`.
7. Com `status = READY`, o front habilita **"Baixar PDF"**, que chama `GET /document-renditions/{renditionId}/download` (`DOC-23`) e recebe `{ url, expiresAt }`; o navegador baixa diretamente do armazenamento de objetos.
8. Prévias (`PREVIEW`) trazem marca d'água "RASCUNHO" em cada página; PDFs de versão (`CONTENT`/`APPROVAL_STAMPED`) trazem o hash da versão no rodapé quando `LayoutDefinition.showDocumentHashInFooter = true` (padrão).

## Fluxos alternativos
- **FA-01 — Rendition `CONTENT` já existe para a versão:** `DOC-21` é idempotente por natureza (restrição única `(tenant_id, document_version_id) WHERE kind = 'CONTENT'`); se já houver uma `READY`, a API devolve o registro existente (200) em vez de gerar outra.
- **FA-02 — `APPROVAL_STAMPED`:** solicitado pelo módulo de aprovações (fora deste épico) ao decidir `APPROVED`, usando o mesmo `DOC-21` com `kind = APPROVAL_STAMPED` e `approvalId`; um PDF por par `(versão, aprovação)`.
- **FA-03 — Falha transitória do Gotenberg:** o worker tenta novamente (até 5 vezes, backoff exponencial com *jitter*); o front, enquanto `PENDING`/`PROCESSING`, mostra "Gerando PDF…"; se o *circuit breaker* do Gotenberg abrir, o job aguarda sem consumir tentativa e o usuário continua vendo "Gerando PDF…" (sem erro prematuro).
- **FA-04 — Prévia expirada:** ao tentar baixar uma `PREVIEW` com `expiresAt` no passado, a API responde `RENDITION_NOT_READY` e o botão já aparece desabilitado com "Prévia expirada — gere novamente".
- **FA-05 — Documento com valor sigiloso:** o HTML gerado pelo worker usa os mesmos dados já mascarados pela API (POL-09) — o PDF nunca contém o valor real quando o solicitante não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.

## Regras de negócio
- **RN-DOC-63** — Três tipos de PDF: `PREVIEW` (do rascunho, marca d'água "RASCUNHO", sem `documentVersionId`, identificado por `draftRevision`, expira em 24 h), `CONTENT` (de uma `DocumentVersion`, um por versão) e `APPROVAL_STAMPED` (de uma versão + aprovação, um por par). `SIGNED` fica reservado para o MVP 3.
- **RN-DOC-64** — Pedido assíncrono: `DOC-20`/`DOC-21` criam `DocumentRendition` `PENDING` na mesma transação do pedido e enfileiram o job **após o commit** (`jobId = renditionId`, padrão B de queues.md); a resposta é sempre **202**, nunca o PDF em si.
- **RN-DOC-65** — Geração (worker `document-render`): trava condicional para `PROCESSING` (só a partir de `PENDING`/`PROCESSING`); carrega o snapshot (`CONTENT`/`APPROVAL_STAMPED`) ou o rascunho atual (`PREVIEW`); resolve as variáveis do `LayoutDefinition` no servidor; gera HTML sanitizado (mesmas extensões do editor — DEC-056); chama o Gotenberg; grava o PDF com hash/tamanho/páginas calculados em trânsito.
- **RN-DOC-66** — Classificação de erro: falhas transitórias (Gotenberg 5xx, timeout, conexão) tentam novamente (até 5, backoff exponencial com *jitter*, base 5 s); *circuit breaker* aberto pausa a fila sem consumir tentativa; snapshot ausente, template/layout inválido ou 4xx do Gotenberg são falhas permanentes (sem nova tentativa).
- **RN-DOC-67** — Ao esgotar as tentativas ou falhar permanentemente: `FAILED` + `errorCode` + `errorMessage` sanitizada, evento `DocumentRenditionFailed`, notificação `DOCUMENT_RENDER_FAILED` a quem solicitou, e cópia na fila `dead-letter` para investigação técnica.
- **RN-DOC-68** — Validade: `PREVIEW.expiresAt = requestedAt + 24h`; a API nunca assina URL de download para rendition `EXPIRED` ou não `READY` (`RENDITION_NOT_READY`); o job agendado `maintenance` marca prévias vencidas como `EXPIRED`.
- **RN-DOC-69** — Download (`DOC-23`): exige `status = READY` e, se `PREVIEW`, dentro da validade; gera URL pré-assinada de no máximo 300 s com `Content-Disposition: attachment`; herda `PROCESS_VIEW`/POL-09 do documento (o PDF de quem não atende POL-09 já foi gerado mascarado); audita `document.download`.
- **RN-DOC-70** — SLO: `PREVIEW` p95 ≤ 15 s; `CONTENT`/`APPROVAL_STAMPED` p95 ≤ 30 s, do pedido ao `READY` (observability.md).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| *(sistema)* Tipo de PDF | `kind` | `RenditionKind` | — | RN-DOC-63 | `PREVIEW`/`CONTENT`/`APPROVAL_STAMPED` |
| *(sistema)* Status | `status` | `RenditionStatus` | — | RN-DOC-65 | `PENDING` |
| *(sistema)* Hash do PDF | `sha256` | varchar(64) | — | calculado em trânsito | gerado |
| *(sistema)* Validade | `expiresAt` | timestamptz | — (obrigatório em `PREVIEW`) | RN-DOC-68 | `+24h` |
| *(sistema)* Tentativas | `attempts` | int | — | RN-DOC-66 | `0` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Download de rendition não `READY` | API | "O PDF ainda está sendo gerado. Aguarde." | `RENDITION_NOT_READY` |
| V-02 | Download de `PREVIEW` expirada | API | "Esta prévia expirou. Gere novamente." | `RENDITION_NOT_READY` |
| V-03 | `DOC-21` sem `DocumentVersion` existente | API | "Não há versão para gerar este PDF." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-04 | Template/layout inválido ao renderizar | Worker | "Não foi possível gerar o PDF. A equipe foi notificada." | `FAILED` (`errorCode` interno) |
| V-05 | Sem `PROCESS_VIEW` sobre o documento | API | "Você não tem acesso a este documento." | `NOT_FOUND` (404, DEC-024) |

## Permissões
- **Permissão:** `PROCESS_VIEW` sobre o processo do documento, nas quatro rotas; mascaramento adicional por `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (POL-09) quando o documento contiver valores sigilosos.
- **Políticas:** POL-09 (o HTML enviado ao Gotenberg já usa os dados mascarados conforme o solicitante — RN-DOC-65).
- **MFA:** não exigido.
- **Sem permissão:** documento de outro tenant ou não visível → 404 em todas as rotas (DEC-024); visível mas sem `PROCESS_VIEW` → 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentRenditionReady` | `document.rendition_ready` | Worker conclui com sucesso | `documentId`, `documentVersionId?`, `renditionId`, `kind`, `sha256`, `pageCount` |
| `DocumentRenditionFailed` | `document.rendition_failed` | Worker esgota tentativas ou falha permanente | `documentId`, `renditionId`, `kind`, `errorCode`, `attempts` |

Auditoria (não eventos): `document.render_request` no pedido; `document.download` no download.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `DOCUMENT_RENDER_FAILED` | Quem solicitou a renderização (`requestedById`) | In-app | `DocumentRenditionFailed`, após esgotar tentativas (events.md §6) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerar PDF de documentos

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura A"
    And possui vínculo ativo e "PROCESS_VIEW" sobre o processo "0012/2026"
    And o documento "ETP 0003/2026" tem a versão 2 finalizada

  Scenario: [Sucesso] Gerar o PDF oficial de uma versão
    When o usuário solicitar o PDF da versão 2
    Then a API deve responder 202 com uma "DocumentRendition" "PENDING" do tipo "CONTENT"
    And o worker deve gerar o PDF, calcular o SHA-256 e marcar "READY"
    And deve gerar o evento "DocumentRenditionReady"
    And o rodapé do PDF deve exibir o hash da versão

  Scenario: [Validação] Baixar PDF antes de ficar pronto
    Given que a rendition ainda está "PROCESSING"
    When o usuário chamar "GET /document-renditions/{id}/download"
    Then a API deve responder 409 com código "RENDITION_NOT_READY"

  Scenario: [Permissão] Usuário sem acesso ao processo
    Given que "Bruno" não tem "PROCESS_VIEW" sobre o processo "0012/2026"
    When "Bruno" solicitar o PDF da versão 2
    Then a API deve responder 404

  Scenario: [Tenant incorreto] Rendition de outro tenant
    Given que a rendition "R9" pertence ao tenant "Prefeitura B"
    When um usuário da "Prefeitura A" chamar "GET /document-renditions/R9"
    Then a API deve responder 404
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Pedido repetido para a mesma versão
    Given que já existe uma rendition "CONTENT" "READY" para a versão 2
    When o usuário solicitar novamente o PDF da versão 2
    Then a API deve devolver a rendition existente
    And nenhum novo job deve ser enfileirado no Gotenberg

  Scenario: [Concorrência] Duas prévias solicitadas em sequência rápida
    Given que o rascunho está na revisão 5
    When o usuário clicar duas vezes em "Gerar prévia em PDF"
    Then devem existir duas "DocumentRendition" distintas, cada uma processada de forma independente
    And nenhuma delas deve corromper o estado da outra

  Scenario: [Falha de banco] Banco indisponível ao registrar o pedido
    Given que o banco de dados fica indisponível
    When o usuário solicitar um PDF
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma "DocumentRendition" deve ser criada

  Scenario: [Falha de integração] Gotenberg indisponível
    Given que o Gotenberg está fora do ar
    When o worker processar o job de renderização
    Then o job deve pausar sem consumir tentativa enquanto o circuito estiver aberto
    And, ao esgotar as tentativas após o Gotenberg voltar a falhar, a rendition deve ficar "FAILED"
    And deve gerar o evento "DocumentRenditionFailed" e a notificação "DOCUMENT_RENDER_FAILED"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Download antes de `READY` | 409 | `RENDITION_NOT_READY` | "O PDF ainda está sendo gerado. Aguarde." | Mantém "Gerando PDF…" |
| Prévia expirada | 409 | `RENDITION_NOT_READY` | "Esta prévia expirou. Gere novamente." | Botão "Gerar novamente" |
| Documento/versão não encontrados | 404 | `NOT_FOUND` | "Documento ou versão não encontrados." | Redireciona |
| Geração falhou (permanente) | — | `FAILED` (`errorCode` interno) | "Não foi possível gerar o PDF. A equipe foi notificada." | Botão "Tentar novamente"; notificação `DOCUMENT_RENDER_FAILED` |
| Limite de requisições (renderização) | 429 | `RATE_LIMITED` | "Muitas solicitações de PDF. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco/armazenamento indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível processar sua solicitação agora." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-066 (fornece o snapshot imutável/`contentHash` usado em `CONTENT`/`APPROVAL_STAMPED`); US-083 (worker, filas, *retries* e *dead letter* — infraestrutura de execução do job); consumida por aprovações (`APPROVAL_STAMPED`, fora deste épico) e US-111 (central de notificações, `DOCUMENT_RENDER_FAILED`).
- **Decisões/ADRs:** DEC-056, DEC-060, DEC-084, DEC-132, DEC-136 (padrão de URL assinada); ADR-006, ADR-007.
- **Configurações:** limites de renderização em api.md §1.6 (20 req/min).
- **Lacunas nas fontes canônicas:** nenhuma — o pipeline, os erros e o SLO já estão descritos em DEC-060/ADR-007/queues.md/storage.md §10.

## Impacto técnico
- Reaproveita integralmente o padrão B de filas (queues.md §3): a linha `DocumentRendition` é a "outbox do trabalho"; o job só é enfileirado depois do commit, e um reconciliador recupera renditions órfãs (presas acima do esperado em `PENDING`/`PROCESSING`).
- O `cockatiel` (timeout + retry + circuit breaker) para o Gotenberg precisa de meia-abertura de 30 s coerente com o restante do produto (ClamAV usa o mesmo padrão em US-068) — reutilizar o mesmo *wrapper* de breaker.
- Geração de `CONTENT` automaticamente na finalização/submissão (para o aprovador já encontrar o PDF) está marcada **(proposta)** em queues.md — decidida **fora de escopo** nesta story: `DOC-21` continua sendo sempre por pedido explícito no MVP 1.
- Throughput: concorrência de 2 jobs simultâneos por tenant na fila `document-render` (queues.md §4.4) é o teto; picos ficam em espera sem erro para o usuário.

## Backend
- **Módulo(s):** `document` (dono); usa `platform` (fila `document-render`, `OutboxWriter`), `access` (POL-09).
- **Casos de uso:** `RequestPreviewCommand` (`DOC-20`) e `RequestRenditionCommand` (`DOC-21`) → handlers que criam `DocumentRendition` e enfileiram; `GetRenditionQuery` (`DOC-22`); `GetRenditionDownloadUrlQuery` (`DOC-23`). Worker: `RenderDocumentHandler` (consome a fila).
- **Domínio:** `DocumentRendition.requestPreview(document)` / `.requestContent(version)` (fábricas); `RenditionStatus` como máquina de estados simples (`PENDING→PROCESSING→READY|FAILED`, mais `EXPIRED` via `maintenance`).
- **Integrações internas:** `packages/editor` (HTML a partir do TipTap JSON + `LayoutDefinition`); cliente Gotenberg (`modules/platform/pdf`); `modules/platform/storage` (bucket `renditions`).
- **Transação:** passo 3 do fluxo principal (criação da rendition) é a única transação síncrona; a renderização em si roda fora de transação de API, no worker.

## Frontend
- **Tela(s):** SCR-105 (botão "Gerar prévia em PDF") e SCR-106 (botão "Gerar PDF desta versão", lista de PDFs gerados).
- **Componentes:** `GeneratePdfButton` (com estado `PENDING`/`PROCESSING`/`READY`/`FAILED`), `PdfPreviewPanel` (pdf.js), `RenditionStatusBadge`.
- **Dados:** TanStack Query com *polling* (`refetchInterval` curto enquanto `PENDING`/`PROCESSING`, desligado ao chegar em `READY`/`FAILED`); invalidar ao receber `DocumentRenditionReady` pela central de notificações (US-111, fora deste épico).
- **Estados:** carregando (skeleton do visualizador); gerando (spinner + "Gerando PDF…"); falha (`FAILED`, com "Tentar novamente"); pronto (visualizador + "Baixar PDF").
- **Acessibilidade e responsividade:** status de geração anunciado via `aria-live="polite"`; em telas estreitas o visualizador de PDF cede lugar a "Baixar PDF" (sem *iframe*).

## Banco de dados
- **Tabelas:** `document_renditions` (escrita pelo worker e pela API ao criar o pedido).
- **Migrações:** nenhuma nova (entities.md §4 já define `document_renditions`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, document_version_id) WHERE kind = 'CONTENT'`; `UNIQUE (tenant_id, document_version_id, approval_id) WHERE kind = 'APPROVAL_STAMPED'`; índice `(status, requested_at) WHERE status IN ('PENDING','PROCESSING')` (usado pelo reconciliador).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DOC-20 | POST | `/api/v1/documents/{id}/preview` | — | `202 { data: DocumentRendition }` (`kind=PREVIEW`, `status=PENDING`) | 202, 403, 404, 429, 503 |
| DOC-21 | POST | `/api/v1/document-versions/{versionId}/renditions` | `{ kind: 'CONTENT'\|'APPROVAL_STAMPED', approvalId? }` | `202 { data: DocumentRendition }` (ou `200` se já existir — FA-01) | 200, 202, 403, 404, 422, 429, 503 |
| DOC-22 | GET | `/api/v1/document-renditions/{renditionId}` | — | `200 { data: DocumentRendition }` | 200, 403, 404 |
| DOC-23 | GET | `/api/v1/document-renditions/{renditionId}/download` | — | `200 { data: { url, expiresAt } }` | 200, 403, 404, 409 |

## Logs
- `info` `document.render_requested` — `renditionId`, `documentId`, `kind`, `correlationId`.
- `info` `document.render_completed` — `renditionId`, `durationMs`, `pageCount`, `sizeBytes`.
- `warn` `document.render_retry` — `renditionId`, `attempt`, `errorClass`.
- `error` `document.render_failed` — `renditionId`, `errorCode`, `attempts`, `correlationId` (sem stack em produção).
- **Nunca logar:** conteúdo HTML gerado, valores monetários, texto das seções.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.render_request` | `DATA_CHANGE` | Commit de `DOC-20`/`DOC-21` | `metadata`: `kind`, `documentVersionId?`, `draftRevision?` |
| `document.download` | `EXPORT` | Commit de `DOC-23` | `metadata`: `renditionId`, `kind` |

## Testes necessários
- **Unitários:** resolução de variáveis do `LayoutDefinition`; classificação de erro transitório × permanente (RN-DOC-66); cálculo de `expiresAt`.
- **Integração (Testcontainers + Gotenberg real ou *stub* contratual):** trava condicional de estado (`PENDING/PROCESSING→PROCESSING`); unicidade de `CONTENT` por versão; transição a `FAILED` após esgotar tentativas.
- **API/contrato:** respostas 202/200 conforme a tabela; `DOC-23` nega download fora de `READY`/validade.
- **RBAC e multi-tenant:** renditions de outro tenant → 404; usuário sem `PROCESS_VIEW` → 404.
- **Concorrência:** dois pedidos simultâneos de `CONTENT` para a mesma versão → apenas uma rendition efetivamente gerada (a outra reaproveita, FA-01).
- **E2E (Playwright):** gerar prévia → acompanhar status → baixar; gerar PDF de versão → ver hash no rodapé (verificação por extração de texto do PDF).
- **Acessibilidade/performance:** k6 simulando pico de pedidos de prévia → fila respeita concorrência 2/tenant sem erros ao usuário; p95 dentro do SLO (RN-DOC-70) em ambiente de carga.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas (POL-09) aplicadas na API; UI reflete os quatro estados de rendition
- [ ] Auditoria e eventos (`DocumentRenditionReady`/`Failed`) verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de DOC-20..23 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de duração/p95 e trace do pedido ao `READY`
- [ ] Acessibilidade (axe) e responsividade do visualizador verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Runbook de "rendition presa" documentado em observability.md

## Estimativa
**L** — orquestra um pipeline assíncrono completo (API → fila → worker → Gotenberg → storage → evento → notificação), com quatro rotas, duas classificações de erro e um SLO a cumprir sob concorrência limitada.

## Prioridade
**P0** — o PDF é o artefato que sai da plataforma para assinatura externa, protocolo e publicação; sem ele, o produto não substitui o fluxo em papel que a Lei 14.133/2021 busca digitalizar.
