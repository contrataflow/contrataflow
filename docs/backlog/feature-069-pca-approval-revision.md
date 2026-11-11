---
id: FT-069
title: "Aprovação e revisão do PCA"
epic: EP-023
mvp: 2
priority: P1
stories: [US-140, US-141]
status: Especificada
---

# FT-069 — Aprovação e revisão do PCA

## Título
Aprovação e revisão do PCA

## Épico
EP-023 — PCA

## Descrição
O planejamento envia o plano em `DRAFT` para a autoridade competente, que decide pelo fluxo de aprovações já existente com o novo assunto `PCA` (`ApprovalSubjectType`, `Approval.processId` nulo e `Approval.pcaId` preenchido). Aprovado, o plano fica `APPROVED` e vigente; devolvido ou rejeitado, volta a `DRAFT` com o motivo (US-140).

Depois de aprovado o plano não aceita alteração de itens. Para mudar, o planejamento cria uma revisão: nova versão em `DRAFT`, copiada do plano vigente (`previousItemId`), com motivo obrigatório. Ao aprovar a revisão, a versão anterior vira `SUPERSEDED` e o histórico fica preservado (US-141). A aprovação de uma revisão dispara a reconciliação com `trigger = REVISION`, que reaponta os vínculos (FT-070).

## Valor para o usuário e para o órgão
- O plano ganha ato formal de aprovação, com autoria, data e histórico de versões.
- Mudanças no plano durante o exercício ficam rastreáveis, sem apagar o que foi aprovado antes.
- A autoridade decide na mesma tela de aprovações que já usa.

## Personas
- Planejamento (`PLANEJAMENTO`) — envia, retira e cria revisões.
- Autoridade competente (`AUTORIDADE_COMPETENTE`) — aprova, devolve ou rejeita.
- Auditor (`AUDITOR`) e controle interno (`CONTROLE_INTERNO`) — consultam versões e decisões.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-140 | Enviar o PCA para aprovação e decidir | P1 | M | US-051, US-052, US-138 |
| US-141 | Revisar o PCA aprovado com nova versão | P1 | M | US-140 |

## Escopo
- Envio do plano (exige ao menos um item e nenhum item com dado obrigatório faltando) e retirada da aprovação.
- Aprovação de assunto `PCA` com o `ApprovalSubjectHandler` do módulo `pca`; decisão `APPROVE`, `RETURN` ou `REJECT` com comentário, pela API de aprovações existente.
- Bloqueio de edição de itens em plano `AWAITING_APPROVAL`, `APPROVED` e `SUPERSEDED`.
- Criação de revisão com motivo (>= 20 caracteres), cópia dos itens e vínculo `previousVersionId`.
- Aprovação da revisão: anterior `SUPERSEDED` e nova vigente; comparação entre versões na SCR-018.
- Aprovações de assunto `PCA` visíveis na SCR-014 e na SCR-015.

## Fora de escopo
- Aprovação múltipla ou sequencial para o PCA além da política já configurada na etapa de aprovação (EP-022).
- Vínculo com DFD e reconciliação (FT-070); acompanhamento e exportação (FT-071).
- Alterar situação de item (`POSTPONED`, `CANCELED`) no acompanhamento: previsto em FT-071 por `PCA_MANAGE`.

## Regras de negócio da feature
- RN-PCA-09 — A aprovação do PCA é feita pela autoridade competente por `Approval` de assunto `PCA`, com `processId` nulo; só há uma aprovação `PENDING` por plano (DEC-197).
- RN-PCA-10 — Enviar exige `PCA_SUBMIT`, escopo `ORGANIZATION` ou `TENANT`, ao menos um item e nenhum item com dado obrigatório faltando (DEC-197).
- RN-PCA-11 — Decisão `RETURN` ou `REJECT`, ou retirada, devolve o plano a `DRAFT` com o comentário registrado; `APPROVE` define `approvedAt` e `approvedById` (DEC-197).
- RN-PCA-12 — Plano `APPROVED` ou `SUPERSEDED` não aceita alteração de itens; a mudança só ocorre por nova versão (DEC-197).
- RN-PCA-13 — A revisão nasce em `DRAFT` com cópia dos itens e motivo obrigatório; a versão `APPROVED` segue vigente até a aprovação da revisão. Há uma versão vigente e uma em elaboração por exercício (DEC-197).
- RN-PCA-14 — O aprovador vem da cobertura da `AUTORIDADE_COMPETENTE` com `APPROVAL_DECIDE`, por designação na `Approval` de assunto `PCA` (POL-22; DEC-022, DEC-197).

## Telas
- SCR-018 — PCA: envio, versões e comparação (`/pca/[pcaId]`).
- SCR-014 — Aprovações e SCR-015 — Detalhe da aprovação.
- SCR-036 — Notificações.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /pca/{id}/submit` — enviar o plano para aprovação.
- `POST /pca/{id}/withdraw` — retirar da aprovação.
- `POST /pca/{id}/revisions` — criar revisão do plano aprovado.
- `GET /pca/{id}/versions` — listar versões do plano do exercício.
- `GET /pca/{id}/versions/compare?from=&to=` — comparar duas versões.
- Endpoints do MVP 1 estendidos: `GET /approvals/{id}` (APV-02) e `POST /approvals/{id}/decide` (APV-03) passam a aceitar o assunto `PCA`.

## Entidades
- `Pca` — status `DRAFT`, `AWAITING_APPROVAL`, `APPROVED`, `SUPERSEDED`; `revisionReason`, `previousVersionId`, `approvalId`.
- `PcaItem` — itens copiados com `previousItemId`.
- `Approval` — `subjectType = PCA`, `pcaId`.

## Eventos
- `PcaStatusChanged` (`pca.status_changed.<status>`) — envio, decisão, retirada e substituição; `PcaApproved` é a especialização.
- `PcaRevisionCreated` — criação da revisão.
- `ApprovalRequested`, `ApprovalCompleted`, `ApprovalReturned`, `ApprovalRejected` — do módulo `approval`, com `processId` nulo no envelope.

## Permissões
- `PCA_SUBMIT` — enviar e retirar (POL-22).
- `PCA_MANAGE` — criar revisão e editar a versão em `DRAFT`.
- `APPROVAL_DECIDE` — decidir (autoridade, por designação).
- `PCA_VIEW` — consultar versões.

## Dependências
- FT-068 (plano e itens) e US-051/US-052 (aprovação do MVP 1).
- Política de aprovação de EP-022 (`ApprovalApprover`), se o órgão a configurar para o PCA.

## Critérios de aceite da feature
```gherkin
Feature: Aprovação e revisão do PCA
  Scenario: Aprovar o plano e revisá-lo durante o exercício
    Given que o plano "PCA 2027" está em "DRAFT" com 116 itens
    When "Helena" enviar o plano para aprovação
    And o secretário "Paulo", com cobertura de autoridade competente, aprovar a solicitação
    Then o plano deve estar "APPROVED" com data e aprovador registrados
    And nenhum item do plano deve aceitar alteração
    When "Helena" criar uma revisão informando o motivo e alterar o valor de um item
    And "Paulo" aprovar a revisão
    Then a versão 2 deve estar "APPROVED" e a versão 1 "SUPERSEDED"
    And o histórico das duas versões deve permanecer consultável e comparável
```

## Métricas de sucesso
- Tempo do envio à decisão ≤ 5 dias úteis (mediana).
- 100% das mudanças em plano aprovado feitas por revisão, sem edição direta.
- Revisões aprovadas com a versão anterior preservada: 100%.

## Riscos
- Revisão aprovada desalinha vínculos já feitos — reconciliação com `trigger = REVISION` reaponta por `code` (FT-070).
- Plano devolvido várias vezes — comentário obrigatório na decisão e histórico de decisões na SCR-018.
- Aprovador sem cobertura configurada — erro claro no envio e orientação ao administrador, como nas demais aprovações.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
