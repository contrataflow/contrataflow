---
id: US-021
title: "Gerenciar alternativas de solução"
epic: EP-003
feature: FT-012
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-019]
modules: [etp, document, process, access, audit, platform]
screens: [SCR-008]
endpoints: [ETP-05, ETP-06, ETP-07, ETP-08, ETP-09]
permissions: [ETP_UPDATE]
events: [EtpAlternativeRecommended]
---

# US-021 — Gerenciar alternativas de solução

## Título
Gerenciar alternativas de solução

## Descrição
**Como** integrante da equipe de planejamento, **quero** registrar as alternativas de solução levantadas para a contratação, comparando vantagens, desvantagens, custo estimado e risco, e decidir qual é a recomendada, **para** documentar o levantamento de mercado (art. 18, §1º, V) e justificar a solução escolhida (art. 18, §1º, VII) dentro do ETP.

Na seção "Alternativas" do ETP (SCR-008), o usuário cadastra quantas alternativas forem necessárias, cada uma com nome, descrição, vantagens, desvantagens, custo estimado, nível de risco e observações. Cada alternativa tem uma decisão (`UNDER_ANALYSIS`, `RECOMMENDED`, `DISCARDED`); decidir por `RECOMMENDED` ou `DISCARDED` exige justificativa. No máximo uma alternativa pode estar `RECOMMENDED` por vez; recomendar uma nova quando já existe outra pede confirmação explícita (`replaceRecommended`). O quadro comparativo resultante alimenta a seção `ALTERNATIVES_TABLE` do ETP (US-020) e o `recommendedAlternativeId` do cabeçalho do ETP.

## Contexto
- Base legal: art. 18, §1º, V (levantamento de mercado, podendo-se considerar a existência de uma única alternativa) e VII (justificativa da solução escolhida), da Lei 14.133/2021.
- `EtpAlternative` é uma coleção tipada do ETP (DEC-017), distinta das seções narrativas; a seção `ALTERNATIVES` do template (`render = ALTERNATIVES_TABLE`) apenas exibe esse conteúdo e um texto complementar opcional (US-020, RN-ETP-12).
- `Etp.recommendedAlternativeId` é um campo desnormalizado que espelha a alternativa `RECOMMENDED` atual, usado para exibir a solução escolhida sem percorrer a coleção.
- Itens canônicos (DEC-019) não se aplicam diretamente a alternativas — elas são comparadas por custo total estimado (`estimatedCost`), não por item; o detalhamento por item fica nas estimativas da US-022.

## Objetivo
Permitir que a equipe de planejamento registre e compare alternativas de solução, chegando a exatamente uma alternativa recomendada (ou nenhuma, enquanto a análise está em curso), com todas as decisões de recomendação e descarte justificadas e auditáveis.

## Persona
- **Principal:** Equipe de planejamento da contratação (perfil `PLANEJAMENTO`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`).

## Pré-condições
- Usuário autenticado, com `ETP_UPDATE` em escopo que cubra a unidade atual do processo, custódia do processo ou participação `COLLABORATOR`/`CONSULTANT` (POL-02).
- ETP existe (US-019), pertence a um processo visível ao usuário (DEC-024) e está em status `DRAFT` ou `RETURNED`.

## Fluxo principal
1. Na seção "Alternativas" do ETP, o usuário aciona **"Nova alternativa"** e informa nome, descrição, vantagens, desvantagens, custo estimado, nível de risco e observações; o front envia `POST /api/v1/etps/{id}/alternatives` (`ETP-06`).
2. A API autoriza `ETP_UPDATE` + POL-02, valida os campos (RN-ETP-18) e cria a `EtpAlternative` com `decision = UNDER_ANALYSIS` e `sortOrder` ao final da lista; responde **201**.
3. O quadro comparativo é atualizado com a nova linha; o usuário repete o passo para quantas alternativas forem necessárias, reordenando por arrastar-e-soltar (`sortOrder`, via `ETP-07`).
4. Para decidir, o usuário abre uma alternativa e escolhe **"Recomendar"** ou **"Descartar"**, informando a justificativa (mínimo 20 caracteres); o front envia `POST /api/v1/etp-alternatives/{alternativeId}/decide` (`ETP-09`) com `{ decision, decisionJustification }` e `If-Match: "<version>"`.
5. A API autoriza, valida a justificativa e, se `decision = RECOMMENDED` e já existir outra alternativa `RECOMMENDED`, responde `RECOMMENDED_ALTERNATIVE_EXISTS` (409) a menos que o corpo traga `replaceRecommended: true` — nesse caso, a alternativa antes recomendada volta para `UNDER_ANALYSIS` (preservando seu histórico em auditoria) e a nova passa a `RECOMMENDED`; atualiza `Etp.recommendedAlternativeId` e publica `EtpAlternativeRecommended` (com `previousAlternativeId`, quando houver).
6. A API responde **200** com a alternativa atualizada; o quadro comparativo destaca a alternativa recomendada.
7. O usuário pode editar (`ETP-07`) ou excluir (`ETP-08`) alternativas enquanto o ETP estiver em `DRAFT`/`RETURNED`, exceto a alternativa `RECOMMENDED` corrente, que precisa ter a decisão alterada antes de ser excluída.

## Fluxos alternativos
- **FA-01 — Substituir a alternativa recomendada:** com `replaceRecommended: true`, a troca ocorre em uma única operação (RN-ETP-20); sem essa confirmação, a API bloqueia com `RECOMMENDED_ALTERNATIVE_EXISTS` e a UI oferece o botão "Substituir recomendação".
- **FA-02 — Única alternativa levantada:** o sistema permite registrar e recomendar uma única alternativa (a lei admite isso — art. 18, §1º, V); não há exigência de quantidade mínima.
- **FA-03 — Excluir a alternativa recomendada:** a UI pede primeiro para alterar a decisão (voltar a `UNDER_ANALYSIS` ou escolher outra como `RECOMMENDED`); a API rejeita a exclusão direta com `INVALID_STATE`.
- **FA-04 — Orçamento sigiloso:** com o processo marcado como `isBudgetConfidential`, o `estimatedCost` de cada alternativa é mascarado (`null` + `estimatedCostMasked: true`) para quem não atende POL-09, inclusive no quadro comparativo.
- **FA-05 — ETP não editável:** com o ETP fora de `DRAFT`/`RETURNED`, a seção de alternativas abre em modo somente leitura; qualquer mutação responde `DOCUMENT_NOT_EDITABLE`.

## Regras de negócio
- **RN-ETP-18** — `EtpAlternative` pertence a um ETP e a um processo (desnormalizado); `name` (até 150 caracteres) é único por ETP, sem diferenciar maiúsculas/minúsculas, entre as não excluídas; `description` (rich text) é obrigatória; `advantages`, `disadvantages` (rich text) e `observations` (texto) são opcionais; `estimatedCost` é opcional (mascarado se sigiloso); `riskLevel` é opcional; `sortOrder` define a ordem de exibição.
- **RN-ETP-19** — `decision` nasce `UNDER_ANALYSIS`; mudar para `RECOMMENDED` ou `DISCARDED` exige `decisionJustification` com no mínimo 20 caracteres (check constraint do banco garante que toda decisão diferente de `UNDER_ANALYSIS` tenha justificativa).
- **RN-ETP-20** — No máximo uma alternativa pode estar `RECOMMENDED` por ETP (índice único parcial). Decidir `RECOMMENDED` quando já existe outra recomendada é rejeitado com `RECOMMENDED_ALTERNATIVE_EXISTS` (409), salvo com `replaceRecommended: true`, que move a alternativa antes recomendada para `UNDER_ANALYSIS` antes de recomendar a nova, na mesma transação.
- **RN-ETP-21** — Ao recomendar uma alternativa, `Etp.recommendedAlternativeId` é atualizado (desnormalizado) e o evento `EtpAlternativeRecommended` é publicado com `previousAlternativeId` preenchido quando havia substituição.
- **RN-ETP-22** — Exclusão (lógica, `+SD`) só é permitida com o ETP em `DRAFT`/`RETURNED` e a alternativa não sendo a `RECOMMENDED` corrente (`INVALID_STATE` caso contrário); a alternativa excluída some do quadro comparativo, mas permanece auditável.
- **RN-ETP-23** — O quadro comparativo (seção `ALTERNATIVES`, `render = ALTERNATIVES_TABLE`) lista as alternativas não excluídas ordenadas por `sortOrder`, com nome, decisão, custo estimado (mascarado conforme POL-09) e nível de risco; é recalculado a cada criação, edição, exclusão ou decisão.
- **RN-ETP-24** — `estimatedCost` segue POL-09 (orçamento sigiloso): mascarado (`null` + `estimatedCostMasked: true`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia atual do processo; aplicado no quadro comparativo, em PDFs/renditions e em exportações.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `name` | texto curto | Sim | ≤ 150 caracteres; único por ETP (case-insensitive) | — |
| Descrição | `description` | rich text | Sim | — | — |
| Vantagens | `advantages` | rich text | Não | — | — |
| Desvantagens | `disadvantages` | rich text | Não | — | — |
| Custo estimado | `estimatedCost` | moeda (BRL) | Não | ≥ 0; 2 casas; mascarado se sigiloso (POL-09) | — |
| Nível de risco | `riskLevel` | seleção (`RiskLevel`) | Não | enum | — |
| Observações | `observations` | texto longo | Não | — | — |
| Ordem | `sortOrder` | número | Não | — | posição de inserção |
| Decisão | `decision` | enum (`AlternativeDecision`) | Sim | `UNDER_ANALYSIS`\|`RECOMMENDED`\|`DISCARDED` | `UNDER_ANALYSIS` |
| Justificativa da decisão | `decisionJustification` | texto longo | Condicional (RN-ETP-19) | ≥ 20 caracteres | — |
| Substituir recomendação | `replaceRecommended` | booleano (técnico) | Não | só enviado após aviso | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `name` ausente, vazio ou acima de 150 caracteres | Front + API | "Informe um nome de até 150 caracteres para a alternativa." | `VALIDATION_ERROR` |
| V-02 | `description` ausente | Front + API | "Descreva a alternativa." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-03 | `name` duplicado no mesmo ETP | API | "Já existe uma alternativa com este nome neste ETP." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-04 | `decision` para `RECOMMENDED`/`DISCARDED` sem justificativa (≥ 20 caracteres) | Front + API | "Justifique a decisão (mín. 20 caracteres)." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`TOO_SHORT`) |
| V-05 | Recomendar quando já existe outra `RECOMMENDED` sem confirmar substituição | API | "Já existe uma alternativa recomendada. Substituir pela atual?" | `RECOMMENDED_ALTERNATIVE_EXISTS` |
| V-06 | Excluir a alternativa `RECOMMENDED` corrente | API | "Altere a decisão desta alternativa antes de excluí-la." | `INVALID_STATE` |
| V-07 | `estimatedCost` negativo ou com mais de 2 casas | Front + API | "Informe um valor válido, com até 2 casas decimais." | `VALIDATION_ERROR` (`INVALID_DECIMAL`) |
| V-08 | ETP não está em `DRAFT`/`RETURNED` | API | "Este ETP não pode ser editado no status atual." | `DOCUMENT_NOT_EDITABLE` |
| V-09 | `If-Match` divergente em editar/excluir/decidir | API | "Alguém alterou esta alternativa. Recarregue para ver as mudanças." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `ETP_UPDATE` com escopo que cubra a unidade atual do processo.
- **Políticas:** POL-02 (custódia/participação + status do documento + tipo permitido na etapa); POL-09 (mascaramento de `estimatedCost`).
- **MFA:** não exigido (`ETP_UPDATE` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** a seção de alternativas abre em modo somente leitura; mutações respondem 403 `PERMISSION_DENIED` e registram `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `EtpAlternativeRecommended` | `etp.alternative_recommended` | Decisão `RECOMMENDED` confirmada | Payload: `etpId`, `alternativeId`, `previousAlternativeId?` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: a recomendação é um registro de planejamento interno à equipe que já trabalha no ETP; não há destinatário adicional no MVP 1. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Gerenciar alternativas de solução

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o ETP "0003/2026" do processo "0012/2026", em status "DRAFT"
    And "Carla" possui "ETP_UPDATE" sobre o processo

  Scenario: [Sucesso] Criar e recomendar uma alternativa
    When "Carla" criar a alternativa "Locação de equipamentos" com descrição, custo estimado "15000.00" e risco "LOW"
    And decidir essa alternativa como "RECOMMENDED" com justificativa de 40 caracteres
    Then a alternativa deve ficar com decisão "RECOMMENDED"
    And o campo "recommendedAlternativeId" do ETP deve apontar para essa alternativa
    And deve gerar o evento "EtpAlternativeRecommended"
    And deve gerar registro de auditoria "etp.alternative_decide"

  Scenario: [Validação] Decidir sem justificativa
    Given que existe a alternativa "Aquisição direta" em "UNDER_ANALYSIS"
    When "Carla" tentar decidir essa alternativa como "DISCARDED" sem informar justificativa
    Then o sistema deve exibir "Justifique a decisão (mín. 20 caracteres)."
    And a decisão deve permanecer "UNDER_ANALYSIS"

  Scenario: [Permissão] Usuário sem ETP_UPDATE
    Given que o usuário "Bruno" possui apenas o perfil "SOMENTE_LEITURA"
    When "Bruno" abrir a seção de alternativas do ETP "0003/2026"
    Then os controles de criar, editar e decidir devem estar ocultos ou desabilitados
    When "Bruno" enviar "POST /api/v1/etps/{id}/alternatives"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Alternativa de outro tenant
    Given que a alternativa "X" pertence a um ETP do tenant "Prefeitura B"
    When "Carla", no tenant "Prefeitura de São José", enviar "PATCH /api/v1/etp-alternatives/{alternativeId}" referente à alternativa "X"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Nome de alternativa repetido no mesmo ETP
    Given que já existe a alternativa "Locação de equipamentos" no ETP "0003/2026"
    When "Carla" tentar criar outra alternativa chamada "locação de equipamentos" no mesmo ETP
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "DUPLICATE_IN_LIST" no campo "name"
    And nenhuma alternativa deve ser criada

  Scenario: [Concorrência] Duas decisões simultâneas recomendando alternativas diferentes
    Given que nenhuma alternativa do ETP "0003/2026" está "RECOMMENDED"
    When duas requisições simultâneas decidirem alternativas diferentes como "RECOMMENDED"
    Then exatamente uma deve responder 200 e ficar "RECOMMENDED"
    And a outra deve responder 409 com código "RECOMMENDED_ALTERNATIVE_EXISTS"
    And deve existir exatamente uma alternativa "RECOMMENDED" no ETP

  Scenario: [Falha de banco] Banco indisponível ao decidir
    Given que o banco de dados fica indisponível durante a decisão
    When "Carla" decidir recomendar uma alternativa
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a decisão anterior deve permanecer inalterada

  Scenario: [Falha de integração] Relay do outbox indisponível ao recomendar
    Given que o relay do outbox está indisponível
    When "Carla" recomendar uma alternativa com sucesso
    Then a API deve responder 200
    And o evento "EtpAlternativeRecommended" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Nome duplicado no ETP | 422 | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) | "Já existe uma alternativa com este nome neste ETP." | Foca o campo nome |
| Justificativa ausente/curta | 422 | `VALIDATION_ERROR` | "Justifique a decisão (mín. 20 caracteres)." | Foca o campo de justificativa |
| Já existe alternativa recomendada | 409 | `RECOMMENDED_ALTERNATIVE_EXISTS` | "Já existe uma alternativa recomendada. Substituir pela atual?" | Oferece "Substituir recomendação" |
| Excluir a recomendada sem trocar a decisão | 409 | `INVALID_STATE` | "Altere a decisão desta alternativa antes de excluí-la." | Bloqueia a exclusão; sugere alterar decisão |
| ETP não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Este ETP não pode ser editado no status atual." | Seção em modo leitura |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Alguém alterou esta alternativa. Recarregue para ver as mudanças." | Recarrega a alternativa |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não pode editar as alternativas deste ETP." | Oculta/desabilita controles |
| Recurso de outro tenant/não visível | 404 | `NOT_FOUND` | "Alternativa não encontrada." | Redireciona à lista |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente em instantes." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-019 (criação do ETP, dono da coleção de alternativas). Relacionadas: US-020 (seção `ALTERNATIVES_TABLE` que exibe este conteúdo), US-022 (estimativas, que detalham custo por item), US-023 (completude exige uma alternativa `RECOMMENDED` quando o ETP for `VIABLE`).
- **Decisões/ADRs:** DEC-010, DEC-017, DEC-019; ADR-006.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** não há, em api.md §2.2, um código de domínio dedicado para "nome de alternativa duplicado no mesmo ETP" (situação distinta de `DUPLICATE_INTERNAL_CODE`/`DOCUMENT_ALREADY_EXISTS`, que tratam de outros recursos). Usamos o conceito mais próximo, `VALIDATION_ERROR` com `errors[].code = "DUPLICATE_IN_LIST"` no campo `name`; propomos avaliar um código dedicado (ex.: `ALTERNATIVE_NAME_DUPLICATE`, 409) em uma futura revisão de api.md.

## Impacto técnico
- Reaproveita o padrão de comando transacional de documentos (POL-02, auditoria, outbox); a única regra de concorrência nova é o índice único parcial de alternativa `RECOMMENDED`, que resolve a corrida de recomendação dupla sem lock explícito.
- A substituição de recomendação (`replaceRecommended`) é uma transação com duas atualizações (`UNDER_ANALYSIS` da antiga, `RECOMMENDED` da nova) + atualização do `Etp.recommendedAlternativeId`, mantendo consistência mesmo em falha a meio caminho (tudo ou nada).
- Mascaramento de `estimatedCost` (POL-09) reaproveita o `ConfidentialFieldsInterceptor` central — nenhuma lógica de mascaramento própria nesta story.

## Backend
- **Módulo(s):** `etp` (dono de `EtpAlternative`); usa `document` (vínculo com o ETP/seção), `access` (POL-02, POL-09), `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `CreateEtpAlternativeCommand`, `UpdateEtpAlternativeCommand`, `DeleteEtpAlternativeCommand`, `DecideEtpAlternativeCommand` → respectivos handlers.
- **Domínio:** `EtpAlternative.create/update/decide(...)` (aplica RN-ETP-18..22); `Etp.setRecommendedAlternative(alternativeId, previousId?)`.
- **Integrações internas:** `access.ConfidentialFieldsInterceptor` (POL-09) na serialização.
- **Transação:** `decide` com `replaceRecommended` atualiza a alternativa antiga, a nova e o cabeçalho `Etp` na mesma transação.

## Frontend
- **Tela(s):** SCR-008 (`/processos/[id]/etp/[etpId]`, seção "Alternativas").
- **Componentes:** `AlternativesComparisonTable`, `AlternativeFormDrawer`, `DecideAlternativeDialog` (com campo de justificativa), `ReplaceRecommendedConfirm`, `MoneyInput` (BRL).
- **Estados:** vazio ("Nenhuma alternativa cadastrada ainda"); loading (skeleton da tabela); erro (toast); somente leitura (status não editável ou sem permissão).
- **Acessibilidade e responsividade:** tabela comparativa com cabeçalhos associados às células (leitores de tela); em telas < 768 px o quadro comparativo vira lista de cartões.

## Banco de dados
- **Tabelas:** `etp_alternatives`, `etps` (coluna `recommended_alternative_id`), `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, etp_id) WHERE decision = 'RECOMMENDED' AND deleted_at IS NULL`; `UNIQUE (tenant_id, etp_id, lower(name)) WHERE deleted_at IS NULL`; `CHECK (decision = 'UNDER_ANALYSIS' OR decision_justification IS NOT NULL)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| ETP-05 | GET | `/api/v1/etps/{id}/alternatives` | — | `200 { data: [EtpAlternative] }` ordenado por `sortOrder` | 200, 403, 404 |
| ETP-06 | POST | `/api/v1/etps/{id}/alternatives` | `{ name, description, advantages?, disadvantages?, estimatedCost?, riskLevel?, observations? }` | `201 { data: EtpAlternative }` | 201, 403, 404, 422 |
| ETP-07 | PATCH | `/api/v1/etp-alternatives/{alternativeId}` | campos de ETP-06 + `sortOrder?` + `If-Match` | `200 { data: EtpAlternative }` | 200, 403, 404, 409, 412, 422 |
| ETP-08 | DELETE | `/api/v1/etp-alternatives/{alternativeId}` | `If-Match` | `204` | 204, 403, 404, 409, 412 |
| ETP-09 | POST | `/api/v1/etp-alternatives/{alternativeId}/decide` | `{ decision, decisionJustification, replaceRecommended? }` + `If-Match` | `200 { data: EtpAlternative }` | 200, 403, 404, 409, 412, 422 |

## Logs
- `info` `etp.alternative_decided` — `etpId`, `alternativeId`, `decision`, `replaced` (booleano), `durationMs`, `tenantId`, `userId`.
- `warn` `etp.alternative_recommend_race` — quando a verificação de unicidade rejeitar uma recomendação concorrente.
- `error` `etp.alternative_command_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** descrição, vantagens, desvantagens, observações, justificativa da decisão, custo estimado.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `etp.alternative_create` | `DATA_CHANGE` | Criação da alternativa | `changes`: campos não sensíveis (nome, riskLevel); textos longos como hash + tamanho |
| `etp.alternative_update` | `DATA_CHANGE` | Edição de campos | `changes`: campos alterados |
| `etp.alternative_delete` | `DATA_CHANGE` | Exclusão lógica | `metadata`: `alternativeId` |
| `etp.alternative_decide` | `DATA_CHANGE` | Decisão `RECOMMENDED`/`DISCARDED` | `metadata`: `decision`, `replaceRecommended`, `previousAlternativeId?` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = ETP_UPDATE` |

## Testes necessários
- **Unitários:** fábrica/decisão de `EtpAlternative` (RN-ETP-18..22); formatação do quadro comparativo; mascaramento de `estimatedCost`.
- **Integração (Testcontainers):** índice único de `RECOMMENDED`; check constraint de justificativa; RLS impede acesso de outro tenant.
- **API/contrato:** respostas e erros de ETP-05..09 conforme api.md; cabeçalhos `If-Match`/`ETag`.
- **RBAC e multi-tenant:** `ETP_UPDATE` com e sem custódia/participação; POL-09 com e sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.
- **Concorrência:** duas decisões `RECOMMENDED` simultâneas em alternativas diferentes → uma 200, outra 409.
- **E2E (Playwright):** criar, reordenar, recomendar, substituir recomendação, excluir.
- **Acessibilidade/performance:** axe sem violações sérias na tabela comparativa e nos formulários.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] `ETP_UPDATE` + POL-02 + POL-09 aplicados na API; UI oculta/desabilita conforme regras
- [ ] Unicidade de alternativa recomendada coberta por teste de concorrência
- [ ] Auditoria (`etp.alternative_*`) e evento `EtpAlternativeRecommended` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de ETP-05 a ETP-09 compatível com api.md
- [ ] Logs sem dados sensíveis
- [ ] Acessibilidade (axe) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — CRUD tipado com uma regra de unicidade (alternativa recomendada) e mascaramento de valor sigiloso; sem fluxo de wizard ou integrações externas, mas com lógica de decisão e substituição que justifica um pouco mais que uma story pequena.

## Prioridade
**P0** — a escolha justificada da solução (art. 18, §1º, VII) é condição legal para a conclusão do ETP (US-023) e para as estimativas (US-022) terem uma alternativa de referência.
