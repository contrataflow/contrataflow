---
id: FT-022
title: "Tratamento"
epic: EP-005
mvp: 1
priority: P0
stories: [US-034]
status: Especificada
---

# FT-022 — Tratamento

## Título
Tratamento de riscos

## Épico
EP-005 — Mapa de riscos

## Descrição
Entrega o cadastro e o acompanhamento das ações de tratamento (prevenção e contingência) vinculadas a cada risco identificado (FT-021). Cada ação tem tipo, responsável, prazo e status próprio; o cadastro da primeira ação ativa move o risco de "Aberto" para "Em tratamento", dando visibilidade do andamento sem depender de controles externos ao processo.

## Valor para o usuário e para o órgão
- Conecta formalmente cada risco à ação concreta que o mitiga, com responsável e prazo rastreáveis no processo.
- Sustenta a exigência de completude do Mapa de Riscos (FT-023): riscos de nível Alto/Extremo só podem ser formalizados com tratamento registrado.
- Reduz o risco de "ficha de risco esquecida" ao destacar visualmente prazos vencidos.

## Personas
- Gestor de contratações (`GESTOR_CONTRATACOES`) — cadastra e acompanha ações de tratamento.
- Planejamento (`PLANEJAMENTO`) — pode ser responsável por ações específicas.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-034 | Gerenciar ações de tratamento de riscos | P0 | M | US-033 |

## Escopo
- Cadastro de `RiskTreatment` por risco: tipo (`PREVENTIVE`/`CONTINGENCY`), descrição, responsável (usuário ou unidade), prazo, status e observações.
- Máquina de estados do tratamento (`PLANNED` → `IN_PROGRESS` → `DONE`, ou `CANCELED`), com preenchimento automático de `completedAt`.
- Transição automática do risco para `IN_TREATMENT` ao receber a primeira ação ativa.
- Edição e exclusão lógica de ações, respeitando o mesmo bloqueio de editabilidade do risco (Mapa de Riscos finalizado).

## Fora de escopo
- Registro e avaliação do risco em si — FT-021.
- Notificações automáticas de prazo vencido (apenas destaque visual nesta feature) e emissão do Mapa de Riscos — FT-023.

## Regras de negócio da feature
- RN-RISK-11 a RN-RISK-17 (ver US-034): obrigatoriedade de campos, preenchimento de `completedAt`, transições de status permitidas, propagação do status do risco e condição de editabilidade.

## Telas
- SCR-011 — Riscos (mapa de riscos) (`/processos/[id]/riscos`), painel expandido do risco

## Endpoints
- RSK-06 `POST /risks/{id}/treatments` — criar ação de tratamento
- RSK-07 `PATCH /risk-treatments/{treatmentId}` — editar/mudar status
- RSK-08 `DELETE /risk-treatments/{treatmentId}` — excluir ação
- RSK-03 `GET /risks/{id}` — detalhar risco com seus tratamentos (leitura de apoio)

## Entidades
- `RiskTreatment` — dono da feature.
- `Risk` (consumida) — recebe a transição automática de status.

## Eventos
- `RiskTreatmentChanged` — criação, edição, mudança de status ou exclusão de uma ação de tratamento.

## Permissões
- `RISK_MANAGE` — criar, editar e excluir ações de tratamento.

## Dependências
- Stories: US-033 (o risco precisa existir).
- Decisões: DEC-021, DEC-024.

## Critérios de aceite da feature
```gherkin
Feature: Tratamento de riscos
  Scenario: Cadastrar a primeira ação de tratamento de um risco aberto
    Given que o risco "R01" está com status "OPEN"
    When o usuário cadastrar uma ação de tratamento "PREVENTIVE" para "R01"
    Then o risco "R01" deve passar para o status "IN_TREATMENT"
    When o usuário concluir a ação mudando o status para "DONE"
    Then o campo "completedAt" da ação deve ser preenchido automaticamente
```

## Métricas de sucesso
- 100% dos riscos de nível Alto/Extremo com ao menos uma ação de tratamento ativa antes da finalização do Mapa de Riscos.
- % de ações de tratamento concluídas dentro do prazo (`dueDate`).

## Riscos
- Cancelar/excluir a única ação ativa não reverter automaticamente o status do risco pode deixar o risco "Em tratamento" sem ação pendente — mitigado por ajuste manual explícito (RN-RISK-14) e por destaque na listagem.

## Definition of Done da feature
- [ ] US-034 concluída e aceita
- [ ] Jornada E2E de cadastrar, avançar e concluir uma ação de tratamento automatizada
- [ ] Documentação (este card e fontes canônicas) atualizada
