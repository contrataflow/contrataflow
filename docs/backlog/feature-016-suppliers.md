---
id: FT-016
title: "Fornecedores"
epic: EP-004
mvp: 1
priority: P0
stories: [US-025]
status: Especificada
---

# FT-016 — Fornecedores

## Título
Fornecedores

## Épico
EP-004 — Pesquisa de preços

## Descrição
Cobre o cadastro único de fornecedores do tenant — CNPJ numérico ou alfanumérico (IN RFB 2.229/2024) ou CPF —, independente de processo (DEC-010), com validação de dígito verificador, deduplicação por blind index e criptografia/mascaramento de CPF. É pré-requisito de FT-017: toda fonte de pesquisa do tipo "pesquisa direta com fornecedores" referencia um cadastro deste módulo.

## Valor para o usuário e para o órgão
- Elimina redigitação e duplicidade de fornecedores entre pesquisas de preços e processos diferentes.
- Garante CPF protegido (criptografia + máscara) e CNPJ validado, inclusive no formato alfanumérico vigente desde 2026.

## Personas
- Servidor do setor de Compras / gestor de contratações (`GESTOR_CONTRATACOES`) — cadastra e mantém fornecedores.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-025 | Cadastrar e manter fornecedores | P0 | M | US-097, US-100 |

## Escopo
- CRUD de `Supplier` em tela própria (SCR-107), com `documentType` (`CNPJ`/`CPF`/`FOREIGN`) imutável após a criação.
- Validação de dígito verificador de CNPJ (numérico e alfanumérico) e de CPF; deduplicação por `documentNumberHash`.
- Busca por documento (`SUP-06`) para reaproveitar o cadastro ao registrar fontes (FT-017).
- Inativação reversível (`isActive`) e exclusão lógica somente quando sem uso.

## Fora de escopo
- Vínculo do fornecedor a uma fonte de pesquisa específica — FT-017.
- Integração com bases externas de validação (ex.: Receita Federal) — fora do MVP 1.

## Regras de negócio da feature
- RN-PRICE-14 a RN-PRICE-20 — US-025.

## Telas
- SCR-107 — Fornecedores (`/fornecedores`)

## Endpoints
- SUP-01 `GET /suppliers` — listar
- SUP-02 `POST /suppliers` — criar
- SUP-03 `GET /suppliers/{id}` — detalhe
- SUP-04 `PATCH /suppliers/{id}` — editar
- SUP-05 `DELETE /suppliers/{id}` — excluir (somente sem uso)
- SUP-06 `GET /suppliers/lookup?documentNumber=` — buscar por documento

## Entidades
- `Supplier` — dono da feature

## Eventos
- `SupplierCreated` / `SupplierUpdated`

## Permissões
- `SUPPLIER_VIEW` — consultar
- `SUPPLIER_MANAGE` — criar, editar, excluir

## Dependências
- Stories: US-097 (autorização e escopos), US-100 (dependência indicada no backlog do épico; descrição não detalhada no pacote de contexto — ver Riscos).
- Decisões: DEC-010, DEC-024, DEC-086.
- Habilitada por esta feature: US-026 (fonte de pesquisa direta referencia o fornecedor).

## Critérios de aceite da feature
```gherkin
Feature: Fornecedores
  Scenario: Cadastrar um fornecedor por CNPJ alfanumérico e reutilizá-lo numa fonte de pesquisa
    Given que não existe fornecedor com o CNPJ alfanumérico "12.ABC.345/01DE-35" no tenant
    When o usuário cadastrar o fornecedor com esse CNPJ e a razão social
    Then o fornecedor deve ficar disponível em "SUP-06" para ser referenciado por uma fonte de pesquisa (US-026)
```

## Métricas de sucesso
- 0 duplicidades de fornecedor por CNPJ/CPF no mesmo tenant.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Descrição de US-100 (dependência desta story) não constar do pacote de contexto do épico, impedindo confirmar seu efeito exato sobre o cadastro | Baixa | Baixo | Cadastro segue DEC-086 e o catálogo de erros já existente (`INVALID_CNPJ`/`INVALID_CPF`/`SUPPLIER_ALREADY_EXISTS`/`SUPPLIER_IN_USE`); revisar quando US-100 estiver detalhada |
| Campos de endereço do fornecedor assumidos iguais aos de `Organization`, sem as colunas exatas confirmadas neste pacote | Baixa | Baixo | Seguir o padrão de `Organization` até confirmação; eventual ajuste é apenas de schema, sem impacto de regra |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
