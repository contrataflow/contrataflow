---
id: FT-014
title: "Validação e conclusão do ETP"
epic: EP-003
mvp: 1
priority: P0
stories: [US-023]
status: Especificada
---

# FT-014 — Validação e conclusão do ETP

## Título
Validação e conclusão do ETP

## Épico
EP-003 — Estudo Técnico Preliminar (ETP)

## Descrição
Valida a completude do ETP conforme a configuração semeada do template (art. 18) e as regras próprias do tipo — conclusão, parcelamento, alternativa recomendada, itens e valor —, e permite finalizá-lo quando não houver pendência bloqueante. É o encerramento do épico: a partir da conclusão, o ETP segue para a aprovação formal (EP-008) e pode alimentar o Termo de Referência (EP-006).

## Valor para o usuário e para o órgão
- Impede que um ETP incompleto siga para aprovação, reduzindo devoluções e retrabalho.
- Torna explícita e auditável a conclusão pela não viabilidade da contratação.

## Personas
- Redator do ETP (`REQUISITANTE`/`PLANEJAMENTO`) — resolve pendências e conclui.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha pendências.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-023 | Validar completude do ETP e concluí-lo | P0 | M | US-020, US-021, US-022 |

## Escopo
- Definição de `conclusion` (viável/não viável) e `parcelingDecision`.
- Validação de completude: seções (configuração semeada), conclusão, parcelamento, alternativa recomendada quando viável, itens e valor.
- Aviso (não bloqueante, com reconhecimento obrigatório) quando a conclusão é "não viável".
- Finalização do documento (`FINALIZED`), com versão imutável.

## Fora de escopo
- Aprovação formal do ETP finalizado — EP-008 (US-051/US-052).
- Reabertura de um ETP já finalizado/aprovado — US-065 (genérico de documentos).

## Regras de negócio da feature
- RN-ETP-33 a RN-ETP-40 (completude configurável, regras específicas `ETP_*`, aviso de não viabilidade, finalização e bloqueio de edição) — US-023.

## Telas
- SCR-008 — ETP (editor por seções), painel de pendências (`/processos/[id]/etp/[etpId]`)

## Endpoints
- ETP-03 `GET /etps/{id}` — leitura de conclusão/parcelamento
- ETP-04 `PATCH /etps/{id}` — definir conclusão/parcelamento
- DOC-08 `GET /documents/{id}/validation` — pendências (`violations[]`)
- DOC-10 `POST /documents/{id}/finalize` — concluir o ETP

## Entidades
- `Etp` — `conclusion`, `parcelingDecision`
- `Document`/`DocumentVersion` — status `FINALIZED` e versão criada (EP-011)

## Eventos
- `DocumentFinalized`, `DocumentVersionCreated` — ao concluir (US-023)

## Permissões
- `ETP_UPDATE` — definir conclusão/parcelamento
- `ETP_SUBMIT` — concluir (finalizar)

## Dependências
- Stories: US-020 (seções), US-021 (alternativa recomendada), US-022 (itens e valor). Habilitadas por esta feature: US-051/US-052 (aprovação formal), US-037 (importação do ETP para o TR).
- Decisões: DEC-016, DEC-017, DEC-018, DEC-056; POL-02, POL-09, POL-11.

## Critérios de aceite da feature
```gherkin
Feature: Validação e conclusão do ETP
  Scenario: Concluir um ETP viável sem pendências bloqueantes
    Given que o ETP tem todas as seções obrigatórias preenchidas, uma alternativa recomendada, itens com quantidade e valor estimado
    When o usuário definir a conclusão como "VIABLE" e clicar em "Concluir ETP"
    Then o ETP deve mudar para o status "FINALIZED" com uma nova versão
    And deve gerar o evento "DocumentFinalized"
```

## Métricas de sucesso
- 0 ETPs finalizados com pendência bloqueante (garantido pela revalidação atômica no servidor).
- ≤ 10% dos ETPs concluídos como "não viável" sem justificativa clara na seção `CONCLUSION` (acompanhamento qualitativo).

## Riscos
- Equipe reconhecer avisos "no automático" sem avaliar a não viabilidade — mitigado por exigir reconhecimento explícito por aviso, nunca em lote silencioso.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
