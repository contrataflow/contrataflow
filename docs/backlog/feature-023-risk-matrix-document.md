---
id: FT-023
title: "Matriz e documento"
epic: EP-005
mvp: 1
priority: P1
stories: [US-035]
status: Especificada
---

# FT-023 — Matriz e documento

## Título
Matriz de riscos e documento Mapa de Riscos

## Épico
EP-005 — Mapa de riscos

## Descrição
Entrega a visão consolidada dos riscos do processo em uma matriz de calor (probabilidade × impacto) e a emissão do documento formal **Mapa de Riscos** (`RISK_MAP`), que formaliza o trabalho feito em FT-021/FT-022 como artefato de instrução do processo. Reaproveita o ciclo de vida genérico de documentos (criar, validar completude, finalizar/submeter, reabrir) e bloqueia a edição de riscos e tratamentos enquanto o documento estiver concluído.

## Valor para o usuário e para o órgão
- Dá visibilidade executiva imediata da exposição a risco do processo, sem precisar abrir cada risco individualmente.
- Formaliza a gestão de riscos exigida pela Lei 14.133/2021 em um documento versionado e auditável, pronto para instruir o processo.
- Garante, por validação automática, que riscos relevantes (Alto/Extremo) não sejam esquecidos sem tratamento antes da formalização.

## Personas
- Gestor de contratações (`GESTOR_CONTRATACOES`) — consulta a matriz e emite o documento.
- Autoridade/aprovador — aprova o Mapa de Riscos quando a etapa do workflow exigir.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-035 | Visualizar matriz de riscos e emitir o Mapa de Riscos | P1 | M | US-034, US-065, US-110 |

## Escopo
- Matriz de calor (grade probabilidade × impacto) agregando os riscos vigentes do processo, com filtros por fase, categoria e status.
- Criação do documento `RISK_MAP` (singleton por processo) a partir dos riscos/tratamentos vigentes.
- Validação de completude (sem riscos; risco Alto/Extremo sem tratamento) antes de finalizar/submeter.
- Finalização ou submissão à aprovação (conforme a etapa do workflow) e reabertura, reaproveitando o ciclo de vida genérico de documentos.
- Bloqueio de edição de riscos/tratamentos entre a finalização e a reabertura do documento.

## Fora de escopo
- Registro/avaliação de riscos — FT-021. Cadastro de ações de tratamento — FT-022.
- Definição do template do tipo `RISK_MAP` (biblioteca de templates — US-110, outro épico) e renderização/assinatura em PDF (US-067, outro épico).

## Regras de negócio da feature
- RN-RISK-18 a RN-RISK-24 (ver US-035): agregação da matriz pela escala vigente, singleton do documento, snapshot imutável na versão, completude bloqueante, finalizar vs. submeter (DEC-018), bloqueio pós-finalização e disponibilidade da matriz em qualquer status do documento.

## Telas
- SCR-011 — Riscos (mapa de riscos) (`/processos/[id]/riscos`), aba "Matriz"; tela genérica de documento para o Mapa de Riscos

## Endpoints
- RSK-09 `GET /processes/{id}/risk-matrix` — matriz agregada
- RSK-10 `POST /processes/{id}/risk-map` — criar o documento Mapa de Riscos
- DOC-08 `GET /documents/{id}/validation` — completude (reaproveitado)
- DOC-09 `POST /documents/{id}/submit` — submeter à aprovação (reaproveitado)
- DOC-10 `POST /documents/{id}/finalize` — finalizar (reaproveitado)
- DOC-12 `POST /documents/{id}/reopen` — reabrir (reaproveitado)

## Entidades
- `Document` (`RISK_MAP`) — cabeçalho e ciclo de vida do documento (consumida, dono é o módulo `document`).
- `Risk`/`RiskTreatment` (consumidas) — conteúdo típado agregado na matriz e no snapshot da versão.

## Eventos
- `DocumentCreated`, `DocumentVersionCreated`, `DocumentSubmitted`, `DocumentFinalized`, `DocumentReopened` — instâncias do tipo `RISK_MAP`.

## Permissões
- `RISK_MANAGE` — criar o documento Mapa de Riscos.
- `RISK_MAP_SUBMIT` — finalizar/submeter o Mapa de Riscos.

## Dependências
- Stories: US-034 (tratamentos sustentam a completude), US-065 (ciclo de vida genérico de documento), US-110 (template padrão do tipo `RISK_MAP`).
- Decisões: DEC-017, DEC-018, DEC-021, DEC-024.

## Critérios de aceite da feature
```gherkin
Feature: Matriz de riscos e documento Mapa de Riscos
  Scenario: Emitir o Mapa de Riscos após tratar os riscos relevantes
    Given que todos os riscos de nível "HIGH" ou "EXTREME" do processo têm tratamento ativo
    When o usuário visualizar a matriz e emitir o Mapa de Riscos
    Then o documento deve ser criado e finalizado com sucesso
    And a versão do documento deve conter o snapshot dos riscos e tratamentos vigentes
    And os riscos do processo devem ficar bloqueados para edição até a reabertura do documento
```

## Métricas de sucesso
- % de processos com Mapa de Riscos finalizado antes do encaminhamento à fase de seleção ≥ 80%.
- 0 finalizações bem-sucedidas com risco Alto/Extremo sem tratamento (bloqueio de completude efetivo em 100% dos casos).

## Riscos
- Usuários tentarem editar riscos após a finalização e não entenderem o bloqueio — mitigado por mensagem explícita com link para reabrir o documento (RN-RISK-23).

## Definition of Done da feature
- [ ] US-035 concluída e aceita
- [ ] Jornada E2E de visualizar a matriz, emitir, finalizar e reabrir o Mapa de Riscos automatizada
- [ ] Documentação (este card e fontes canônicas) atualizada
