---
id: US-027
title: "Desconsiderar e restaurar cotação com justificativa"
epic: EP-004
feature: FT-017
mvp: 1
priority: P0
estimate: S
status: Especificada
depends_on: [US-026]
modules: [price-research, access, audit, timeline, platform]
screens: [SCR-009]
endpoints: [PRS-16, PRS-17]
permissions: [PRICE_RESEARCH_EXCLUDE_QUOTATION]
events: [QuotationExcluded, QuotationRestored, PriceResearchRecalculated]
---

# US-027 — Desconsiderar e restaurar cotação com justificativa

## Título
Desconsiderar e restaurar cotação com justificativa

## Descrição
**Como** responsável pela pesquisa de preços, **quero** desconsiderar uma cotação inconsistente, excessiva ou inviável — registrando o motivo — e poder restaurá-la depois, **para** manter o cálculo do valor estimado confiável sem perder o histórico da evidência descartada. Desconsiderar não é excluir: a cotação permanece visível, com motivo e justificativa, fora dos cálculos estatísticos, e pode ser restaurada a qualquer momento, voltando a participar do cálculo.

## Contexto
- Durante a pesquisa é comum encontrar cotações com preço muito acima/abaixo do mercado, vencidas ou obtidas de forma inconsistente; a Lei 14.133/2021 não veda removê-las do cálculo, mas exige que a decisão seja motivada e rastreável.
- DEC-020: outliers (US-030) são **sinalizados**, nunca excluídos automaticamente — desconsiderar é sempre uma decisão humana e explícita; diferente da remoção definitiva (US-026, `PRS-15`), a cotação desconsiderada é preservada (status `EXCLUDED`) para auditoria e eventual reversão.

## Objetivo
Permitir que o responsável desconsidere ou restaure uma cotação em poucos segundos, com 100% das desconsiderações acompanhadas de motivo e justificativa (≥ 20 caracteres) e rastreáveis na timeline do processo.

## Persona
- **Principal:** Equipe de planejamento da contratação (`PLANEJAMENTO`); **secundárias:** Setor de Compras (`COMPRAS`) e Gestor de contratações (`GESTOR_CONTRATACOES`).

## Pré-condições
- Existe ao menos uma `Quotation` no item da pesquisa, e o usuário possui `PRICE_RESEARCH_EXCLUDE_QUOTATION` em escopo que cubra o processo, com o documento `PRICE_RESEARCH` em `DRAFT`/`RETURNED` (POL-02).

## Fluxo principal
1. Na grade de cotações (SCR-009), o usuário aciona **"Desconsiderar"** em uma cotação `VALID`, o que abre um diálogo com **Motivo** (`ExclusionReason`) e **Justificativa** (texto livre, mínimo 20 caracteres).
2. O usuário escolhe o motivo, escreve a justificativa e confirma. O front envia `POST /api/v1/quotations/{quotationId}/exclude` (`PRS-16`) com `If-Match`.
3. A API valida a justificativa, muda `status` para `EXCLUDED`, grava `exclusionReason`, `exclusionJustification`, `excludedById`, `excludedAt`, recalcula as estatísticas do item, registra a entrada na timeline e a auditoria `price_research.quotation_exclude`, e publica `QuotationExcluded` e `PriceResearchRecalculated`.
4. A API responde **200**; a célula passa a aparecer esmaecida na grade, com o motivo em tooltip e o botão **"Restaurar"**.
5. Ao clicar em **"Restaurar"**, o front envia `POST /api/v1/quotations/{quotationId}/restore` (`PRS-17`) com `If-Match`; a API volta `status` para `VALID`, limpa os campos de exclusão, recalcula, registra timeline/auditoria `price_research.quotation_restore` e publica `QuotationRestored` e `PriceResearchRecalculated`.

## Fluxos alternativos
- **FA-01 — Última cotação válida do item:** desconsiderar a única cotação `VALID` restante de um item é permitido (não bloqueado), mas o diálogo avisa "Este item ficará sem cotação válida" antes de confirmar; o alerta `NO_VALID_QUOTES` do item é tratado em US-030.
- **FA-02 — Transição inválida:** o botão "Desconsiderar" não aparece para cotações já `EXCLUDED`, nem "Restaurar" para cotações já `VALID`; chamando a API diretamente em qualquer um dos casos, responde `INVALID_STATE`.
- **FA-03 — Pesquisa não editável:** com o documento fora de `DRAFT`/`RETURNED`, os botões "Desconsiderar"/"Restaurar" ficam ocultos; a API responde `DOCUMENT_NOT_EDITABLE`.

## Regras de negócio
- **RN-PRICE-30** — Desconsiderar (`PRS-16`) exige `exclusionReason` (enum `ExclusionReason`) e `exclusionJustification` com no mínimo 20 caracteres; grava `excludedById`/`excludedAt` e muda `status` para `EXCLUDED`.
- **RN-PRICE-31** — Cotação `EXCLUDED` é ignorada em todos os cálculos estatísticos do item (US-029) e na sinalização de outliers (US-030), mas permanece listada com seu motivo e justificativa.
- **RN-PRICE-32** — Restaurar (`PRS-17`) só é permitido para cotação `EXCLUDED`; volta a `VALID`, limpa `exclusionReason`, `exclusionJustification`, `excludedById` e `excludedAt`. Tentar excluir uma já `EXCLUDED` ou restaurar uma já `VALID` retorna `INVALID_STATE` (409).
- **RN-PRICE-33** — Toda exclusão/restauração gera entrada na timeline do processo e registro de auditoria com a justificativa; a ação nunca é bloqueada por ficar o item sem cotações válidas (apenas sinalizada — US-030).
- **RN-PRICE-34** — Excluir ou restaurar uma cotação dispara o recálculo das estatísticas do item (`PriceResearchRecalculated`, detalhado em US-029).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Motivo | `exclusionReason` | seleção (`ExclusionReason`) | Sim (ao desconsiderar) | enum | — |
| Justificativa | `exclusionJustification` | texto longo | Sim (ao desconsiderar) | ≥ 20 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `exclusionReason` ausente | Front + API (Zod) | "Selecione o motivo." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-02 | `exclusionJustification` com menos de 20 caracteres | Front + API | "A justificativa deve ter no mínimo 20 caracteres." | `VALIDATION_ERROR` (`TOO_SHORT`) |
| V-03 | Desconsiderar cotação já `EXCLUDED` / restaurar já `VALID` | API | "Esta cotação já está {estado}." | `INVALID_STATE` |
| V-04 | Pesquisa não editável | API | "Esta pesquisa de preços não pode mais ser editada." | `DOCUMENT_NOT_EDITABLE` |

## Permissões
- **Permissão:** `PRICE_RESEARCH_EXCLUDE_QUOTATION` com escopo que cubra o processo; MFA não exigido (risco M), salvo `security.mfaPolicy = ALL`.
- **Políticas:** POL-02 (documento `PRICE_RESEARCH` em `DRAFT`/`RETURNED`) e POL-09 (mascaramento do orçamento sigiloso nas respostas).
- **Sem permissão:** botões "Desconsiderar"/"Restaurar" ocultos; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `QuotationExcluded` | `price_research.quotation_excluded` | Commit da exclusão | `priceResearchId`, `quotationId`, `priceItemId`, `reason` |
| `QuotationRestored` | `price_research.quotation_restored` | Commit da restauração | `priceResearchId`, `quotationId`, `priceItemId` |
| `PriceResearchRecalculated` | `price_research.recalculated` | Em seguida a ambos | `priceResearchId`, `itemsCount`, `itemsWithAlertsCount` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: ação pontual dentro da edição da pesquisa, visível a quem acompanha o processo pela timeline. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Desconsiderar e restaurar cotação com justificativa

  Background:
    Given que o tenant "Prefeitura de São José" está ativo, existe a cotação "Q1" "VALID" do item 1 na pesquisa do processo "0012/2026", e o usuário "Diego" tem "PRICE_RESEARCH_EXCLUDE_QUOTATION" sobre o processo

  Scenario: [Sucesso] Desconsiderar e depois restaurar uma cotação
    When "Diego" desconsiderar "Q1" com motivo "INCONSISTENT" e justificativa "Preço muito acima das demais cotações do mesmo item"
    Then "Q1" deve ficar com status "EXCLUDED", gerar o evento "QuotationExcluded" e o registro de auditoria "price_research.quotation_exclude"
    When "Diego" restaurar "Q1"
    Then "Q1" deve voltar ao status "VALID" e gerar o evento "QuotationRestored"

  Scenario: [Validação] Justificativa muito curta
    When "Diego" tentar desconsiderar "Q1" com justificativa "Preço alto"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "TOO_SHORT" no campo "exclusionJustification"

  Scenario: [Permissão] Usuário sem PRICE_RESEARCH_EXCLUDE_QUOTATION
    Given que o usuário "Eva" possui apenas "PROCESS_VIEW"
    When "Eva" tentar desconsiderar "Q1"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Cotação de outro tenant
    Given que a cotação "Q9" pertence ao tenant "Prefeitura B"
    When "Diego", no tenant "Prefeitura de São José", tentar desconsiderar "Q9"
    Then a API deve responder 404 com código "NOT_FOUND"

  Scenario: [Duplicidade] Desconsiderar a mesma cotação duas vezes
    Given que "Q1" já está "EXCLUDED"
    When "Diego" tentar desconsiderar "Q1" novamente
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Concorrência] Desconsiderar e restaurar simultaneamente
    Given que "Q1" está "VALID" na versão 1
    When uma requisição de exclusão e uma de restauração chegarem quase ao mesmo tempo com cabeçalho "If-Match" igual a "1"
    Then apenas uma deve ser aplicada com sucesso e a outra deve receber 412 "VERSION_CONFLICT" ou 409 "INVALID_STATE"

  Scenario: [Falha de banco] Banco indisponível ao desconsiderar
    Given que o banco de dados fica indisponível durante a transação
    When "Diego" tentar desconsiderar "Q1"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e "Q1" deve permanecer "VALID"

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Diego" desconsiderar "Q1" com sucesso
    Then a API deve responder 200 e o evento "QuotationExcluded" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Justificativa curta/motivo ausente | 422 | `VALIDATION_ERROR` | "Selecione o motivo e informe uma justificativa de pelo menos 20 caracteres." | Mantém diálogo aberto com erro |
| Estado incompatível (já excluída/já válida) | 409 | `INVALID_STATE` | "Esta cotação já está {estado}." | Atualiza a célula com o estado atual |
| Documento não editável | 409 | `DOCUMENT_NOT_EDITABLE` | "Esta pesquisa de preços não pode mais ser editada." | Oculta os botões de ação |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Esta cotação foi alterada por outra pessoa. Recarregue os dados." | Recarrega a célula |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém o diálogo com os dados preenchidos |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-026 (fontes e cotações já registradas). US-029 (estatísticas) e US-030 (outliers/alertas `NO_VALID_QUOTES`) consomem o resultado desta story.
- **Decisões/ADRs:** DEC-020, DEC-030. **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Ação de estado simples (duas transições), mas com efeito colateral obrigatório (recálculo + timeline + auditoria) replicado em ambos os sentidos — reaproveitar o mesmo `PriceResearchFacade.recalculate` usado em US-026/US-029; `If-Match` incide sobre a versão da própria `Quotation` (não da fonte), diferente de `PRS-13`/`PRS-14`.

## Backend
- **Módulo(s):** `price-research` (dono); usa `timeline` (projetor síncrono), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso / Domínio:** `ExcludeQuotationCommand`/`Handler` e `RestoreQuotationCommand`/`Handler`, sobre `Quotation.exclude(reason, justification, actorId)` e `Quotation.restore()`.
- **Transação:** mudança de status + recálculo + timeline + auditoria + outbox em uma transação única com `app.tenant_id`.

## Frontend
- **Tela(s):** SCR-009 (`/processos/[id]/pesquisa-precos/[researchId]`), grade de cotações.
- **Componentes:** `ExcludeQuotationDialog` (motivo + justificativa), botão "Restaurar" inline na célula.
- **Estados e acessibilidade:** célula esmaecida com tooltip do motivo quando `EXCLUDED`; diálogo com foco automático no campo "Motivo" e erro de justificativa anunciado via `aria-live`.

## Banco de dados
- **Tabelas/Migrações:** `quotations` (sem nova tabela nem migração adicional a US-026).
- **Índices/constraints relevantes:** `CHECK (status <> 'EXCLUDED' OR (exclusion_reason IS NOT NULL AND exclusion_justification IS NOT NULL))` (já criado em US-026, reforça esta story).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRS-16 | POST | `/api/v1/quotations/{quotationId}/exclude` | `{ exclusionReason, exclusionJustification }` + `If-Match` | `200 { data: Quotation }` | 200, 403, 404, 409, 412, 422 |
| PRS-17 | POST | `/api/v1/quotations/{quotationId}/restore` | `If-Match` | `200 { data: Quotation }` | 200, 403, 404, 409, 412 |

## Logs
- `info` `price_research.quotation_excluded` / `quotation_restored` — `quotationId`, `priceItemId`, `reason?`, `correlationId`.
- `error` `price_research.exclude_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** `exclusionJustification` (texto livre, pode conter dados sensíveis do fornecedor).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `price_research.quotation_exclude` | `DATA_CHANGE` | Commit da exclusão | `metadata`: `reason`; `changes`: justificativa como hash + tamanho |
| `price_research.quotation_restore` | `DATA_CHANGE` | Commit da restauração | `metadata`: `priceItemId` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = PRICE_RESEARCH_EXCLUDE_QUOTATION` |

## Testes necessários
- **Unitários:** `Quotation.exclude`/`restore` (transições válidas/inválidas); validação de justificativa ≥ 20.
- **Integração (Testcontainers):** check constraint de exclusão; recálculo disparado; timeline e auditoria na mesma transação.
- **API/contrato:** respostas e erros conforme api.md; `ETag`/`If-Match`.
- **RBAC, multi-tenant e concorrência:** permissão dedicada; cotação de outro tenant → 404; exclusão e restauração simultâneas da mesma cotação.
- **E2E (Playwright):** desconsiderar, ver célula esmaecida, restaurar.
- **Acessibilidade/performance:** axe no diálogo de exclusão.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PRICE_RESEARCH_EXCLUDE_QUOTATION` aplicado na API; UI oculta/desabilita conforme permissão e estado
- [ ] Timeline, auditoria e isolamento de tenant verificados em teste (suíte "tenant leak")
- [ ] OpenAPI de PRS-16/17 compatível com api.md
- [ ] Logs sem dados sensíveis; acessibilidade (axe) verificada
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**S** — duas transições de estado bem delimitadas sobre uma entidade já existente (US-026), sem novos campos de cadastro nem telas novas.

## Prioridade
**P0** — sem desconsiderar cotações inconsistentes, o cálculo do valor estimado (US-029) fica vulnerável a distorções que a Lei 14.133/2021 exige tratar de forma motivada.
