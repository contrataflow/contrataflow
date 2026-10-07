---
id: FT-009
title: "Conclusão e decisão do DFD"
epic: EP-002
mvp: 1
priority: P0
stories: [US-016, US-017]
status: Especificada
---

# FT-009 — Conclusão e decisão do DFD

## Título
Conclusão e decisão do DFD

## Épico
EP-002 — DFD — Documento de Formalização da Demanda

## Descrição
Esta feature entrega o fechamento do ciclo do DFD: a conclusão com envio para aprovação ou finalização direta, em um único passo que encaminha o processo e submete o documento (US-016); e o tratamento dos efeitos da decisão do titular — a aprovação propaga valor estimado, quantidade de referência, situação no PCA e prioridade ao processo, enquanto a devolução e o indeferimento deixam o DFD e o processo no estado certo para reabertura (US-017).

## Valor para o usuário e para o órgão
- A requisitante formaliza a demanda sem precisar entender a mecânica de tramitação.
- O titular decide exatamente sobre a versão que a requisitante revisou.
- O processo recebe automaticamente os dados que fundamentam o restante do planejamento, sem reentrada manual.

## Personas
- Área requisitante (`REQUISITANTE`) — conclui e, se devolvido/indeferido, reabre.
- Titular da secretaria (`DEPARTMENT_HEAD`) — decide a aprovação.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-016 | Revisar, concluir e enviar o DFD para aprovação | P0 | M | US-015, US-047, US-051 |
| US-017 | Tratar decisão sobre o DFD e propagar dados ao processo | P0 | M | US-016, US-052 |

## Escopo
- Passo 5 do wizard (Conclusão): "Concluir e enviar para aprovação" (PRC-19) e "Finalizar DFD" (DOC-10).
- Efeitos de `APPROVED`/`RETURNED`/`REJECTED` sobre `Dfd`, `Process` e `ProcessItem`; reabertura (DOC-12).

## Fora de escopo
- A decisão em si — criar e decidir a `Approval` (US-051/US-052, de outro épico).
- Duplicação do DFD (FT-010).

## Regras de negócio da feature
- A conclusão sempre revalida a completude no servidor, dentro da transação (RN-DFD-37).
- A entrada em etapa de aprovação submete o DFD automaticamente (DEC-018, RN-DFD-39).
- O efeito da decisão é síncrono, na mesma transação da decisão (RN-DFD-62); `APPROVED` propaga respeitando a precedência de valor (DEC-032, RN-DFD-63); `REJECTED` sugere cancelamento sem automatizá-lo (RN-DFD-68, PEND-02).

## Telas
- SCR-007 — DFD (passo Conclusão e banner de decisão)
- SCR-103 — Encaminhar processo (painel lateral)
- SCR-006 — Painel do processo (reflete status e dados propagados)

## Endpoints
- PRC-19 `POST /processes/{id}/forward` — concluir e encaminhar
- DOC-09/DOC-10 — submeter/finalizar o documento
- DOC-12 `POST /documents/{id}/reopen` — reabrir após devolução/indeferimento
- DFD-03 `GET /dfds/{id}` — estado do DFD após a decisão

## Entidades
- `Dfd`, `Document`, `DocumentVersion` — ciclo de vida (DEC-018)
- `Process`, `ProcessItem` — recebem os dados propagados
- `Approval` — decisão (consumida; dono em outro épico)

## Eventos
- `DocumentSubmitted`, `DocumentFinalized`, `ApprovalRequested` — na conclusão (US-016)
- `DFDApproved` (`DocumentApproved`), `DocumentReturned`, `DocumentRejected`, `ProcessStatusChanged`, `ProcessItemsChanged` — na decisão (US-017)

## Permissões
- `PROCESS_FORWARD` — encaminhar para aprovação
- `DFD_SUBMIT` — concluir/finalizar o DFD
- `DOCUMENT_REOPEN` — reabrir após devolução/indeferimento

## Dependências
- US-047 (encaminhar processo), US-051/US-052 (solicitar e decidir aprovação, outro épico), US-065/US-066/US-067 (ciclo de vida, versões, PDF), US-006 (`ProcessItem`).

## Critérios de aceite da feature
```gherkin
Feature: Conclusão e decisão do DFD
  Scenario: Concluir, aprovar e ver os dados propagados no processo
    Given que a requisitante concluiu e enviou o DFD para aprovação
    When o titular aprovar o DFD
    Then o processo deve avançar de etapa
    And o valor estimado, a quantidade dos itens, o PCA e a prioridade do processo devem refletir o DFD aprovado
```

## Métricas de sucesso
- % de DFDs aprovados sem devolução > 70%.
- 100% das aprovações propagam os dados corretamente (0 inconsistência em auditoria).

## Riscos
- Regra de precedência de valor/prioridade mal aplicada — mitigado por testes de integração dedicados (US-017).

## Definition of Done da feature
- [ ] US-016 e US-017 concluídas e aceitas
- [ ] Jornadas E2E "concluir → aprovar → ver propagação" e "concluir → rejeitar → reabrir" automatizadas
- [ ] Documentação da tramitação e da propagação atualizada
