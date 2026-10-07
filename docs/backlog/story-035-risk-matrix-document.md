---
id: US-035
title: "Visualizar matriz de riscos e emitir o Mapa de Riscos"
epic: EP-005
feature: FT-023
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-034, US-065, US-110]
modules: [risk, document, process, workflow, access, audit, platform]
screens: [SCR-011]
endpoints: [RSK-09, RSK-10, DOC-05, DOC-08, DOC-09, DOC-10, DOC-12]
permissions: [RISK_MANAGE, RISK_MAP_SUBMIT]
events: [DocumentCreated, DocumentVersionCreated, DocumentSubmitted, DocumentFinalized, DocumentReopened]
---

# US-035 — Visualizar matriz de riscos e emitir o Mapa de Riscos

## Título
Visualizar matriz de riscos e emitir o Mapa de Riscos

## Descrição
**Como** gestor de contratações, **quero** visualizar os riscos do processo em uma matriz de calor (probabilidade × impacto) e emitir o documento formal **Mapa de Riscos**, **para** dar visibilidade consolidada à exposição a risco do processo e formalizar o artefato exigido pela fase preparatória da contratação.

A matriz (`RSK-09`) é uma visão somente leitura, sempre atualizada, dos riscos registrados em US-033/US-034. O Mapa de Riscos é um documento (`Document`, módulo `RISK_MAP`, DEC-017) cujo conteúdo típado é a lista de riscos e tratamentos vigentes; ele segue o ciclo de vida único de documentos (DEC-018): criado em `DRAFT` (`RSK-10`), validado por completude, finalizado ou submetido à aprovação (reaproveitando US-065) e, a partir daí, os riscos do processo ficam bloqueados para edição até a reabertura do documento.

## Contexto
- A Lei 14.133/2021 (art. 18, §1º, X) trata a gestão de riscos como parte da fase preparatória; o Mapa de Riscos é o artefato que formaliza essa análise para instrução do processo.
- DEC-017/DEC-018 definem o modelo documental híbrido e o ciclo de vida único de documentos; DEC-021 define que o documento `RISK_MAP` é o artefato formal cujo snapshot inclui os riscos (que continuam sendo editados via US-033/US-034 enquanto o documento não estiver finalizado).
- O template padrão do tipo `RISK_MAP` é semeado pela biblioteca de templates (US-110); esta story não cria o template, apenas consome a versão publicada vigente.
- Após o Mapa de Riscos deixar `DRAFT`/`RETURNED`, os riscos ficam bloqueados (RN-RISK-09/RN-RISK-16, US-033/US-034) até reabertura — esta story fecha esse ciclo reutilizando as ações genéricas de documento de US-065 (submeter, finalizar, reabrir).

## Objetivo
Permitir que um usuário autorizado visualize a distribuição de riscos na matriz em tempo real e emita o Mapa de Riscos em até 2 minutos, com 100% dos documentos finalizados possuindo snapshot imutável dos riscos e tratamentos vigentes no momento da emissão.

## Persona
- **Principal:** Gestor de contratações (perfil `GESTOR_CONTRATACOES`).
- **Secundárias:** Planejamento (`PLANEJAMENTO`), Autoridade/aprovador quando a etapa do workflow exigir aprovação do tipo `RISK_MAP`.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Processo visível ao usuário (DEC-024); existe ao menos um risco registrado (US-033) para emitir o documento.
- Para finalizar/submeter: usuário possui `RISK_MAP_SUBMIT`; para visualizar matriz/documento: `PROCESS_VIEW` basta.
- Template padrão do tipo `RISK_MAP` publicado (US-110).

## Fluxo principal
1. O usuário acessa a aba **Matriz** da tela **Riscos** (SCR-011). O sistema chama `RSK-09` e renderiza a grade probabilidade × impacto (dimensão de `risk.scale.max`), com a quantidade de riscos e a lista (código, título, nível) em cada célula, coloridas pelo `level`.
2. O usuário filtra por fase, categoria ou status (client-side ou via querystring de `RSK-09`); a matriz atualiza sem recarregar a tela.
3. Quando pronto para formalizar, o usuário clica **"Emitir Mapa de Riscos"**. Se não existir um `RISK_MAP` ativo para o processo, o front envia `POST /api/v1/processes/{id}/risk-map` (`RSK-10`, `Idempotency-Key`); a API cria o `Document` em `DRAFT` (RN-RISK-19) e responde **201**.
4. A UI navega para o documento (reaproveitando a tela genérica de documento de US-065/US-062), mostrando a lista de riscos e tratamentos vigentes (somente leitura, refletindo US-033/US-034) e, se o template definir, seções narrativas editáveis (`DOC-05`).
5. O usuário confere a validação de completude (`DOC-08`): riscos pendentes de tratamento (nível Alto/Extremo sem ação) aparecem como pendências bloqueantes (RN-RISK-21).
6. Resolvidas as pendências, o usuário clica **"Finalizar"** (tipo semeado `requiresApproval = false`): o front envia `POST /documents/{id}/finalize` (`DOC-10`, `If-Match`, `Idempotency-Key`). A API valida completude, cria a `DocumentVersion` com o snapshot dos riscos/tratamentos (RN-RISK-20), muda o documento para `FINALIZED` e emite `DocumentFinalized` + `DocumentVersionCreated`.
7. Se a etapa atual do workflow do processo exigir aprovação do tipo `RISK_MAP` (`WorkflowStage.documentTypeCodes`), a submissão ocorre via `POST /documents/{id}/submit` (`DOC-09`) ao encaminhar o processo para aquela etapa, exigindo `RISK_MAP_SUBMIT`.
8. A partir da finalização/submissão, US-033/US-034 ficam bloqueadas (RN-RISK-23); a tela de riscos exibe "Mapa de Riscos concluído" com link para o documento.
9. Para alterar riscos novamente, um usuário com `DOCUMENT_REOPEN` reabre o documento (`DOC-12`, `POST /documents/{id}/reopen`), voltando-o a `DRAFT` e liberando a edição dos riscos.

## Fluxos alternativos
- **FA-01 — Mapa de Riscos já existe:** ao tentar criar um segundo `RISK_MAP` ativo para o mesmo processo, a API responde `DOCUMENT_ALREADY_EXISTS` (409) e a UI oferece **"Abrir o Mapa de Riscos existente"** em vez de criar outro.
- **FA-02 — Nenhum risco registrado:** a matriz exibe estado vazio ("Nenhum risco registrado. Volte para a lista de riscos e registre o primeiro.") e o botão "Emitir Mapa de Riscos" fica desabilitado.
- **FA-03 — Pendência de tratamento bloqueante:** `DOC-08`/`DOC-10` retornam `violations[]` com `code = "RISK_TREATMENT_REQUIRED_FOR_LEVEL"` por risco pendente; a UI lista os riscos com link direto para criar o tratamento (US-034).
- **FA-04 — Aprovação da etapa devolve o documento:** se a aprovação da etapa que cobre `RISK_MAP` retornar `RETURNED`/`REJECTED` (DEC-018), os riscos voltam a ficar editáveis (`RETURNED`) ou permanecem bloqueados até reabertura (`REJECTED`).
- **FA-05 — Matriz consultada com documento já finalizado:** a matriz continua disponível em modo leitura (RN-RISK-24), lendo os riscos atuais — não a versão congelada do documento.

## Regras de negócio
- **RN-RISK-18** — A matriz (`RSK-09`) agrega os riscos não excluídos do processo em uma grade probabilidade × impacto, usando a escala e as faixas **vigentes** do tenant (não o `scaleSnapshot` individual de cada risco); cada célula expõe a quantidade e a lista de riscos (`code`, `title`, `level`); aceita filtros por `phase`, `categoryId` e `status`.
- **RN-RISK-19** — O `RISK_MAP` é documento `STRUCTURED` singleton por processo (DEC-017, `singletonKey = documentTypeId`). `RSK-10` cria o documento em `DRAFT` quando não existir um `RISK_MAP` ativo (não `CANCELED`) para o processo; caso contrário, `DOCUMENT_ALREADY_EXISTS` (409).
- **RN-RISK-20** — O conteúdo típado do `RISK_MAP` é a lista de `Risk`/`RiskTreatment` vigentes do processo; a `DocumentVersion` grava um snapshot imutável dessa lista com `contentHash` SHA-256 (RFC 8785) no momento da submissão ou finalização (`DOC-09`/`DOC-10`) — não na criação (`RSK-10`).
- **RN-RISK-21** — Validação de completude (`DOC-08`): `BLOCKING` se o processo não tiver nenhum risco registrado (`RISK_LIST_EMPTY`); `BLOCKING` para cada risco em nível `HIGH` ou `EXTREME` sem nenhum `RiskTreatment` com `status ≠ CANCELED` (`RISK_TREATMENT_REQUIRED_FOR_LEVEL`, `itemId = riskId`).
- **RN-RISK-22** — Conclusão segue DEC-018: tipo semeado `RISK_MAP` tem `requiresApproval = false` por padrão → ação "finalizar" (`DOC-10`) muda `DRAFT`/`RETURNED` para `FINALIZED`. Se a etapa atual do workflow cobrir o tipo `RISK_MAP`, a submissão ocorre via `DOC-09` com a permissão `RISK_MAP_SUBMIT`.
- **RN-RISK-23** — A partir de `FINALIZED`/`IN_REVIEW`/`APPROVED`, os riscos e tratamentos do processo ficam bloqueados para edição (RN-RISK-09, US-033; RN-RISK-16, US-034) até a reabertura do `RISK_MAP` (`DOC-12`), que volta o documento a `DRAFT` com novo rascunho a partir da última versão.
- **RN-RISK-24** — A matriz (`RSK-09`) permanece disponível em modo leitura independentemente do status do `RISK_MAP`, pois lê os riscos atuais do processo, não a versão congelada do documento.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Filtro — Fase | `phase` (querystring) | seleção (`RiskPhase`) | Não | não persistido | — |
| Filtro — Categoria | `categoryId` (querystring) | seleção (catálogo `RISK_CATEGORY`) | Não | não persistido | — |
| Filtro — Status | `status` (querystring) | seleção (`RiskStatus`) | Não | não persistido | — |
| Título do documento | `title` | texto curto | Sim (gerado) | RN-RISK-19 | "Mapa de Riscos" |
| *(sistema)* Status do documento | `status` | enum (`DocumentStatus`) | — | DEC-018 | `DRAFT` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Já existe `RISK_MAP` ativo para o processo | API | "Já existe um Mapa de Riscos para este processo." | `DOCUMENT_ALREADY_EXISTS` |
| V-02 | Nenhum risco registrado ao finalizar/submeter | API | "Registre ao menos um risco antes de emitir o Mapa de Riscos." | `BUSINESS_RULE_VIOLATION` (`RISK_LIST_EMPTY`) |
| V-03 | Risco Alto/Extremo sem tratamento ativo | API | "O risco {code} precisa de ao menos uma ação de tratamento." | `BUSINESS_RULE_VIOLATION` (`RISK_TREATMENT_REQUIRED_FOR_LEVEL`) |
| V-04 | Documento fora de `DRAFT`/`RETURNED` ao finalizar/submeter | API | "Este Mapa de Riscos não pode mais ser editado." | `DOCUMENT_NOT_EDITABLE` |
| V-05 | Tipo `RISK_MAP` não permitido na etapa atual | API | "O Mapa de Riscos não é aceito nesta etapa do processo." | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` |
| V-06 | Sem `RISK_MAP_SUBMIT` para finalizar/submeter | API | "Você não tem permissão para concluir o Mapa de Riscos." | `PERMISSION_DENIED` |

## Permissões
- **Permissão:** `PROCESS_VIEW` para visualizar matriz e documento; `RISK_MANAGE` + POL-02 para criar o documento (`RSK-10`, mesma condição de RN-RISK-09); `RISK_MAP_SUBMIT` + POL-02 para finalizar/submeter (`DOC-09`/`DOC-10`); `DOCUMENT_REOPEN` + POL-11 para reabrir (`DOC-12`).
- **Políticas:** POL-02 (documento em `DRAFT`/`RETURNED` para edição); RN-RISK-22 (regra de finalizar vs. submeter conforme DEC-018).
- **MFA:** não exigido (riscos `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** "Emitir Mapa de Riscos" e "Finalizar" não são exibidos sem a permissão correspondente; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentCreated` | `document.created.risk_map` | Commit de `RSK-10` | `documentId`, `documentTypeCode = RISK_MAP`, `kind = STRUCTURED` |
| `DocumentVersionCreated` | `document.version_created.risk_map` | Commit de `DOC-09`/`DOC-10` | `documentId`, `documentVersionId`, `versionNumber`, `reason`, `contentHash` |
| `DocumentSubmitted` | `document.submitted.risk_map` | Commit de `DOC-09` (quando a etapa exige aprovação) | `documentId`, `documentVersionId`, `approvalId?` |
| `DocumentFinalized` | `document.finalized.risk_map` | Commit de `DOC-10` | `documentId`, `documentVersionId` |
| `DocumentReopened` | `document.reopened.risk_map` | Commit de `DOC-12` | `documentId`, `fromStatus`, `baseVersionId` |

Projeção síncrona: entrada na timeline do processo para cada evento acima (herdada do fluxo genérico de documento, US-065).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação específica desta story; notificações de aprovação pendente (quando a etapa exigir aprovação do tipo `RISK_MAP`) são tratadas pelo fluxo genérico de aprovações. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Visualizar matriz de riscos e emitir o Mapa de Riscos

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o processo "0012/2026" em status "IN_PROGRESS"
    And o usuário "Ana" possui "RISK_MANAGE" e "RISK_MAP_SUBMIT" com escopo que cobre o processo

  Scenario: [Sucesso] Visualizar a matriz com riscos distribuídos
    Given que o processo tem os riscos "R01" (probabilidade 4, impacto 4) e "R02" (probabilidade 1, impacto 1)
    When "Ana" abrir a aba "Matriz"
    Then a célula de probabilidade 4 e impacto 4 deve listar o risco "R01" com nível "HIGH"
    And a célula de probabilidade 1 e impacto 1 deve listar o risco "R02" com nível "LOW"

  Scenario: [Sucesso] Emitir o Mapa de Riscos com os riscos completos
    Given que todos os riscos de nível "HIGH" ou "EXTREME" do processo têm ao menos um tratamento ativo
    When "Ana" criar e finalizar o Mapa de Riscos
    Then o documento deve ficar com status "FINALIZED"
    And deve existir uma "DocumentVersion" com o snapshot dos riscos e tratamentos vigentes
    And deve gerar o evento DocumentFinalized
    And deve gerar registro de auditoria "document.finalize"

  Scenario: [Validação] Finalizar sem nenhum risco registrado
    Given que o processo não possui riscos
    When "Ana" tentar finalizar o Mapa de Riscos
    Then a API deve responder 422 com código "BUSINESS_RULE_VIOLATION" e violação "RISK_LIST_EMPTY"
    And o documento deve permanecer "DRAFT"

  Scenario: [Validação] Risco de nível Alto sem tratamento
    Given que o risco "R03" tem nível "HIGH" e nenhum tratamento ativo
    When "Ana" tentar finalizar o Mapa de Riscos
    Then a API deve responder 422 com código "BUSINESS_RULE_VIOLATION" e violação "RISK_TREATMENT_REQUIRED_FOR_LEVEL" referenciando "R03"

  Scenario: [Permissão] Usuário sem RISK_MAP_SUBMIT
    Given que o usuário "Bruno" possui "RISK_MANAGE" mas não "RISK_MAP_SUBMIT"
    When "Bruno" tentar finalizar o Mapa de Riscos
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Acesso à matriz de processo de outro tenant
    Given que o processo "0099/2026" pertence ao tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", requisitar a matriz desse processo
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Criar o Mapa de Riscos quando já existe um ativo
    Given que já existe um "RISK_MAP" em "DRAFT" para o processo
    When "Ana" tentar criar outro Mapa de Riscos para o mesmo processo
    Then a API deve responder 409 com código "DOCUMENT_ALREADY_EXISTS"
    And a UI deve oferecer abrir o Mapa de Riscos existente

  Scenario: [Concorrência] Finalização concorrente do mesmo documento
    Given que "Ana" e "Carla" abriram o Mapa de Riscos com "ETag" igual a "2"
    When "Ana" finalizar com sucesso e "Carla" tentar finalizar com "If-Match" igual a "2"
    Then a resposta a "Carla" deve ser 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível ao finalizar
    Given que o banco de dados fica indisponível durante a finalização
    When "Ana" tentar finalizar o Mapa de Riscos
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o documento deve permanecer "DRAFT"

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Ana" finalizar o Mapa de Riscos com sucesso
    Then o documento deve ficar "FINALIZED" e a API deve responder 200
    And o evento DocumentFinalized deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Mapa de Riscos já existe | 409 | `DOCUMENT_ALREADY_EXISTS` | "Já existe um Mapa de Riscos para este processo." | Oferece abrir o documento existente |
| Nenhum risco registrado | 422 | `BUSINESS_RULE_VIOLATION` (`RISK_LIST_EMPTY`) | "Registre ao menos um risco antes de emitir o Mapa de Riscos." | Link para a lista de riscos |
| Risco de nível alto sem tratamento | 422 | `BUSINESS_RULE_VIOLATION` (`RISK_TREATMENT_REQUIRED_FOR_LEVEL`) | "O risco {code} precisa de ao menos uma ação de tratamento." | Lista pendências com link para US-034 |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este Mapa de Riscos não pode mais ser editado." | Desabilita ações; mostra link para reabrir |
| Tipo não permitido na etapa | 422 | `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` | "O Mapa de Riscos não é aceito nesta etapa do processo." | Oculta ação de submissão |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para concluir o Mapa de Riscos." | Oculta botão "Finalizar" |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Este documento foi alterado por outra pessoa. Recarregue para ver a versão atual." | Recarrega o documento |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados; botão copiar código |

## Dependências
- **Stories:** US-034 (tratamentos sustentam a completude de riscos Alto/Extremo), US-065 (ciclo de vida genérico do documento — submeter/finalizar/reabrir), US-110 (template padrão do tipo `RISK_MAP`). Indiretas: US-033, US-097, US-073, US-082.
- **Decisões/ADRs:** DEC-010, DEC-017, DEC-018, DEC-021, DEC-024; ADR-006.
- **Configurações:** `risk.scale`, `risk.levelThresholds`.
- **Lacunas nas fontes canônicas:** (1) o pacote não especifica o sufixo de routing key dos eventos de documento para o módulo `RISK_MAP` (mostra `dfd`, `etp`, `tr`, `price_research`, mas não `risk_map`); assumi `risk_map` por analogia direta ao valor do enum `SystemDocumentModule.RISK_MAP` em snake_case — proponho confirmar em events.md. (2) As chaves das seções narrativas do template padrão do tipo `RISK_MAP` (US-110) não constam neste pacote; assumi 0..N seções opcionais editáveis via `DOC-05`, sem fixar nomes de `sectionKey`.

## Impacto técnico
- A montagem do snapshot de riscos/tratamentos para a `DocumentVersion` (RN-RISK-20) deve reutilizar o mesmo serializador usado pela matriz, para evitar divergência entre o que é exibido e o que é congelado na versão.
- A consulta da matriz (`RSK-09`) é O(riscos do processo); com o índice `(tenant_id, process_id, level)` já previsto em entities.md, o agrupamento por célula pode ser feito em memória na API sem custo adicional de índice.
- Reaproveita integralmente o `DocumentLifecycleService`/`ValidationFacade` de US-065, estendido apenas com as regras de completude RN-RISK-21 — não deve haver lógica de transição de status duplicada para o tipo `RISK_MAP`.

## Backend
- **Módulo(s):** `risk` (matriz e regras de completude) + `document` (dono do ciclo de vida, reaproveitado de US-065); usa `access`, `audit`, `platform` (`OutboxWriter`, `IdempotencyService`), `workflow` (verificação de `documentTypeCodes` da etapa atual).
- **Casos de uso:** `GetRiskMatrixQuery` → `GetRiskMatrixHandler`; `CreateRiskMapDocumentCommand` (restrição de singleton, RN-RISK-19) sobre o `CreateDocumentHandler` genérico; completude via `RiskMapCompletenessRule` plugada no `ValidationFacade` (DOC-08) consumida por `DOC-09`/`DOC-10` de US-065.
- **Domínio:** `RiskMatrix` (value object de agregação, RN-RISK-18); `RiskMapSnapshotBuilder` (RN-RISK-20).
- **Transação:** criação do documento (`RSK-10`) e as transições genéricas (`DOC-09`/`DOC-10`/`DOC-12`) seguem o mesmo padrão transacional de US-065.

## Frontend
- **Tela(s):** SCR-011 (`/processos/[id]/riscos`), aba "Matriz"; tela de documento genérica (US-062/US-065) para o Mapa de Riscos.
- **Componentes:** `RiskHeatmapGrid` (grade probabilidade × impacto com contagem e lista por célula), `RiskFilterBar`, `EmitRiskMapButton`, `RiskMapCompletenessPanel` (lista pendências `RISK_*`), componentes genéricos de documento (`DocumentStatusBadge`, `FinalizeDocumentDialog`, `ReopenDocumentDialog`) reaproveitados de US-065.
- **Estados:** vazio (FA-02); skeleton na matriz; pendências bloqueantes destacadas antes de permitir finalizar; sucesso com confirmação e link para o documento finalizado.
- **Acessibilidade e responsividade:** células da grade com `aria-label` (probabilidade, impacto, quantidade, nível); grade rola horizontalmente em telas estreitas mantendo cabeçalhos fixos.

## Banco de dados
- **Tabelas:** `documents` (escrita, via fluxo genérico), `document_versions` (escrita, via US-065), `risks`/`risk_treatments` (leitura para matriz e snapshot).
- **Migrações:** nenhuma migração nova específica desta story (reaproveita `documents`/`document_versions` de DEC-017 e `risks`/`risk_treatments` de US-033/US-034).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id, singleton_key) WHERE singleton_key IS NOT NULL AND status <> 'CANCELED' AND deleted_at IS NULL` (RN-RISK-19, já prevista em entities.md para `documents`).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| RSK-09 | GET | `/api/v1/processes/{id}/risk-matrix` | `?phase=&categoryId=&status=` | `200 { data: { scale, levelThresholds, cells: [{ probability, impact, score, level, risks: [{ id, code, title }] }] } }` | 200, 403, 404 |
| RSK-10 | POST | `/api/v1/processes/{id}/risk-map` | `{}` (sem campos; usa os riscos vigentes) + `Idempotency-Key` | `201 { data: Document }` | 201, 403, 409, 422 |
| DOC-08 | GET | `/api/v1/documents/{id}/validation` | — | `200 { data: { violations: [...] } }` | 200, 403 |
| DOC-09 | POST | `/api/v1/documents/{id}/submit` | `If-Match` + `Idempotency-Key` | `200 { data: Document }` | 200, 403, 409, 412, 422 |
| DOC-10 | POST | `/api/v1/documents/{id}/finalize` | `If-Match` + `Idempotency-Key` | `200 { data: Document }` | 200, 403, 409, 412, 422 |
| DOC-12 | POST | `/api/v1/documents/{id}/reopen` | `{ reason }` + `If-Match` | `200 { data: Document }` | 200, 403, 409, 412, 422 |
| DOC-05 | PUT | `/api/v1/documents/{id}/sections/{sectionKey}` | seção narrativa opcional do template (US-110) | `200 { data: Document }` | 200, 403, 412 |

## Logs
- `info` `risk_map.matrix_viewed` — `processId`, `riskCount`, `correlationId` (amostrado).
- `info` `document.finalized` — `documentId`, `documentTypeCode = RISK_MAP`, `durationMs`.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar.
- `error` `document.finalize_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** descrição/causa/consequência dos riscos, observações dos tratamentos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `document.create` | `DATA_CHANGE` | Commit de `RSK-10` | `metadata`: `documentTypeCode = RISK_MAP` |
| `document.submit` | `WORKFLOW` | Commit de `DOC-09` | `metadata`: `approvalId?` |
| `document.finalize` | `DATA_CHANGE` | Commit de `DOC-10` | `metadata`: `documentVersionId`, quantidade de riscos no snapshot |
| `document.reopen` | `DATA_CHANGE` | Commit de `DOC-12` | `metadata`: `fromStatus`, `reason` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/escopo | `reasonCode = RISK_MAP_SUBMIT` ou `RISK_MANAGE` |

## Testes necessários
- **Unitários:** agregação da matriz (`RiskMatrix`, RN-RISK-18); regras de completude (`RISK_LIST_EMPTY`, `RISK_TREATMENT_REQUIRED_FOR_LEVEL`); `RiskMapSnapshotBuilder` (RN-RISK-20).
- **Integração (Testcontainers PostgreSQL + Redis):** singleton do `RISK_MAP` por processo (RN-RISK-19); bloqueio de riscos após finalização e liberação após reabertura (RN-RISK-23); RLS por tenant.
- **Concorrência:** finalização concorrente do mesmo documento → `VERSION_CONFLICT`.
- **API/contrato:** respostas e erros conforme api.md; compatibilidade com o fluxo genérico de documento (US-065).
- **RBAC e multi-tenant:** com/sem `RISK_MAP_SUBMIT`; processo de outro tenant → 404.
- **E2E (Playwright):** jornada completa — registrar risco (US-033), tratar (US-034), visualizar matriz, emitir e finalizar o Mapa de Riscos, reabrir.
- **Acessibilidade/performance:** axe sem violações sérias na grade de calor; matriz com 100 riscos renderiza em < 500 ms.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `RISK_MANAGE`/`RISK_MAP_SUBMIT` e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos (`DocumentCreated`, `DocumentFinalized`, `DocumentReopened`) verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de RSK-09/RSK-10 compatível com api.md; reaproveitamento de DOC-05/08/09/10/12 sem divergência de contrato
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — reaproveita integralmente o ciclo de vida genérico de documento (US-065); o trabalho novo é a agregação da matriz e as regras de completude específicas de risco.

## Prioridade
**P1** — formaliza e documenta a gestão de riscos já operacional desde US-033/US-034; importante para a instrução do processo, mas não bloqueia o dia a dia do registro e tratamento de riscos.
