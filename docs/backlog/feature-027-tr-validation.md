---
id: FT-027
title: "Validação e conclusão"
epic: EP-006
mvp: 1
priority: P0
stories: [US-039]
status: Especificada
---

# FT-027 — Validação e conclusão

## Título
Validação e conclusão

## Épico
EP-006 — Termo de Referência

## Descrição
Fecha o épico: calcula a completude do TR (pendências bloqueantes do template e específicas do tipo), apresenta avisos determinísticos de consistência com o ETP de origem (quantidade por item, garantia não definida) e conclui formalmente o documento — ou o submete para aprovação avulsa, quando o tenant exigir — gerando uma nova versão e o evento `DocumentFinalized` (alias de domínio `TermCompleted`).

## Valor para o usuário e para o órgão
- Garante que nenhum TR siga incompleto para a fase de seleção do fornecedor.
- Reduz divergência entre ETP e TR que só apareceria depois, na licitação, exigindo reconhecimento explícito dos avisos antes de concluir.
- Fornece um ponto único e auditável de conclusão do documento.

## Personas
- Planejamento (`PLANEJAMENTO`), Compras (`COMPRAS`) — validam e concluem o TR.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-039 | Validar e concluir o TR | P0 | M | US-037, US-038 |

## Escopo
- Cálculo de completude (pendências bloqueantes e avisos) reaproveitando o serviço genérico de validação de documentos.
- Catálogo de códigos específicos do TR (`TR_*`) para pendências e avisos.
- Conclusão (`FINALIZED`) ou submissão para aprovação avulsa (`IN_REVIEW`), conforme a configuração do tipo.

## Fora de escopo
- Edição do conteúdo em si (seções, itens, condições) — tratada em FT-024/FT-025/FT-026.
- Aprovação formal de etapa do workflow sobre o TR já concluído — ciclo genérico de `Approval` (US-051), fora desta feature.
- Análise assistida por IA das divergências — MVP 5 (DEC-019).

## Regras de negócio da feature
- A completude agrega violações genéricas do template com as específicas do TR, pelo mesmo serviço do indicador do editor (RN-TR-34).
- Pendências bloqueantes (sem valor estimado, sem itens, sem critério de julgamento, sem tipo de adjudicação) impedem concluir (RN-TR-35).
- Avisos de consistência com o ETP — quantidade por item divergente, garantia não definida — não bloqueiam, mas exigem reconhecimento explícito (RN-TR-36).
- Concluir cria nova versão e gera `DocumentFinalized`/`TermCompleted`; bloqueia nova edição até reabertura (RN-TR-37).
- Quando o tipo exigir aprovação avulsa, a ação equivalente é submeter, levando o documento a `IN_REVIEW` (RN-TR-38).

## Telas
- SCR-012 — TR (editor), painel "Completude do TR" (`/processos/[id]/tr/[termId]`)

## Endpoints
- `DOC-08` `GET /documents/{id}/validation` — pendências e avisos.
- `DOC-10` `POST /documents/{id}/finalize` — conclusão (fluxo padrão).
- `DOC-09` `POST /documents/{id}/submit` — submissão (tipos com aprovação avulsa).

## Entidades
- `Document` / `DocumentVersion` — transição de status e nova versão (dono do módulo `document`).
- `TermOfReference`, `DocumentItem` — consumidas pelo validador específico do TR.

## Eventos
- `DocumentFinalized` (alias `TermCompleted`) — na conclusão.
- `DocumentVersionCreated` — mesma transação.
- `DocumentSubmitted` — na submissão (tipos com aprovação avulsa).

## Permissões
- `TERM_SUBMIT` — concluir ou submeter o TR (POL-01/POL-02).

## Dependências
- **Stories:** US-037 (dados importados, base dos avisos), US-038 (itens e condições, base das pendências). Indireta: US-065 (ciclo de vida genérico).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-019, DEC-030, DEC-032, DEC-104, DEC-105, DEC-161.
- **Features:** depende de FT-024, FT-025 e FT-026; fecha o épico EP-006.

## Critérios de aceite da feature
```gherkin
Feature: Validação e conclusão
  Scenario: Concluir o TR após resolver pendências e reconhecer avisos
    Given que o TR tem uma pendência bloqueante e um aviso de divergência com o ETP
    When "Carla" resolver a pendência e reconhecer o aviso
    And "Carla" concluir o TR
    Then o documento deve mudar para "FINALIZED"
    And deve gerar o evento "DocumentFinalized"
```

## Métricas de sucesso
- 0 TRs concluídos com pendência bloqueante (garantido pela API, não só pela interface).
- ≥ 90% dos avisos de divergência com o ETP reconhecidos explicitamente antes da conclusão (não ignorados silenciosamente).

## Riscos
- Concluir com divergência não percebida entre ETP e TR — mitigado pelo aviso obrigatoriamente reconhecido (RN-TR-36).
- Revalidação de completude ficar dessincronizada da tela por edição concorrente — mitigado pela revalidação atômica na própria transação de conclusão.

## Definition of Done da feature
- [ ] US-039 concluída e aceita (critérios de aceite Gherkin passando)
- [ ] Catálogo de códigos `TR_*` documentado e testado
- [ ] Jornada E2E "pendência → resolução → aviso → reconhecimento → conclusão" automatizada
- [ ] Documentação (este card e story-039) atualizada
