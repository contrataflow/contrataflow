---
id: FT-067
title: "Prazo das aprovações avulsas"
epic: EP-022
mvp: 2
priority: P1
stories: [US-137]
status: Especificada
---

# FT-067 — Prazo das aprovações avulsas

## Título
Prazo das aprovações avulsas

## Épico
EP-022 — Aprovação múltipla

## Descrição
Paga o débito DT-17 (DEC-209): nas submissões avulsas de documento para aprovação, `Approval.dueAt` passa a ser calculado pelo prazo configurado no `DocumentType.approvalPolicy` (`slaDays` e `slaType`, `BUSINESS` ou `CALENDAR`). O campo já existe no MVP 1 e não era usado nesse caminho; a feature o torna efetivo, sem alterar contrato de API de forma incompatível.

O prazo aparece na solicitação e na lista de aprovações, alimenta a caixa de tarefas e os alertas de atraso e vale para o conjunto da aprovação (com política múltipla, o prazo por linha só vem com o SLA do EP-030).

## Valor para o usuário e para o órgão
- Aprovações avulsas deixam de ficar sem prazo e passam a entrar nos alertas e nos indicadores de atraso.
- O administrador controla o prazo por tipo de documento sem código.
- Comportamento previsível: o mesmo cálculo de dias úteis ou corridos das etapas.

## Personas
- Solicitante — vê o prazo ao submeter o documento.
- Aprovador — vê o prazo na caixa de tarefas e na lista.
- Administrador do órgão (`ADMIN_ORGAO`) — configura `slaDays` e `slaType` no tipo de documento.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-137 ⏳ | Prazo da aprovação avulsa por tipo de documento (DT-17) | P1 | S | US-051, US-055, US-061 |

## Escopo
- Cálculo de `Approval.dueAt` na submissão avulsa quando o tipo de documento define `approvalPolicy.slaDays`.
- Exibição do prazo na solicitação, na lista e no detalhe da aprovação; uso nos alertas de atraso e na caixa de tarefas.
- Contagem de dias pelo calendário do órgão (dias úteis ou corridos conforme `slaType`).

## Fora de escopo
- Prazo por linha de aprovador por política de SLA, pausas e escalonamento — EP-030.
- Prazo das aprovações originadas em etapa de workflow (já calculado pelo prazo da etapa no MVP 1).
- Nova coluna ou novo campo em `DocumentType` (o campo existente é apenas passado a ser usado).

## Regras de negócio da feature
- RN-APV-10 — na submissão avulsa de documento cujo `DocumentType.approvalPolicy` tem `slaDays`, `Approval.dueAt` é calculado a partir da solicitação, com `slaType` `BUSINESS` ou `CALENDAR` (DEC-209, DT-17).
- RN-APV-11 — sem `slaDays` no tipo de documento, `dueAt` permanece nulo, como no MVP 1; o comportamento anterior não muda (DEC-209).
- RN-APV-12 — com política `ALL` ou `SEQUENTIAL`, `Approval.dueAt` vale para o conjunto; linha com `dueAt` próprio só existe quando uma política de SLA o define (DEC-193, DEC-205).

## Telas
- SCR-014 — Aprovações (coluna e filtro de prazo) (`/aprovacoes`)
- SCR-015 — Detalhe da aprovação (prazo exibido) (`/aprovacoes/[id]`)

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /documents/{id}/approvals` — submissão avulsa do MVP 1; a resposta passa a trazer `dueAt` calculado (aditivo)
- `GET /approvals` — lista com `dueAt` (aditivo)
- `GET /approvals/{id}` — detalhe com `dueAt` (aditivo)

## Entidades
- `Approval` — `dueAt` calculado.
- `DocumentType` — `approvalPolicy.slaDays` e `slaType` (consumidos).

## Eventos
- `ApprovalRequested` (MVP 1) — passa a carregar `dueAt` quando calculado.

## Permissões
- `APPROVAL_VIEW` — ver o prazo.
- Solicitar aprovação segue a permissão do MVP 1; configurar o prazo do tipo de documento segue a administração de tipos de documento do MVP 1.

## Dependências
- Stories: US-051 (solicitar aprovação), US-055 (prazos e calendário), US-061 (tipos de documento).
- Decisão: DEC-209 (DT-17).

## Critérios de aceite da feature
```gherkin
Feature: Prazo das aprovações avulsas
  Scenario: Submissão avulsa recebe prazo do tipo de documento
    Given um tipo de documento que exige aprovação com prazo de 5 dias úteis
    When um usuário submeter um documento desse tipo para aprovação avulsa
    Then a aprovação é criada com "dueAt" 5 dias úteis depois da solicitação
    And o prazo aparece na lista de aprovações e na caixa de tarefas do aprovador

  Scenario: Tipo sem prazo mantém o comportamento do MVP 1
    Given um tipo de documento que exige aprovação sem prazo configurado
    When um usuário submeter um documento desse tipo
    Then a aprovação é criada sem "dueAt"
```

## Métricas de sucesso
- 100% das aprovações avulsas de tipos com prazo criadas com `dueAt` calculado.
- Aprovações avulsas vencidas visíveis nos alertas e nos indicadores de atraso (EP-028), com taxa de atraso acompanhada após o piloto.

## Riscos
- Prazos que surpreendem usuários habituados à ausência de prazo — o prazo só vale onde o tipo de documento já o configura e é exibido na solicitação.
- Calendário do órgão incompleto distorcendo dias úteis — usa o mesmo calendário das etapas (US-055).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
