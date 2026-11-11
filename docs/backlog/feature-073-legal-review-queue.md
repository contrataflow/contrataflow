---
id: FT-073
title: "Fila jurídica priorizada"
epic: EP-025
mvp: 2
priority: P0
stories: [US-149, US-150, US-151]
status: Especificada
---

# FT-073 — Fila jurídica priorizada

## Título
Fila jurídica priorizada

## Épico
EP-025 — Jurídico

## Descrição
Quando o processo entra na etapa `JURIDICO`, a plataforma abre a análise jurídica (`LegalReview`, `PENDING`) e a coloca numa fila ordenada por critérios objetivos configuráveis (art. 53, § 1º, I): prazo de vencimento da etapa, urgência declarada, valor estimado e data de entrada. A ordem é calculada e explicável (`priorityFactors`), e aparece na SCR-019 para a assessoria jurídica (US-149).

O chefe da assessoria distribui as análises aos procuradores, individualmente ou em lote, e redistribui quando preciso (US-150). O administrador do órgão configura os critérios e os pesos da fila e as hipóteses de dispensa de análise (art. 53, § 5º), na SCR-120 (US-151).

## Valor para o usuário e para o órgão
- A fila deixa de ser ordem de chegada ou de insistência: a prioridade segue critérios objetivos e auditáveis.
- O chefe da assessoria enxerga e distribui a carga sem planilha paralela.
- Cada órgão ajusta os critérios à sua Procuradoria sem alterar código.

## Personas
- Jurídico / procurador (`JURIDICO`) — vê a fila e assume as análises designadas.
- Chefe da assessoria jurídica (`JURIDICO`, titular da unidade) — distribui.
- Administrador do órgão (`ADMIN_ORGAO`) — configura critérios e hipóteses de dispensa.
- Auditor (`AUDITOR`) — confere a ordem e os fatores.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-149 ⏳ | Abrir a análise jurídica e fila priorizada | P0 | L | US-047, US-097, US-104 |
| US-150 ⏳ | Distribuir análises na assessoria jurídica | P0 | S | US-050, US-149 |
| US-151 ⏳ | Configurar critérios da fila e hipóteses de dispensa | P0 | M | US-103, US-104, US-149 |

## Escopo
- Abertura automática da análise ao entrar em `JURIDICO` (`StageLifecycleListener`): `LegalReview` com `sequence`, `enteredQueueAt` e score.
- Cálculo e recálculo da prioridade (`queuePriorityScore`, `priorityFactors`) quando mudam prazo, urgência ou valor.
- Fila na SCR-019 com filtros (situação, responsável, valor, prazo), ordenação por prioridade e fatores visíveis; só processos visíveis ao usuário (DEC-024).
- Distribuição e redistribuição (`PROCESS_ASSIGN` no escopo da unidade jurídica), com `ProcessAccess` `USER/RESPONSIBLE` para o procurador designado.
- Configuração da fila: fatores, pesos e direção (`legalReview.queueCriteria`), com pré-visualização da ordem.
- Catálogo `LEGAL_WAIVER_HYPOTHESIS`: criar, ativar e desativar hipóteses (base legal, ato da autoridade jurídica máxima, condição e valor máximo).
- Uma análise aberta por processo.

## Fora de escopo
- Condução da análise, diligência, parecer, conclusão e dispensa em si (FT-074).
- IA do parecer (FT-075).
- Distribuição automática por carga ou especialidade.
- Relatórios de produtividade da assessoria (EP-028).

## Regras de negócio da feature
- RN-LGL-01 — Ao entrar em `JURIDICO` abre-se uma `LegalReview` `PENDING`; há uma análise aberta por processo, e uma nova só nasce se o processo voltar a `JURIDICO` depois de uma análise concluída (DEC-199).
- RN-LGL-02 — A fila usa critérios objetivos configuráveis (prazo da etapa, urgência, valor estimado, data de entrada), com pesos de 0 a 100 e direção; o padrão semeado segue essa ordem (DEC-199, overview §7).
- RN-LGL-03 — A prioridade é recalculada quando mudam prazo, urgência ou valor; `priorityFactors` guarda os fatores usados, auditável (art. 53, § 1º, I) (DEC-199).
- RN-LGL-04 — Valor sigiloso participa do cálculo, mas `priorityFactors` grava só a faixa, nunca o valor (DEC-030).
- RN-LGL-05 — A fila lista só análises de processos visíveis ao usuário, dentro do escopo de `LEGAL_REVIEW_VIEW` (DEC-024).
- RN-LGL-06 — A distribuição é do chefe da assessoria (`PROCESS_ASSIGN` no escopo da unidade jurídica); o procurador designado recebe acesso de responsável ao processo (DEC-199).
- RN-LGL-07 — Segregação: quem elaborou o processo ou seus documentos não pode ser designado para analisá-lo (POL-19).
- RN-LGL-08 — Configurar critérios e hipóteses de dispensa exige `LEGAL_REVIEW_CONFIGURE` (permissão sensível); hipótese só vale com ato da autoridade jurídica máxima registrado e nenhuma vem ativa por padrão (DEC-199, overview §7).

## Telas
- SCR-019 — Jurídico: fila priorizada (`/juridico`).
- SCR-120 — Configuração da análise jurídica (`/admin/juridico`).
- SCR-013 — Caixa de tarefas.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /legal-reviews` — fila priorizada, com filtros.
- `GET /legal-reviews/{id}` — detalhe da análise e fatores de prioridade.
- `POST /legal-reviews/{id}/assign` — distribuir ou redistribuir ao procurador.
- `POST /legal-reviews/bulk-assign` — distribuir em lote.
- `GET /legal-review-settings` — critérios da fila e hipóteses de dispensa.
- `PUT /legal-review-settings/queue-criteria` — alterar critérios e pesos.
- `POST /legal-review-settings/waiver-hypotheses` — criar hipótese de dispensa.
- `PATCH /legal-review-settings/waiver-hypotheses/{id}` — editar, ativar ou desativar.

## Entidades
- `LegalReview` — `status`, `queuePriorityScore`, `priorityFactors`, `assigneeId`, `enteredQueueAt`.
- `CatalogItem` (`LEGAL_WAIVER_HYPOTHESIS`) — hipóteses.
- `TenantSetting` (`legalReview.queueCriteria`).
- `ProcessAssignment` e `ProcessAccess` — designação e acesso do procurador.

## Eventos
- `LegalReviewOpened` — entrada em `JURIDICO` (timeline, notificação à unidade jurídica, regras).
- `LegalReviewAssigned` — distribuição (timeline e notificação ao procurador).
- `ProcessAssigned` — responsabilidade atribuída (MVP 1).

## Permissões
- `LEGAL_REVIEW_VIEW` — fila e painel.
- `PROCESS_ASSIGN` — distribuição, no escopo da unidade jurídica.
- `LEGAL_REVIEW_CONFIGURE` — critérios e hipóteses de dispensa.

## Dependências
- EP-021 — versão 2 do workflow com a etapa `JURIDICO` (DEC-196).
- US-047 (encaminhar), US-050 (atribuir), US-103 e US-104 (configurações e matriz de perfis), US-097 (autorização).
- Catálogo `LEGAL_WAIVER_HYPOTHESIS` e modelos de hipótese do overview §7.

## Critérios de aceite da feature
```gherkin
Feature: Fila jurídica priorizada
  Scenario: Do encaminhamento à distribuição
    Given que o tenant usa os critérios padrão da fila e "Dra. Lúcia" é chefe da assessoria jurídica
    When o processo "0045/2026", urgente e de maior valor, entrar na etapa "JURIDICO"
    Then deve existir uma análise "PENDING" no topo da fila da SCR-019 com os fatores de prioridade visíveis
    When "Dra. Lúcia" designar o procurador "Dr. André"
    Then "Dr. André" deve receber a notificação e passar a ter acesso de responsável ao processo
    And o requisitante do processo não deve poder ser designado para analisá-lo
    When "Admin" alterar o peso do valor estimado em "legalReview.queueCriteria"
    Then a ordem da fila deve ser recalculada e a alteração auditada
```

## Métricas de sucesso
- Fila abre em ≤ 1,5 s (p95) com 500 análises abertas.
- ≥ 95% das análises distribuídas em até 1 dia útil.
- 100% das análises com `priorityFactors` registrados.

## Riscos
- Critérios contestados por outras áreas — configuráveis, com ordem explicável e auditada.
- Prioridade vazando o valor sigiloso — `priorityFactors` só com faixa; testes de sigilo.
- Recalcular a fila inteira a cada alteração — recálculo incremental por análise.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
