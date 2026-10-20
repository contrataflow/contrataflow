---
id: US-033
title: "Registrar e avaliar riscos"
epic: EP-005
feature: FT-021
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-001, US-104]
modules: [risk, process, catalog, access, audit, platform]
screens: [SCR-011]
endpoints: [RSK-01, RSK-02, RSK-03, RSK-04, RSK-05, CAT-01, USR-01, USR-02, DEP-01]
permissions: [RISK_MANAGE]
events: [RiskCreated, RiskAssessed, RiskDeleted]
---

# US-033 — Registrar e avaliar riscos

## Título
Registrar e avaliar riscos

## Descrição
**Como** gestor de contratações (ou integrante da equipe de planejamento), **quero** identificar os riscos de um processo de contratação e avaliá-los por probabilidade × impacto, **para** antecipar ameaças ao sucesso da contratação e priorizar o que precisa de tratamento (US-034).

Cada risco recebe um código sequencial no processo (`R01`, `R02`…), uma categoria do catálogo `RISK_CATEGORY`, uma fase (`RiskPhase`), causa e consequência, e é avaliado em uma grade de probabilidade × impacto cuja escala é configurável por tenant (`risk.scale`, padrão 5×5). O sistema calcula `score` (probabilidade × impacto) e `level` pelas faixas vigentes (`risk.levelThresholds`), registrando a escala usada (`scaleSnapshot`) para rastreabilidade. Os riscos alimentam a matriz e o documento Mapa de Riscos (US-035).

## Contexto
- A Lei 14.133/2021 (art. 18, §1º, X) exige a gestão de riscos na fase preparatória; hoje isso é feito em planilhas avulsas, sem padronização de escala, sem histórico de reavaliação e sem ligação com o processo.
- `Risk` e `RiskTreatment` são definidos em DEC-021: riscos pertencem ao processo (DEC-010); o documento `RISK_MAP` (DEC-017/DEC-018) é o artefato formal cujo snapshot inclui os riscos vigentes — formalizado em US-035.
- Escala (`risk.scale`) e faixas de nível (`risk.levelThresholds`) são configuráveis por tenant; o padrão semeado é 5×5 com faixas 1–4 Baixo, 5–9 Médio, 10–16 Alto, 17–25 Extremo (DEC-021).
- Esta story estabelece o padrão de cálculo de score/nível que também é usado na reavaliação, no risco residual (opcional) e na matriz de calor (US-035).

## Objetivo
Permitir que um usuário autorizado registre e avalie um risco em menos de 1 minuto, com 100% dos riscos criados possuindo código sequencial, score e nível calculados automaticamente e consistentes com a escala vigente no momento da avaliação.

## Persona
- **Principal:** Gestor de contratações (perfil `GESTOR_CONTRATACOES`).
- **Secundárias:** Planejamento (`PLANEJAMENTO`), Área requisitante (`REQUISITANTE`).

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Processo existe, é visível ao usuário (DEC-024) e está em `DRAFT`/`IN_PROGRESS`/`RETURNED`.
- Usuário possui `RISK_MANAGE` em escopo que cubra o processo.
- Catálogo `RISK_CATEGORY` tem itens ativos (US-104).
- `risk.scale` e `risk.levelThresholds` configurados (os padrões semeados bastam).

## Fluxo principal
1. O usuário acessa a tela **Riscos** (SCR-011, `/processos/[id]/riscos`) a partir do painel do processo.
2. O sistema carrega os riscos existentes (`RSK-01`, ordenados por `sortOrder`/`code`) e as categorias ativas (`CAT-01` para `RISK_CATEGORY`).
3. O usuário clica **"Novo risco"**, informa título, descrição (opcional), categoria, fase, causa, consequência e responsável (usuário via `USR-02`/lookup, ou unidade via `DEP-01`), e avalia probabilidade e impacto em uma grade visual com os rótulos de `risk.scale`.
4. O sistema calcula `score = probabilidade × impacto` e o `level` pelas faixas vigentes em tempo real na UI, destacando a cor do nível.
5. O usuário salva; o front envia `POST /api/v1/processes/{id}/risks` (`RSK-02`) com `Idempotency-Key`.
6. A API, em transação: valida o corpo e as referências; autoriza `RISK_MANAGE` + política de edição (RN-RISK-09); atribui `code` sequencial no processo; grava `scaleSnapshot`, `score` e `level`; grava auditoria `risk.create` e o evento `RiskCreated` no outbox.
7. A API responde **201**; a UI insere o risco na lista e na pré-visualização da matriz.
8. Para reavaliar, o usuário edita probabilidade e/ou impacto de um risco existente; o front envia `PATCH /risks/{id}` (`RSK-04`) com `If-Match`. Se probabilidade ou impacto mudarem, a API recalcula `score`/`level`, grava novo `scaleSnapshot` e emite `RiskAssessed` (além de `risk.assess` na auditoria); demais edições geram `risk.update`.
9. Para remover um risco, o usuário usa **"Excluir"** (`DELETE /risks/{id}`, `RSK-05`); se houver tratamentos vinculados, o sistema lista-os no diálogo de confirmação antes de excluir em cascata.

## Fluxos alternativos
- **FA-01 — Reavaliação altera o nível:** ao recalcular, se o nível mudar, a UI exibe uma transição visual (ex.: "Alto → Médio") e `RiskAssessed` traz `fromLevel`/`toLevel` diferentes; se o nível não mudar, o evento ainda é emitido com `fromLevel = toLevel`.
- **FA-02 — Mudança da escala do tenant após riscos registrados:** riscos existentes mantêm o `scaleSnapshot` da última avaliação; não há recálculo retroativo automático. A escala vigente só é aplicada quando o risco for reavaliado ou na matriz (US-035), que sempre usa a escala atual.
- **FA-03 — Risco sem responsável definido:** `ownerId` e `ownerDepartmentId` podem ficar vazios; a lista destaca "Sem responsável" para facilitar o acompanhamento.
- **FA-04 — Processo não mais editável:** se o documento `RISK_MAP` do processo existir e não estiver em `DRAFT`/`RETURNED`, os botões de criar/editar/excluir ficam desabilitados e a tela exibe "Os riscos estão bloqueados porque o Mapa de Riscos foi concluído. Reabra o documento para editar.", com link para o documento (US-035).
- **FA-05 — Risco residual:** o usuário pode informar `residualProbability`/`residualImpact` (ambos, ou nenhum) após uma ação de tratamento; o sistema calcula `residualScore`/`residualLevel` pela mesma regra do risco original.

## Regras de negócio
- **RN-RISK-01** — Obrigatórios: `title`, `categoryId`, `phase`, `cause`, `consequence`, `probability`, `impact`.
- **RN-RISK-02** — `code` = `"R"` + sequência de 2 dígitos (`R01`, `R02`…), sequencial e imutável por processo; nunca reaproveitado após exclusão.
- **RN-RISK-03** — `probability` e `impact` ∈ `[1, risk.scale.max]` (padrão 1–5); `score = probability × impact` (check de banco); `level` é a faixa de `risk.levelThresholds` em que `minScore ≤ score ≤ maxScore` (faixas contíguas, sem lacunas — configurável, DEC-021).
- **RN-RISK-04** — `scaleSnapshot` grava `{ scale, levelThresholds }` vigentes no momento do cálculo (criação ou reavaliação), preservando o histórico mesmo que a configuração do tenant mude depois.
- **RN-RISK-05** — `categoryId` deve ser item **ativo** do catálogo `RISK_CATEGORY` do tenant.
- **RN-RISK-06** — `ownerId` (usuário) e `ownerDepartmentId` (unidade) são mutuamente opcionais e não exclusivos; nenhum é obrigatório.
- **RN-RISK-07** — `status` inicial `OPEN`; as transições `IN_TREATMENT`, `MITIGATED`, `MATERIALIZED`, `CLOSED` são geridas pelas ações de tratamento (US-034) e por ajuste manual em `RSK-04`, não pelo formulário de criação.
- **RN-RISK-08** — `residualProbability`/`residualImpact`/`residualScore`/`residualLevel` são opcionais; quando os dois primeiros são informados, `residualScore`/`residualLevel` são calculados pela mesma regra de RN-RISK-03.
- **RN-RISK-09** — Criar, editar ou excluir um risco segue a POL-02 estendida às coleções dos documentos tipados: `RISK_MANAGE` + (custódia **ou** participação `COLLABORATOR`/`CONSULTANT`) + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED` + tipo `RISK_MAP` permitido na etapa atual **e**, se já existir um documento `RISK_MAP` para o processo, que ele esteja em `DRAFT` ou `RETURNED`; caso contrário, `DOCUMENT_NOT_EDITABLE` (409) ou `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE` (422).
- **RN-RISK-10** — Excluir um risco remove em cascata (lógica, `+SD`) seus `RiskTreatment`; a exclusão é sempre confirmada explicitamente quando houver tratamentos vinculados.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Título | `title` | texto curto | Sim | 3–200 caracteres | — |
| Descrição | `description` | texto longo | Não | até 2.000 caracteres | — |
| Categoria | `categoryId` | seleção (catálogo `RISK_CATEGORY`) | Sim | item ativo; RN-RISK-05 | — |
| Fase | `phase` | seleção (`RiskPhase`) | Sim | enum | `PLANNING` |
| Causa | `cause` | texto longo | Sim | 10–1.000 caracteres | — |
| Consequência | `consequence` | texto longo | Sim | 10–1.000 caracteres | — |
| Probabilidade | `probability` | grade (1..`risk.scale.max`) | Sim | RN-RISK-03 | — |
| Impacto | `impact` | grade (1..`risk.scale.max`) | Sim | RN-RISK-03 | — |
| Responsável | `ownerId` | seleção de usuário | Não | RN-RISK-06 | — |
| Unidade responsável | `ownerDepartmentId` | seleção de unidade | Não | ativa; RN-RISK-06 | — |
| Probabilidade residual | `residualProbability` | grade | Não | RN-RISK-08 | — |
| Impacto residual | `residualImpact` | grade | Não | RN-RISK-08 | — |
| *(sistema)* Código | `code` | texto curto | — | RN-RISK-02 | gerado |
| *(sistema)* Score / Nível / Escala usada | `score`, `level`, `scaleSnapshot` | — | — | RN-RISK-03/04 | calculados |
| *(sistema)* Status | `status` | enum (`RiskStatus`) | — | RN-RISK-07 | `OPEN` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios presentes | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | Limites de tamanho (título, causa, consequência, descrição) | Front + API | "O {campo} deve ter entre X e Y caracteres." | `VALIDATION_ERROR` |
| V-03 | `probability`/`impact` fora de `[1, risk.scale.max]` | Front + API | "Selecione um valor entre 1 e {max}." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-04 | `categoryId` inexistente, inativo ou de outro tenant | API | "Selecione uma categoria válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-05 | `ownerId`/`ownerDepartmentId` inexistente, inativo ou de outro tenant | API | "Selecione um responsável válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-06 | Documento `RISK_MAP` não editável (RN-RISK-09) | API | "Os riscos estão bloqueados porque o Mapa de Riscos foi concluído." | `DOCUMENT_NOT_EDITABLE` |
| V-07 | Processo fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` | API | "Este processo não permite alterações nos riscos agora." | `INVALID_PROCESS_STATUS` |
| V-08 | Escopo de `RISK_MANAGE` não cobre o processo | API | "Você não tem permissão para gerenciar riscos deste processo." | `PERMISSION_DENIED` |
| V-09 | Mesma `Idempotency-Key` com corpo diferente | API | "Esta solicitação já foi enviada com outros dados." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `RISK_MANAGE` com escopo que cubra o `requestingDepartmentId` do processo (mesmo modelo de escopo de `PROCESS_VIEW`/`PROCESS_CREATE`).
- **Políticas:** POL-01 (custódia) e POL-02 estendida às coleções do documento tipado (RN-RISK-09); participação `COLLABORATOR`/`CONSULTANT` concede `RISK_MANAGE` (permissions.md §4).
- **MFA:** não exigido (`RISK_MANAGE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Novo risco" e as ações de editar/excluir não são exibidos; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `RiskCreated` | `risk.created` | Commit da criação | `riskId`, `code`, `level`, `phase`, `categoryCode` |
| `RiskAssessed` | `risk.assessed` | `probability` e/ou `impact` alterados | `riskId`, `fromLevel`, `toLevel`, `score` (mesmo sem mudança de nível) |
| `RiskDeleted` | `risk.deleted` | Commit da exclusão | `riskId`, `code` |

Projeção síncrona: entrada na timeline do processo para os três eventos acima.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação dedicada nesta story; o acompanhamento é feito na tela de riscos (US-034 trata o acompanhamento de prazos de tratamento). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Registrar e avaliar riscos

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And a escala de risco do tenant é "5x5" com faixas padrão (1-4 Baixo, 5-9 Médio, 10-16 Alto, 17-25 Extremo)
    And existe o processo "0012/2026" em status "IN_PROGRESS"
    And o usuário "Ana" tem vínculo ativo e possui "RISK_MANAGE" com escopo que cobre o processo

  Scenario: [Sucesso] Registrar um novo risco
    When "Ana" criar um risco com categoria "Risco de mercado", fase "PLANNING", causa, consequência, probabilidade 4 e impacto 4
    Then o risco deve ser criado com código "R01", score 16 e nível "HIGH"
    And o campo "scaleSnapshot" deve registrar a escala e as faixas vigentes
    And deve gerar registro de auditoria "risk.create"
    And deve gerar o evento RiskCreated

  Scenario: [Sucesso] Reavaliar um risco existente
    Given que o risco "R01" tem probabilidade 4, impacto 4 e nível "HIGH"
    When "Ana" alterar a probabilidade para 2
    Then o risco deve passar a ter score 8 e nível "MEDIUM"
    And deve gerar o evento RiskAssessed com "fromLevel" "HIGH" e "toLevel" "MEDIUM"
    And deve gerar registro de auditoria "risk.assess"

  Scenario: [Validação] Campos obrigatórios ausentes
    When "Ana" tentar salvar um risco sem informar a causa
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro no campo "cause"
    And nenhum risco deve ser criado

  Scenario: [Validação] Probabilidade fora da escala
    When "Ana" enviar probabilidade 7 com a escala "5x5"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" no campo "probability"

  Scenario: [Permissão] Usuário sem RISK_MANAGE
    Given que o usuário "Bruno" não possui "RISK_MANAGE"
    When "Bruno" acessar a tela de riscos do processo
    Then o botão "Novo risco" não deve ser exibido
    When "Bruno" enviar POST para criar um risco
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Referência de categoria de outro tenant
    Given que existe um item de catálogo "RISK_CATEGORY" no tenant "Prefeitura B"
    When "Ana", no tenant "Prefeitura de São José", enviar "categoryId" desse item
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "categoryId"
    And a resposta não deve revelar que o item existe em outro tenant

  Scenario: [Duplicidade] Reenvio com a mesma chave de idempotência
    Given que "Ana" criou o risco "R02" com a chave de idempotência "K1"
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo risco "R02" e o cabeçalho "Idempotent-Replayed: true"
    And deve existir apenas um risco "R02"

  Scenario: [Concorrência] Duas criações simultâneas recebem códigos distintos
    Given que o processo não possui riscos
    When dois usuários criarem riscos simultaneamente no mesmo processo
    Then um risco deve receber o código "R01" e o outro "R02", sem repetição

  Scenario: [Concorrência] Edição concorrente do mesmo risco
    Given que "Ana" e "Carla" abriram o risco "R01" com "ETag" igual a "2"
    When "Ana" salvar sua alteração e "Carla" tentar salvar com "If-Match" igual a "2"
    Then a resposta a "Carla" deve ser 412 com código "VERSION_CONFLICT" e "currentVersion" igual a "3"

  Scenario: [Falha de banco] Banco indisponível ao criar o risco
    Given que o banco de dados fica indisponível durante a criação
    When "Ana" tentar criar um risco
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhum risco deve ser persistido

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Ana" criar um risco válido
    Then o risco deve ser criado e a API deve responder 201
    And o evento RiskCreated deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (schema) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos com `errors[]`; foca o primeiro erro |
| Referência inexistente/inativa/outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um {campo} válido." | Recarrega opções do campo |
| Probabilidade/impacto fora da escala | 422 | `VALIDATION_ERROR` (`OUT_OF_RANGE`) | "Selecione um valor entre 1 e {max}." | Marca o campo na grade |
| Riscos bloqueados (Mapa de Riscos concluído) | 409 | `DOCUMENT_NOT_EDITABLE` | "Os riscos estão bloqueados porque o Mapa de Riscos foi concluído." | Desabilita ações; mostra link para o documento |
| Processo fora de status editável | 409 | `INVALID_PROCESS_STATUS` | "Este processo não permite alterações nos riscos agora." | Desabilita ações |
| Sem permissão/escopo | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar riscos deste processo." | Oculta botões de ação |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Este risco foi alterado por outra pessoa. Recarregue para ver a versão atual." | Recarrega o risco e destaca divergências |
| Chave de idempotência reutilizada | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta solicitação já foi enviada com outros dados." | Gera nova chave e pede nova confirmação |
| Banco/Redis crítico indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar o risco agora. Tente novamente em instantes." | Mantém dados; botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Mantém dados; botão copiar código |

## Dependências
- **Stories:** US-001 (processo precisa existir), US-104 (catálogo `RISK_CATEGORY`). Indiretas: US-097 (autorização e escopos), US-102 (unidades), US-073 (auditoria), US-082 (outbox).
- **Decisões/ADRs:** DEC-010, DEC-017, DEC-018, DEC-021, DEC-024; ADR-006.
- **Configurações:** `risk.scale`, `risk.levelThresholds`.
- **Lacunas nas fontes canônicas:** ~~política de edição de `Risk`/`RiskTreatment`~~ — resolvida: POL-02 passou a cobrir as coleções dos documentos tipados (permissions.md).

## Impacto técnico
- Sequência de `code` por processo (`R01`, `R02`…) segue o mesmo padrão de contenção leve usado em outras numerações internas (sem bloqueio de linha global como `NumberingFacade`, pois o volume por processo é baixo); a atribuição ocorre dentro da transação de criação, sob `pg_advisory_xact_lock` por processo, sobre o maior código já usado (inclusive excluídos — nunca reaproveitado), com o índice único `(tenant_id, process_id, code)` como rede de segurança.
- Cálculo de `score`/`level` é uma função pura do módulo `risk` (reutilizada por US-034 e pela matriz em US-035); deve ser centralizada para evitar divergência entre o valor gravado e o exibido.
- `scaleSnapshot` (jsonb) garante que mudanças futuras em `risk.scale`/`risk.levelThresholds` não alterem silenciosamente o significado histórico de uma avaliação já feita.

## Backend
- **Módulo(s):** `risk` (dono); usa `catalog` (`CatalogFacade.assertActive` para `RISK_CATEGORY`), `document` (`DocumentFacade.assertTypedCollectionWritableIn`/`typedCollectionStateIn`: a POL-02 estendida — `RISK_MANAGE` cobrindo o processo, por perfil ou participação, custódia/participação, status do processo, tipo na etapa e o `RISK_MAP` ativo em `DRAFT`/`RETURNED`, travado `FOR UPDATE` no `tx` — RN-RISK-09), `tenancy` (`risk.scale`/`risk.levelThresholds`), `identity`/`organization` (responsáveis), `audit`, `platform` (`OutboxWriter`, `IdempotencyService`). A tabela `risk_treatments` nasce na migração desta story (cascata lógica — RN-RISK-10); o CRUD dos tratamentos é da US-034.
- **Casos de uso:** `CreateRiskCommand` → `CreateRiskHandler`; `AssessRiskCommand` (dentro de `UpdateRiskHandler`, disparado quando `probability`/`impact` mudam); `DeleteRiskHandler`.
- **Domínio:** `Risk.create(props)` (RN-RISK-01..06); `Risk.assess(probability, impact, scale)` (RN-RISK-03/04, emite `RiskAssessed`); value object `RiskScore` (cálculo de `score`/`level`).
- **Transação:** criação/edição/exclusão em transação única com `app.tenant_id`; checagem de editabilidade (RN-RISK-09) lida dentro da mesma transação para evitar corrida com a finalização do `RISK_MAP`.
- **Idempotência:** `@Idempotent()` (Redis, 24 h) na criação (`RSK-02`).

## Frontend
- **Tela(s):** SCR-011 (`/processos/[id]/riscos`), aba ou seção "Lista de riscos".
- **Componentes:** `RiskList`, `RiskFormDrawer`, `ProbabilityImpactGrid` (seleção visual com rótulos de `risk.scale`), `LevelBadge` (cor por `RiskLevel`), `CatalogSelect` (`RISK_CATEGORY`), `UserSelect`/`DepartmentTreeSelect` (responsável), `DeleteRiskDialog` (lista tratamentos vinculados).
- **Estados:** skeleton na lista; vazio ("Nenhum risco registrado. Comece identificando o primeiro risco."); erro com "Tentar novamente"; bloqueado (FA-04) com aviso e link para o documento.
- **Acessibilidade e responsividade:** grade de probabilidade × impacto navegável por teclado com `aria-label` por célula; cores de nível acompanhadas de texto (não dependem só de cor); layout em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `risks` (escrita), `risk_treatments` (leitura, para o diálogo de exclusão), `catalog_items` (leitura).
- **Migrações:** criação de `risks` conforme entities.md (padrão + SD), índice `(tenant_id, process_id, level)`, unique `(tenant_id, process_id, code)`.
- **Índices/constraints relevantes:** `CHECK (probability > 0 AND impact > 0)`; `CHECK (score = probability * impact)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| RSK-01 | GET | `/api/v1/processes/{id}/risks` | `?phase=&categoryId=&status=` | `200 { data: Risk[] }` | 200, 403, 404 |
| RSK-02 | POST | `/api/v1/processes/{id}/risks` | `{ title, description?, categoryId, phase, cause, consequence, probability, impact, ownerId?, ownerDepartmentId? }` + `Idempotency-Key` | `201 { data: Risk }` com `code`, `score`, `level`, `version` | 201, 403, 409, 422, 503 |
| RSK-03 | GET | `/api/v1/risks/{id}` | — | `200 { data: Risk }` | 200, 403, 404 |
| RSK-04 | PATCH | `/api/v1/risks/{id}` | campos parciais (inclui `residualProbability`/`residualImpact`) + `If-Match` | `200 { data: Risk }` | 200, 403, 409, 412, 422 |
| RSK-05 | DELETE | `/api/v1/risks/{id}` | `If-Match` | `204` | 204, 403, 409, 412 |
| CAT-01, USR-01/02, DEP-01 | GET | (leituras de apoio) | — | — | 200 |

## Logs
- `info` `risk.created` — `riskId`, `processId`, `code`, `level`, `correlationId`.
- `info` `risk.assessed` — `riskId`, `fromLevel`, `toLevel`, `score`.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar.
- `error` `risk.create_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** título, descrição, causa, consequência.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `risk.create` | `DATA_CHANGE` | Commit da criação | `changes`: categoria, fase, probabilidade, impacto; `metadata`: `code`, `level` |
| `risk.update` | `DATA_CHANGE` | Edição sem mudança de probabilidade/impacto | `changes`: campos alterados |
| `risk.assess` | `DATA_CHANGE` | Edição com mudança de probabilidade e/ou impacto | `changes`: `fromScore`, `toScore`, `fromLevel`, `toLevel` |
| `risk.delete` | `DATA_CHANGE` | Commit da exclusão | `metadata`: `code`, quantidade de tratamentos removidos |
| `access.denied` | `ACCESS` | Tentativa sem permissão/escopo | `reasonCode = RISK_MANAGE` |

## Testes necessários
- **Unitários:** cálculo de `score`/`level` nas bordas das faixas; `Risk.create`/`Risk.assess` (RN-RISK-01..08); geração sequencial de `code`.
- **Integração (Testcontainers PostgreSQL + Redis):** atomicidade da criação; RLS por tenant; bloqueio de edição quando `RISK_MAP` não está em `DRAFT`/`RETURNED`; exclusão em cascata de tratamentos.
- **Concorrência:** 2 criações simultâneas no mesmo processo → códigos `R01`/`R02` sem colisão; edição concorrente → `VERSION_CONFLICT`.
- **API/contrato:** respostas e erros conforme api.md; cabeçalhos `ETag`, `If-Match`, `Idempotent-Replayed`.
- **RBAC e multi-tenant:** com/sem `RISK_MANAGE`; referência de outro tenant → 422 `REFERENCE_NOT_FOUND`.
- **E2E (Playwright):** criar, reavaliar e excluir um risco na tela SCR-011.
- **Acessibilidade/performance:** axe sem violações sérias na grade de probabilidade × impacto.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `RISK_MANAGE` e RN-RISK-09 aplicados na API; UI esconde/desabilita conforme regras
- [ ] Auditoria (`risk.create`/`risk.update`/`risk.assess`/`risk.delete`) e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de RSK-01..05 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — CRUD com cálculo derivado (score/nível), escala configurável e integração com a política de bloqueio do Mapa de Riscos; sem numeração transacional pesada nem wizard multi-etapas.

## Prioridade
**P0** — gestão de riscos é exigida pela Lei 14.133/2021 na fase preparatória e é pré-requisito para US-034 e US-035.
