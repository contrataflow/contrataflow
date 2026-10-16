# MVP 1 — Definition of Done, Itens Postergados e Checklist de Release

> Critérios para considerar cards, épicos e o MVP 1 concluídos, e o checklist de liberação para produção dos pilotos.
> Plano: [delivery-plan.md](delivery-plan.md) · Riscos: [risks-and-decisions.md](risks-and-decisions.md) · Testes: [tests.md](tests.md).

---

## 1. Definition of Done

### 1.1 Card (story)
- [ ] Critérios de aceite (Gherkin) automatizados — API e, quando houver tela, E2E — e passando no CI.
- [ ] Todas as 8 categorias de cenário cobertas (sucesso, validação, permissão, tenant incorreto, duplicidade, concorrência, falha de banco, falha de integração).
- [ ] Permissões e políticas (POL) aplicadas na API; UI oculta/desabilita conforme permissions.md §9.
- [ ] Teste de isolamento incluído na suíte "tenant leak"; RLS validada para novas tabelas.
- [ ] Auditoria (ações de events.md §7) e eventos (events.md §4) verificados em teste; timeline quando aplicável.
- [ ] OpenAPI gerado compatível com api.md (sem quebra de contrato não planejada).
- [ ] Migrações reversíveis (expand/contract) e revisadas; índices conferidos com `EXPLAIN` para consultas novas.
- [ ] Logs estruturados sem dados sensíveis; métricas e spans relevantes presentes.
- [ ] Acessibilidade: axe sem violações sérias/críticas; navegação por teclado; textos revisados (UX writing pt-BR).
- [ ] Responsividade verificada em 360 px, 768 px e 1280 px.
- [ ] Revisão de código aprovada por 2 pessoas (1 de outro módulo quando houver fachada nova) e checklist de segurança do card ([security.md](../architecture/security.md)).
- [ ] Cobertura mínima do código novo: 80% em `domain`/`application`; 100% das regras de cálculo e políticas.
- [ ] Card, fontes canônicas e guia do usuário atualizados; lacunas registradas resolvidas ou levadas a [risks-and-decisions.md](risks-and-decisions.md).
- [ ] Demonstrado ao PO em ambiente de staging com dados sintéticos.

### 1.2 Feature / épico
- [ ] Todas as stories P0 e P1 concluídas; P2 explicitamente postergadas ou concluídas.
- [ ] Jornada E2E da feature/épico automatizada.
- [ ] KPIs do épico instrumentados (eventos de produto/métricas).
- [ ] Guia do usuário e notas de versão do épico escritos.

### 1.3 MVP 1
- [ ] 100% das stories P0 e P1 concluídas (DoD de card).
- [ ] Jornadas E2E J-01 a J-11 de [tests.md](tests.md) passando em staging.
- [ ] Suíte "tenant leak" 100% verde; matriz RBAC 100% verde.
- [ ] Testes de carga atendendo às metas (SLOs de observability.md §1: leituras/listas p95 ≤ 500 ms e lista com 100 mil processos p95 < 800 ms; painel situacional ≤ 800 ms; comandos ≤ 1 s; PDF p95 < 30 s; lag do outbox p95 < 5 s).
- [ ] Pentest externo concluído sem achados críticos/altos abertos; ZAP baseline limpo.
- [ ] Zero defeitos críticos/altos abertos; defeitos médios com plano aceito pelo PO.
- [ ] UAT assinado pelo cliente-piloto (jornadas J-01..J-10: planejamento da contratação completo).
- [ ] Observabilidade em produção: dashboards, alertas e runbooks ativos (observability.md).
- [ ] Backup e restauração testados (RPO/RTO de architecture.md) e plano de rollback ensaiado.
- [ ] Documentação de operação (runbooks), suporte (FAQ, matriz de escalonamento) e treinamento prontos.

## 2. Itens postergados

Consolidado em [delivery-plan.md §9](delivery-plan.md#9-itens-postergados). Resumo:

| Categoria | Itens |
|---|---|
| Stories P2 do MVP 1 | US-003, US-007, US-018, US-028, US-046, US-058, US-070, US-113 |
| Para o MVP 2 | Migração de processos entre versões de workflow; etapas paralelas; múltiplos aprovadores; backoffice de plataforma; login gov.br; PCA, dotação, jurídico, controle interno, edital, SLA avançado, indicadores |
| Para o MVP 3 | Publicações (PNCP, Diário Oficial), status `PUBLISHED`, assinatura eletrônica, PDF/A, API pública, webhooks, catálogos externos |
| Para o MVP 4 | Contratos, fiscalização, medições, ocorrências, aditivos, vencimentos |
| Para o MVP 5 | Assistente de IA, validação automática por IA, busca semântica, benchmark de preços, previsão de atraso |
| Débitos técnicos | DT-01 a DT-12 ([risks-and-decisions.md §6](risks-and-decisions.md#6-débitos-técnicos-assumidos)) |

## 3. Checklist de release

### 3.1 Produto e negócio
- [ ] Escopo do release congelado e comunicado (P0 + P1; postergados listados).
- [ ] Decisões pendentes com padrão adotado formalmente aceitas pelo PO (PEND-xx).
- [ ] Notas de versão em linguagem de usuário (pt-BR).
- [ ] Guia do usuário por persona (requisitante, compras, planejamento, autoridade, administrador) e vídeos curtos dos fluxos principais.
- [ ] Termos de uso, política de privacidade e contrato de tratamento de dados (LGPD — controlador × operador) revisados pelo jurídico.
- [ ] Aviso explícito sobre ausência de assinatura eletrônica no MVP 1 e orientação de uso (RL-02).
- [ ] Biblioteca de templates padrão revisada por consultoria jurídica em contratações públicas (RL-01).

### 3.2 Engenharia e qualidade
- [ ] CI verde no commit de release; tag semântica criada; imagens assinadas e com SBOM.
- [ ] Migrações aplicadas em staging a partir de cópia anonimizada do estado de produção (quando houver) e tempo de migração medido.
- [ ] Testes de regressão completos (unit, integração, API, RBAC, tenant leak, E2E, acessibilidade, carga).
- [ ] Verificação de compatibilidade de navegadores (2 últimas versões de Chrome, Edge, Firefox, Safari).
- [ ] Feature flags definidas por tenant piloto.

### 3.3 Segurança e privacidade
- [ ] Pentest concluído e achados críticos/altos corrigidos e revalidados.
- [ ] Segredos em Secrets Manager, rotacionados antes do go-live; nenhum segredo em repositório (gitleaks).
- [ ] Authentik endurecido: MFA para administradores, política de senha, flows revisados, redirect URIs restritas, logs de eventos retidos.
- [ ] WAF com regras gerenciadas e rate limits; security groups revisados; banco e Redis sem acesso público.
- [ ] Criptografia em repouso confirmada (RDS, S3 SSE-KMS, ElastiCache) e TLS 1.2+ em todas as bordas.
- [ ] Inventário de dados pessoais e registro de operações de tratamento (LGPD) atualizados.
- [ ] Procedimento de resposta a incidentes e contato do DPO publicados.

### 3.4 Operação
- [ ] Infraestrutura de produção provisionada via Terraform em `sa-east-1` (residência no Brasil).
- [ ] Backups automáticos (PITR) ativos e restauração testada; replicação/versionamento de buckets conforme storage.md.
- [ ] Dashboards técnicos e de negócio publicados; alertas roteados para plantão; runbooks revisados (outbox, DLQ, PDF, Authentik, ClamAV) e criados os marcados "(a criar)" em observability.md (RB-06..RB-09).
- [ ] Health checks configurados no balanceador; *autoscaling* de api, web, worker e Gotenberg testado.
- [ ] Plano de rollback documentado e ensaiado (versão anterior + migrações compatíveis).
- [ ] Janela de manutenção e comunicação de indisponibilidade definidas.

### 3.5 Implantação nos pilotos
- [ ] Tenants provisionados (US-099) com órgão(s), configurações revisadas com o piloto e workflow padrão ajustado à regulamentação local.
- [ ] Estrutura organizacional (secretarias/setores, titulares e substitutos) cadastrada e validada.
- [ ] Usuários convidados com perfis e escopos corretos; administradores com MFA ativo.
- [ ] Calendário de feriados municipais cadastrado.
- [ ] Catálogos revisados (tipos de contratação, unidades de medida, fontes de preço).
- [ ] Treinamento realizado por persona; usuários-chave identificados em cada secretaria.
- [ ] Canal de suporte ativo (SLA de atendimento acordado) e acompanhamento intensivo nas 2 primeiras semanas.

### 3.6 Pós-release (primeiras 4 semanas)
- [ ] Monitorar KPIs de adoção (processos criados, tramitações, tempo por etapa) e de qualidade (erros 5xx, latência, falhas de PDF).
- [ ] Coletar feedback estruturado dos pilotos e priorizar ajustes.
- [ ] Revisar débitos técnicos e riscos com dados reais de uso.
- [ ] Iniciar a validação do MVP 2 ([risks-and-decisions.md §12](risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2)).
