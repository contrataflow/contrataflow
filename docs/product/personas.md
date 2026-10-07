# ContrataFlow — Personas

> **Status:** v1.0 · personas de referência para design, priorização de backlog e critérios de aceite.
> **Precedência:** perfis, entidades e permissões seguem o [registro de decisões](../architecture/decisions.md) (DEC-035, DEC-036, DEC-012, DEC-134). A matriz completa de permissões fica em [`mvp-01/permissions.md`](../mvp-01/permissions.md).
> **Documentos irmãos:** [visão do produto](product-overview.md) · [roadmap](roadmap.md) · [terminologia](terminology.md).

**Sumário:** [1. Como usar](#1-como-usar-este-documento) · [2. Visão geral](#2-visão-geral-das-15-personas) · [3. Personas](#3-personas) · [4. Matriz persona × fase da jornada](#4-matriz-persona--fase-da-jornada-raci-simplificado) · [5. Matriz persona × MVP](#5-matriz-persona--mvp-relevância) · [6. Quem não é usuário](#6-quem-não-é-usuário-e-personas-internas) · [7. Implicações transversais de design](#7-implicações-transversais-de-design)

---

## 1. Como usar este documento

- **Persona ≠ perfil.** A persona descreve uma pessoa e seu trabalho; o perfil (`Role`) é um conjunto de permissões. Uma pessoa pode ter vários perfis, cada um com escopo e vigência próprios (`RoleAssignment`, DEC-134). Em municípios pequenos é comum uma mesma pessoa acumular funções — o sistema continua impedindo a autoaprovação (DEC-022).
- **Perfil padrão** = chave semeada no provisionamento (DEC-035). Perfis são editáveis pelo administrador do tenant, exceto `ADMIN_ORGAO`.
- **Escopo típico** = sugestão para a implantação (`TENANT`, `ORGANIZATION`, `DEPARTMENT`, `OWN_DEPARTMENTS`); não substitui a matriz de permissões.
- **Nomes e órgãos são fictícios.** O tenant de exemplo é o Município de São José (≈ 60 mil habitantes), como em DEC-011.
- **Telas** são citadas pelo identificador `SCR-NNN`, que corresponde à numeração das 41 telas do [roadmap](roadmap.md#8-mapeamento-das-41-telas).
- Use as personas em cards (seção "Persona" do padrão de card), em testes de usabilidade e para decidir o que aparece primeiro em cada tela.

**Escalas utilizadas**

| Atributo | Valores |
|---|---|
| Letramento digital | **Baixo** — usa e-mail e mensageiros, tem dificuldade com sistemas novos; precisa de passos guiados e linguagem simples · **Médio** — usa sistemas corporativos com segurança e aprende fluxos novos com pouco treinamento · **Alto** — domina sistemas complexos, filtros, exportações e configurações |
| Frequência de uso | Diária · Semanal · Mensal · Esporádica (em campanhas ou picos sazonais) |
| Dispositivo predominante | Desktop · Celular · Misto (com indicação do uso em cada um) |

---

## 2. Visão geral das 15 personas

| # | Persona | Nome fictício · cargo típico | Perfil padrão (DEC-035) | Escopo típico | Frequência | Dispositivo | Letramento | MVP de maior valor |
|---|---|---|---|---|---|---|---|---|
| P01 | Administrador do órgão | Rafael Nogueira · Coordenador de Tecnologia e Modernização Administrativa | `ADMIN_ORGAO` | `TENANT` | Diária na implantação; depois semanal | Desktop | Alto | 1 e 3 |
| P02 | Gestor de contratações | Patrícia Almeida · Diretora do Departamento de Compras e Licitações | `GESTOR_CONTRATACOES` | `ORGANIZATION` | Diária | Misto | Médio | 1 e 2 |
| P03 | Área requisitante | Cláudia Ferreira · Assistente administrativa da Secretaria de Saúde | `REQUISITANTE` | `OWN_DEPARTMENTS` | Semanal, com picos | Misto | Baixo | 1 |
| P04 | Planejamento | Marcos Vinícius Rocha · Analista de Planejamento das Contratações | `PLANEJAMENTO` | `ORGANIZATION` | Diária | Desktop | Médio | 1, 2 e 5 |
| P05 | Compras | Juliana Costa · Agente de compras do Setor de Cotações | `COMPRAS` | `OWN_DEPARTMENTS` ou `ORGANIZATION` | Diária | Desktop | Médio | 1 e 5 |
| P06 | Licitações | André Luiz Barbosa · Agente de contratação e pregoeiro | `LICITACOES` | `ORGANIZATION` | Semanal no MVP 1; diária depois | Desktop | Alto | 2 e 3 |
| P07 | Contabilidade | Sandra Regina Lopes · Chefe da Divisão de Orçamento e Contabilidade | `CONTABILIDADE` | `ORGANIZATION` | Esporádica no MVP 1; semanal depois | Desktop | Médio | 2 e 4 |
| P08 | Jurídico / Procuradoria | Henrique Tavares · Procurador do Município | `JURIDICO` | `TENANT` | Esporádica no MVP 1; diária depois | Desktop | Médio | 2 e 4 |
| P09 | Controle Interno | Luciana Martins · Controladora-Geral do Município | `CONTROLE_INTERNO` | `TENANT` | Semanal, com picos | Desktop | Alto | 1, 2 e 5 |
| P10 | Autoridade competente | Roberto Siqueira · Secretário Municipal de Administração | `AUTORIDADE_COMPETENTE` | `ORGANIZATION` | Diária, sessões curtas | Celular para decidir | Baixo | 1 |
| P11 | Fiscal de contrato | Edson Pereira · Fiscal técnico de contratos (Obras) | `FISCAL_CONTRATO` | `OWN_DEPARTMENTS` | Rara no MVP 1; diária no MVP 4 | Celular em campo | Baixo | 4 |
| P12 | Gestor de contrato | Fernanda Lima · Gestora de contratos (Educação) | `GESTOR_CONTRATO` | `OWN_DEPARTMENTS` | Rara no MVP 1; diária no MVP 4 | Misto | Médio | 4 |
| P13 | Auditor | Paulo Henrique Matos · Auditor de controle externo (acesso temporário) | `AUDITOR` | `TENANT` | Esporádica e intensa | Desktop | Alto | 1 e 4 |
| P14 | Usuário somente leitura | Tatiane Souza · Assessora do Gabinete do Prefeito | `SOMENTE_LEITURA` | `ORGANIZATION` | Semanal | Misto | Médio | 1 |
| P15 | Consultoria externa | Bruno Carvalho · Consultor sênior em contratações públicas | `CONSULTOR_EXTERNO` | Participação `CONSULTANT` por processo | Diária, em vários entes | Desktop | Alto | 1 |

---

## 3. Personas

### P01 — Administrador do órgão

**Rafael Nogueira** — Coordenador de Tecnologia e Modernização Administrativa, Prefeitura Municipal de São José.

> "Não quero abrir chamado para trocar o nome de uma etapa. Quero configurar, testar, publicar — e saber exatamente quem mudou o quê."

| Atributo | Valor |
|---|---|
| Perfil padrão | `ADMIN_ORGAO` (sempre com todas as permissões de administração — DEC-035) |
| Escopo típico | `TENANT` |
| Frequência de uso | Diária durante a implantação (4 a 6 semanas); depois semanal |
| Dispositivo predominante | Desktop |
| Letramento digital | Alto |

**Contexto organizacional.** Lotado na Secretaria de Administração, responde pelos sistemas da prefeitura e é o interlocutor técnico do ContrataFlow. Em municípios menores, o papel costuma ser acumulado pelo diretor de compras ou pelo gestor de contratações — o que pede atenção à segregação de funções (quem configura o workflow não deveria aprovar processos).

**Objetivos**
- Implantar rápido e manter cadastros (usuários, lotações, perfis) sempre corretos.
- Adaptar workflow, templates e regras à regulamentação local sem depender do fornecedor.
- Garantir segurança: MFA, desligamentos refletidos no mesmo dia, nenhum acesso indevido.
- Responder com evidências a auditorias sobre acessos e configurações.

**Dores atuais**
- Cadastros espalhados; servidor que muda de lotação continua com o acesso antigo.
- Senhas "do setor" compartilhadas em outros sistemas.
- Qualquer ajuste depende de chamado ao fornecedor.
- Não há como provar quem acessou ou alterou o quê.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Acompanhar o provisionamento; cadastrar órgãos (com CNPJ) e a árvore de unidades com titular e substituto; convidar usuários em lote com lotações; atribuir perfis com escopo e vigência; ajustar perfis; configurar numeração, calendário, catálogos e parâmetros da pesquisa de preços; revisar templates com a Procuradoria; publicar versões do workflow e regras básicas; definir a política de MFA (`security.mfaPolicy`); consultar a auditoria de acessos e configurações; acompanhar acessos de suporte da plataforma (DEC-139) |
| 2 | Manter a biblioteca de regras condicionais, as políticas de SLA e o calendário do PCA |
| 3 | Configurar integrações (PNCP, diário oficial, portal), contas de serviço (`SERVICE`), credenciais da API pública e webhooks |
| 4 | Parametrizar alertas de vencimento e índices de reajuste |
| 5 | Habilitar a IA por feature flag e definir políticas de uso |

**Telas principais:** SCR-029 Usuários · SCR-030 Perfis · SCR-031 Permissões · SCR-032 Secretarias · SCR-033 Templates · SCR-034 Workflow · SCR-035 Regras · SCR-037 Auditoria · SCR-041 Configurações gerais · SCR-038 Integrações (MVP 3).

**O que precisa ver primeiro ao entrar**
- Checklist de implantação com percentual concluído (órgãos, unidades, usuários, perfis, templates, workflow).
- Alertas administrativos: convites pendentes ou expirados; vínculos `EXTERNAL` vencendo em 7 dias; unidades sem titular ou substituto (impedem a resolução do aprovador `DEPARTMENT_HEAD`); usuários com permissões de risco alto sem MFA; falhas de envio de e-mail.

**Métricas de sucesso**
- Do provisionamento ao primeiro processo em até 10 dias úteis.
- 100% das unidades com titular e substituto definidos.
- Pelo menos 85% dos convites aceitos em 14 dias; nenhuma conta compartilhada.
- Chamados de suporte sobre acesso e cadastro em queda contínua.

**Considerações de UX e acessibilidade**
- Ações de alto impacto (publicar versão de workflow, alterar perfil) com prévia do impacto ("23 usuários afetados"; "processos em andamento continuam na versão anterior") e confirmação explícita.
- Importação em lote por planilha com validação linha a linha e relatório de erros acessível.
- Explicação de permissões efetivas: "por que este usuário pode (ou não) fazer isto?" — sem personificar o usuário.
- Tabelas densas navegáveis por teclado, com cabeçalhos fixos e filtros rotulados; MFA obrigatório para permissões de risco alto (DEC-133).

---

### P02 — Gestor de contratações

**Patrícia Almeida** — Diretora do Departamento de Compras e Licitações, Secretaria de Administração.

> "Meu problema não é falta de gente trabalhando; é não saber onde cada processo parou e por quê."

| Atributo | Valor |
|---|---|
| Perfil padrão | `GESTOR_CONTRATACOES` |
| Escopo típico | `ORGANIZATION` |
| Frequência de uso | Diária, em várias sessões |
| Dispositivo predominante | Misto — desktop com dois monitores; celular para consultas e decisões rápidas |
| Letramento digital | Médio |

**Contexto organizacional.** Lidera oito servidores (compras, cotações e licitações), responde ao secretário de Administração e coordena processos de todas as secretarias. É pressionada pelas secretarias por prazo e pelo controle por conformidade.

**Objetivos**
- Saber, a qualquer momento, onde estão os processos e o que está travado.
- Distribuir o trabalho com equilíbrio e cumprir prazos (prazo da etapa e prazo alvo).
- Padronizar documentos e reduzir devoluções.
- Apresentar números confiáveis à gestão.

**Dores atuais**
- Planilha de controle manual, sempre desatualizada.
- Processos "sumidos" em gavetas e caixas de e-mail.
- Devoluções por documentos incompletos.
- Não consegue provar onde está o gargalo quando ele está fora da sua área.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Monitorar o dashboard; filtrar e salvar visões (`SavedView`); atribuir e reatribuir responsáveis (`PROCESS_ASSIGN`); acompanhar prazos e atrasos; suspender, retomar e cancelar processos com justificativa; duplicar processos recorrentes (DEC-033); validar templates e workflow com o administrador |
| 2 | Indicadores, SLA, gargalos e relatórios; acompanhar a execução do PCA |
| 3 | Acompanhar publicações e falhas de integração |
| 4 | Visão da carteira de contratos e dos vencimentos |
| 5 | Saúde do processo e previsão de atraso |

**Telas principais:** SCR-003 Dashboard · SCR-004 Processos · SCR-006 Detalhe do Processo · SCR-013 Caixa de tarefas · SCR-014 Aprovações · SCR-034 Workflow (consulta) · SCR-027 e SCR-028 Relatórios (MVP 2).

**O que precisa ver primeiro ao entrar**
- Processos atrasados e prestes a vencer, por etapa e unidade.
- Etapas paradas na unidade sem responsável atribuído.
- Aprovações pendentes há mais de N dias.
- Carga de trabalho por responsável.

**Métricas de sucesso**
- Pelo menos 80% das etapas concluídas no prazo.
- Tempo de ciclo do planejamento 30% menor que a linha de base em 6 meses.
- Devoluções 40% menores em 6 meses.
- Nenhum processo sem responsável há mais de 2 dias úteis.

**Considerações de UX e acessibilidade**
- Todo número do dashboard leva à lista filtrada correspondente.
- Atraso nunca indicado só por cor: ícone e texto ("Atrasado há 3 dias úteis").
- Densidade de tabela ajustável e visões salvas.
- Gráficos com tabela equivalente para leitores de tela.

---

### P03 — Área requisitante

**Cláudia Ferreira** — Assistente administrativa da Secretaria Municipal de Saúde.

> "Eu sei do que a Saúde precisa. O que eu não sei é como escrever isso do jeito que a lei pede."

| Atributo | Valor |
|---|---|
| Perfil padrão | `REQUISITANTE` |
| Escopo típico | `OWN_DEPARTMENTS` (suas lotações) |
| Frequência de uso | Semanal, com picos no planejamento anual e em urgências |
| Dispositivo predominante | Misto — desktop compartilhado no setor; celular para acompanhar |
| Letramento digital | Baixo |

**Contexto organizacional.** Servidora da secretaria-fim que formaliza necessidades (medicamentos, manutenção, serviços). Não é especialista em licitações. O DFD que ela elabora é aprovado pelo titular da secretaria.

**Objetivos**
- Registrar a necessidade corretamente na primeira vez.
- Saber o andamento sem telefonar para ninguém.
- Responder às devoluções com clareza.
- Receber o que a secretaria precisa a tempo.

**Dores atuais**
- Não sabe o que escrever no DFD e copia documentos antigos.
- Devoluções sem explicação clara.
- Não sabe com quem está o processo.
- Prazos perdidos viram compras emergenciais.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Criar o processo pelo wizard; preencher o DFD (necessidade, justificativa, itens e quantidades, situação no PCA — `pcaStatus`); anexar documentos; finalizar o DFD e encaminhar; responder devoluções; comentar e mencionar colegas; acompanhar o andamento; colaborar no ETP e no TR quando designada |
| 2 | Propor demandas para o PCA do exercício seguinte |
| 4 | Acompanhar a execução dos contratos da secretaria (consulta) |
| 5 | Usar o assistente para redigir e revisar a justificativa da necessidade |

**Telas principais:** SCR-005 Novo Processo · SCR-007 DFD · SCR-006 Detalhe do Processo · SCR-004 Processos ("Meus processos") · SCR-013 Caixa de tarefas · SCR-036 Notificações.

**O que precisa ver primeiro ao entrar**
- "Minhas pendências", com processos devolvidos em destaque e o motivo da devolução.
- "Meus processos", com a situação em linguagem simples e o próximo passo.
- Botão principal "Nova demanda".

**Métricas de sucesso**
- DFD elaborado em até 1 dia útil (mediana).
- Pelo menos 80% dos DFDs aprovados sem devolução.
- SUS de pelo menos 75.
- Menos ligações de cobrança ao setor de compras.

**Considerações de UX e acessibilidade**
- Wizard com passos curtos, exemplos e ajuda por campo, com termos legais explicados por tooltip e glossário (DEC-181, DEC-184).
- Autosave visível ("Salvo às 14:32" — DEC-182); nada de jargão técnico.
- Devolução mostra o motivo, o que corrigir e leva direto ao campo.
- Fonte base de pelo menos 16 px, rótulos sempre visíveis, mensagens de erro associadas ao campo e anunciadas por leitor de tela, contraste mínimo de 4,5:1, nenhuma informação transmitida só por cor; jornada do DFD testada com teclado e leitor de tela.

---

### P04 — Planejamento

**Marcos Vinícius Rocha** — Analista de Planejamento das Contratações, Coordenadoria de Planejamento da Secretaria de Administração.

> "Metade do meu tempo vai em copiar o que já está no ETP para o TR e conferir se ninguém mudou a quantidade no meio do caminho."

| Atributo | Valor |
|---|---|
| Perfil padrão | `PLANEJAMENTO` |
| Escopo típico | `ORGANIZATION` |
| Frequência de uso | Diária |
| Dispositivo predominante | Desktop (edição de documentos é *desktop-first* — DEC-183) |
| Letramento digital | Médio |

**Contexto organizacional.** Integra a equipe de planejamento da contratação com a área requisitante e a área técnica; elabora ETP, mapa de riscos e TR. Em municípios menores, o próprio setor de compras exerce esse papel. A partir do MVP 2, conduz o PCA.

**Objetivos**
- Produzir ETP e TR completos e coerentes entre si.
- Reaproveitar conteúdo e cumprir os elementos legais (art. 18, §§ 1º e 2º; art. 6º, XXIII).
- Alinhar cada contratação ao PCA.

**Dores atuais**
- Copiar e colar do ETP para o TR.
- Quantidades divergentes entre documentos.
- Versões perdidas e revisões por e-mail.
- Alternativas descartadas sem registro do porquê.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Elaborar o ETP por seções com indicador de completude; registrar alternativas de solução e recomendar uma (`EtpAlternative`); memória de cálculo das quantidades (`DocumentItem`); decisão de parcelamento; conclusão de viabilidade; mapa de riscos com probabilidade, impacto e tratamentos; TR com importação do ETP; finalizar documentos e encaminhar |
| 2 | Elaborar e consolidar o PCA; vincular DFDs a itens do plano |
| 5 | Validações cruzadas (quantidade, garantia, prazos) e busca de contratações similares |

**Telas principais:** SCR-008 ETP · SCR-011 Riscos · SCR-012 TR · SCR-006 Detalhe do Processo · SCR-013 Caixa de tarefas · SCR-018 PCA (MVP 2).

**O que precisa ver primeiro ao entrar**
- Caixa de tarefas com ETP e TR sob sua responsabilidade e respectivos prazos.
- Completude de cada documento em elaboração.
- Menções e comentários não lidos.

**Métricas de sucesso**
- 100% dos ETP com os elementos mínimos do art. 18, § 2º (garantido por regra).
- ETP elaborado em até 5 dias úteis (mediana).
- Devoluções na aprovação da autoridade abaixo de 15%.
- Divergências entre ETP e TR tendendo a zero (MVP 5).

**Considerações de UX e acessibilidade**
- Editor por seções com navegação lateral e indicador de completude (DEC-181); orientação de cada seção com a base legal em tooltip.
- Comparação entre versões do documento; atalhos de teclado para salvar versão e navegar entre seções.
- Editor operável integralmente por teclado; estado do autosave anunciado de forma discreta (região viva "polite"); marcos de navegação entre seções.

---

### P05 — Compras

**Juliana Costa** — Agente de compras do Setor de Cotações, Departamento de Compras.

> "Eu passo o dia entre e-mail de fornecedor, Painel de Preços e uma planilha que só eu entendo."

| Atributo | Valor |
|---|---|
| Perfil padrão | `COMPRAS` |
| Escopo típico | `OWN_DEPARTMENTS` (processos que passam pela unidade de Compras) ou `ORGANIZATION`, se precisar consultar pesquisas de todo o órgão |
| Frequência de uso | Diária, em sessões longas |
| Dispositivo predominante | Desktop com dois monitores |
| Letramento digital | Médio |

**Contexto organizacional.** Realiza as pesquisas de preços de todas as secretarias. A etapa `PESQUISA_PRECOS` do workflow padrão é atribuída à unidade de Compras (DEC-015). Lida com fornecedores por e-mail e telefone e consulta painéis de preços, o PNCP e sítios especializados.

**Objetivos**
- Pesquisa válida e defensável: ao menos 3 preços, fontes diversificadas, dentro da validade.
- Cálculo correto e justificativas registradas.
- Rapidez sem perder qualidade.

**Dores atuais**
- Planilhas com fórmulas quebradas e cotações vencidas.
- Dificuldade de justificar exclusões de valores.
- Fornecedores que não respondem; retrabalho quando a quantidade muda.
- Evidências dispersas (capturas de tela, e-mails).

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Assumir pesquisas da fila da unidade; registrar fontes (`PriceSource`) com tipo (`PRICE_SOURCE_TYPE`), data, hora e evidência anexada; cadastrar fornecedores (CNPJ, inclusive alfanumérico, ou CPF); lançar cotações por item; analisar valores atípicos sinalizados; desconsiderar cotações com motivo e justificativa (e restaurá-las se necessário); escolher o método de cálculo; conferir o mapa comparativo; concluir a pesquisa |
| 2 | Apoiar o edital (itens, lotes, preços de referência) |
| 5 | Benchmark de preços e sugestão de fontes |

**Telas principais:** SCR-009 Pesquisa de preços · SCR-010 Mapa comparativo · SCR-013 Caixa de tarefas · SCR-006 Detalhe do Processo.

**O que precisa ver primeiro ao entrar**
- Fila de pesquisas da unidade (sem responsável → ação "Assumir"), com prazos.
- Cotações que vencem em breve.
- Itens com menos de 3 cotações válidas.
- Valores atípicos pendentes de análise.

**Métricas de sucesso**
- 100% dos itens com 3 ou mais cotações válidas ou justificativa registrada.
- Duração da pesquisa 30% menor que a linha de base.
- Nenhuma cotação vencida na conclusão.
- Devoluções motivadas pela pesquisa abaixo de 10%.

**Considerações de UX e acessibilidade**
- Grade no estilo planilha, operável por teclado (Tab, Enter, setas) e com colagem de valores vindos de planilhas.
- Recálculo imediato com precisão decimal (DEC-003); valor atípico indicado por ícone e texto, nunca só por cor.
- Evidência de cada cotação a um clique; mapa comparativo exportável em PDF.
- Grade com semântica de grid acessível, anúncio de recálculo e foco preservado após salvar.

---

### P06 — Licitações

**André Luiz Barbosa** — Agente de contratação e pregoeiro, Departamento de Licitações.

> "Quando o processo chega redondo, o edital sai em um dia. Quando chega torto, eu viro revisor de ETP."

| Atributo | Valor |
|---|---|
| Perfil padrão | `LICITACOES` |
| Escopo típico | `ORGANIZATION` |
| Frequência de uso | Semanal no MVP 1 (consulta); diária a partir dos MVPs 2 e 3 |
| Dispositivo predominante | Desktop |
| Letramento digital | Alto |

**Contexto organizacional.** Designado pela autoridade competente (art. 8º), conduz os certames em plataforma de disputa eletrônica. Recebe processos com o planejamento concluído, elabora o edital com a equipe de apoio e publica avisos, editais e resultados.

**Objetivos**
- Receber processos completos e coerentes (TR, pesquisa, riscos).
- Montar o edital rapidamente a partir do TR.
- Publicar corretamente, em todos os canais exigidos, no prazo.
- Reduzir impugnações causadas por falhas de planejamento.

**Dores atuais**
- Processos que chegam incompletos.
- Divergências entre TR e edital.
- Publicação manual em vários canais (PNCP, diário oficial, sítio do ente).
- Prazos legais de divulgação controlados à mão.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Acompanhar os processos que chegarão (leitura); colaborar no TR quando convidado como participante `COLLABORATOR` (critérios de seleção do fornecedor e de habilitação) |
| 2 | Elaborar a minuta do edital a partir de template, importando itens, lotes e critérios do TR; encaminhar ao jurídico; atender diligências |
| 3 | Publicar aviso e edital no PNCP, extrato em diário oficial e no portal do ente; acompanhar tentativas e reprocessar falhas |
| 4 | Informar o resultado (adjudicação e homologação) que origina o contrato — lacuna a decidir ([roadmap](roadmap.md#10-itens-fora-do-escopo-dos-5-mvps-e-lacunas-identificadas)) |
| 5 | Validação cruzada entre edital e TR |

**Telas principais:** SCR-004 Processos e SCR-006 Detalhe do Processo (MVP 1) · SCR-021 Edital (MVP 2) · SCR-016 Publicações e SCR-017 Nova publicação (MVP 3).

**O que precisa ver primeiro ao entrar**
- Processos com planejamento concluído aguardando edital (fila de entrada).
- Prazos de publicação.
- Publicações com falha.

**Métricas de sucesso**
- Tempo entre a conclusão do planejamento e a publicação do edital.
- Impugnações e pedidos de esclarecimento por falhas de planejamento em queda.
- 100% das publicações confirmadas no PNCP (MVP 3); nenhuma publicação fora do prazo.

**Considerações de UX e acessibilidade**
- Comparação lado a lado entre TR e edital.
- Checklist de publicação por canal; situação de cada canal com mensagem compreensível e ação "Tentar novamente".
- Tabelas de itens e lotes navegáveis por teclado, com totais anunciados.

---

### P07 — Contabilidade

**Sandra Regina Lopes** — Contadora, Chefe da Divisão de Orçamento e Contabilidade, Secretaria de Fazenda.

> "Não me peça dotação por WhatsApp. Me mostre o objeto, o valor e o exercício — e eu respondo no mesmo dia."

| Atributo | Valor |
|---|---|
| Perfil padrão | `CONTABILIDADE` |
| Escopo típico | `ORGANIZATION` |
| Frequência de uso | Esporádica no MVP 1; semanal ou diária a partir do MVP 2 |
| Dispositivo predominante | Desktop |
| Letramento digital | Médio |

**Contexto organizacional.** Responde pela execução orçamentária no sistema contábil do ente: indica dotação, fonte de recursos e natureza da despesa. Nenhuma contratação pode ocorrer sem indicação dos créditos orçamentários (art. 150).

**Objetivos**
- Indicar a dotação correta e tempestivamente.
- Ter previsibilidade das contratações que estão por vir.
- Evitar contratação sem lastro orçamentário.

**Dores atuais**
- Pedidos de dotação por ofício ou e-mail, com dados incompletos.
- Nenhuma previsibilidade; retrabalho quando o valor estimado muda.
- Conferência manual entre sistemas.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Consultar processos e valores estimados (respeitando o orçamento sigiloso — DEC-030) para antecipar o impacto orçamentário; comentar quando consultada |
| 2 | Etapa de dotação (`BudgetAllocation`): indicar classificação orçamentária, fonte de recursos e valor reservado; anexar demonstrativo; sinalizar incompatibilidades |
| 3 | Consultar saldo e registrar reserva por integração com o sistema contábil |
| 4 | Acompanhar medições para liquidação e empenhos por contrato |

**Telas principais:** SCR-004 Processos e SCR-006 Detalhe do Processo (MVP 1) · etapa de dotação no Detalhe do Processo e na Caixa de tarefas (MVP 2 — não há tela dedicada entre as 41) · SCR-027 e SCR-028 Relatórios · SCR-025 Medições (MVP 4).

**O que precisa ver primeiro ao entrar**
- Processos aguardando dotação, com valor e prazo.
- Previsão de valores por exercício e por secretaria (MVP 2).

**Métricas de sucesso**
- Dotação indicada em até 2 dias úteis.
- Nenhum processo concluído sem dotação (regra do MVP 2).
- 100% das divergências entre valor estimado e valor reservado sinalizadas.

**Considerações de UX e acessibilidade**
- Classificação orçamentária com autocompletar a partir de catálogos.
- Valores no padrão brasileiro, alinhados à direita; exportação.
- Tabelas numéricas com cabeçalhos associados às células e totais anunciados por leitor de tela.

---

### P08 — Jurídico / Procuradoria

**Henrique Tavares** — Procurador do Município, Procuradoria-Geral.

> "Preciso saber exatamente qual versão analisei. Se mudou depois do parecer, o sistema tem que me avisar."

| Atributo | Valor |
|---|---|
| Perfil padrão | `JURIDICO` |
| Escopo típico | `TENANT` (a Procuradoria atende todos os órgãos do tenant) |
| Frequência de uso | Esporádica no MVP 1; diária a partir do MVP 2 |
| Dispositivo predominante | Desktop (leitura extensa) |
| Letramento digital | Médio |

**Contexto organizacional.** Equipe de 2 a 6 procuradores atendendo todas as secretarias, com alto volume. Faz o controle prévio de legalidade (art. 53) como segunda linha de defesa (art. 169, II) e também está sujeita à segregação de funções (art. 7º, § 2º). Pareceres são peças de responsabilização.

**Objetivos**
- Analisar processos completos, com todos os elementos.
- Priorizar por critérios objetivos (art. 53, § 1º, I) e escrever em linguagem simples (art. 53, § 1º, II).
- Padronizar minutas para dispensar análises repetitivas (art. 53, § 5º).
- Saber exatamente o que foi analisado.

**Dores atuais**
- Processos incompletos e PDFs desconexos.
- Não sabe o que mudou após a diligência.
- Minutas não padronizadas; pressão por urgência.
- Parecer emitido sobre uma versão diferente da final.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Revisar templates (DFD, ETP, TR, despachos) com o administrador; participar de processos quando convidado (`OBSERVER` ou `COLLABORATOR`) ou em etapa `TASK` configurada pelo órgão; comentar |
| 2 | Fila de análise jurídica priorizada; análise com situação (aguardando, em análise, diligência, favorável, favorável com ressalvas, desfavorável); parecer vinculado às versões analisadas; devolução por diligência; hipóteses de dispensa de análise (art. 53, § 5º) mantidas como regras; análise da minuta do edital |
| 3 | Assinatura eletrônica do parecer |
| 4 | Análise de aditivos e prorrogações (art. 53, § 4º) |
| 5 | Checklist jurídico assistido e busca de casos internos semelhantes — sem substituir o parecer |

**Telas principais:** SCR-006 Detalhe do Processo e SCR-033 Templates (revisão) (MVP 1) · SCR-019 Jurídico (MVP 2) · SCR-026 Aditivos (MVP 4).

**O que precisa ver primeiro ao entrar**
- Fila priorizada com prazos.
- Retornos de diligência com "o que mudou desde a minha análise".

**Métricas de sucesso**
- Tempo de análise por processo.
- Diligências por processo em queda.
- Percentual de pareceres emitidos no prazo.
- 100% dos pareceres vinculados à versão exata analisada.

**Considerações de UX e acessibilidade**
- Visão consolidada dos autos: documentos na ordem do processo, navegação contínua.
- Comparação entre versões após a diligência; modelos de parecer.
- Modo de leitura com zoom de até 200% sem perda de conteúdo e atalhos para alternar entre documentos.

---

### P09 — Controle Interno

**Luciana Martins** — Controladora-Geral do Município.

> "Controle preventivo só existe se eu enxergar o processo enquanto ele acontece — não seis meses depois, numa pasta."

| Atributo | Valor |
|---|---|
| Perfil padrão | `CONTROLE_INTERNO` |
| Escopo típico | `TENANT` |
| Frequência de uso | Semanal, com picos em auditorias e prestações de contas |
| Dispositivo predominante | Desktop |
| Letramento digital | Alto |

**Contexto organizacional.** Unidade de controle interno — segunda linha de defesa (art. 169, II). Tem acesso irrestrito às informações, inclusive classificadas (art. 169, § 2º), e o sigilo do orçamento estimado não prevalece para ela (art. 24, I). Orienta as secretarias e reporta ao tribunal de contas.

**Objetivos**
- Visão ampla e independente dos processos.
- Detectar riscos cedo (controle preventivo).
- Trilha de auditoria confiável e checklists de conformidade.

**Dores atuais**
- Informação fragmentada; depende de pedir documentos às secretarias.
- Impossível verificar se um documento foi alterado depois de aprovado.
- Amostragem manual e demorada.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Consultar todos os processos, inclusive valores sigilosos; acompanhar timeline e trilha de auditoria (`AUDIT_VIEW`); verificar integridade (hash de versões e PDFs, selos de auditoria); exportar evidências; seguir processos relevantes (`OBSERVER`); comentar |
| 2 | Etapa de Controle Interno com manifestação e checklist; indicadores, gargalos e relatórios |
| 4 | Acompanhar a execução contratual (ocorrências, aditivos, vencimentos) |
| 5 | Saúde do processo e alertas de risco (ex.: possível fracionamento de despesa, divergências entre documentos) |

**Telas principais:** SCR-003 Dashboard · SCR-004 Processos · SCR-006 Detalhe do Processo · SCR-037 Auditoria · SCR-031 Permissões (consulta) · SCR-020 Controle Interno, SCR-027 e SCR-028 Relatórios (MVP 2).

**O que precisa ver primeiro ao entrar**
- Sinais de risco: cotações desconsideradas, documentos reabertos após aprovação, cancelamentos, decisões tomadas por substituto, avisos de regra (`WARNING`) superados na tramitação.
- Processos de maior valor.
- Ações sensíveis recentes na trilha de auditoria.

**Métricas de sucesso**
- Tempo para reunir as evidências de um processo: de dias para minutos.
- Percentual de processos com checklist de controle concluído (MVP 2).
- Proporção de achados preventivos sobre corretivos.

**Considerações de UX e acessibilidade**
- Filtros combináveis e exportação registrada na auditoria.
- Explicação de permissões efetivas; datas absolutas com fuso explícito.
- Tabelas extensas com paginação acessível e resumo do filtro aplicado anunciado por leitor de tela.

> **Requisitos para a matriz de permissões:** o perfil padrão deve incluir `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (art. 24, I) e `AUDIT_VIEW`. Para que avisos superados sejam visíveis, a superação de regras `WARNING` precisa ficar registrada na tramitação e na auditoria (ver lacunas no [roadmap](roadmap.md#10-itens-fora-do-escopo-dos-5-mvps-e-lacunas-identificadas)).

---

### P10 — Autoridade competente

**Roberto Siqueira** — Secretário Municipal de Administração e ordenador de despesa.

> "Me diga em uma tela o que estou aprovando, quanto custa e se tem algum problema. O resto eu leio se precisar."

| Atributo | Valor |
|---|---|
| Perfil padrão | `AUTORIDADE_COMPETENTE` |
| Escopo típico | `ORGANIZATION` (padrão da etapa `APROVACAO_AUTORIDADE` — DEC-015) |
| Frequência de uso | Diária, em sessões curtas (5 a 10 minutos) |
| Dispositivo predominante | Celular para decidir; desktop para análises longas |
| Letramento digital | Baixo (pouco tempo; não quer aprender sistema) |

**Contexto organizacional.** Decide sobre as contratações com a agenda lotada. Muitas vezes acumula o papel de titular da secretaria solicitante (aprova o DFD como `DEPARTMENT_HEAD`) e de autoridade competente. Responde pessoalmente por suas decisões (LINDB, art. 28). Em vários entes, cada secretário ordena as despesas da própria pasta.

**Objetivos**
- Decidir rápido e com segurança.
- Entender em um minuto o que está aprovando: objeto, valor, riscos e alertas.
- Delegar sem perder controle (substituto) e nunca aprovar a versão errada.

**Dores atuais**
- Pilhas de papel para assinar; não sabe o que mudou desde a última vez.
- Urgências e aprovações por mensagem, sem registro.
- Ausências (férias) travam processos.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Decidir aprovações: aprovar, devolver com motivo ou indeferir com justificativa; abrir os documentos na versão exata coberta pela aprovação; acompanhar o dashboard; o substituto decide quando permitido (`allowDeputy`) |
| 2 | Aprovações com múltiplos aprovadores (PEND-13); aprovar o PCA e o edital |
| 3 | Assinar eletronicamente atos e contratos |
| 4 | Decidir aditivos e prorrogações |
| 5 | Ler o resumo assistido do processo antes de decidir |

**Telas principais:** SCR-014 Aprovações · SCR-015 Detalhe da aprovação · SCR-003 Dashboard · SCR-006 Detalhe do Processo.

**O que precisa ver primeiro ao entrar**
- "Aguardando sua decisão": quantidade e lista ordenada por prazo, prioridade e valor.
- Para cada item, um resumo de uma tela: objeto, valor estimado, unidade solicitante, alertas de regra, documentos cobertos e respectivas versões.
- Itens com prazo vencido em destaque.

**Métricas de sucesso**
- Tempo de decisão de até 2 dias úteis (mediana).
- Pelo menos 90% das aprovações decididas no prazo.
- Nenhuma decisão sobre versão não vinculada (garantido pelo design — `ApprovalDocument`).
- Nenhum processo parado por ausência do titular.

**Considerações de UX e acessibilidade**
- *Progressive disclosure* em três níveis: resumo → documentos → detalhes.
- Botões de decisão grandes e distintos; confirmação com o resumo da decisão; motivo obrigatório para devolver ou indeferir, com sugestões.
- Experiência pensada primeiro para o celular (DEC-183); confirmação adicional de MFA simples no celular, por biometria via WebAuthn (DEC-133).
- Zoom de 200% sem perda, alto contraste, alvos de toque de pelo menos 44 × 44 px (boa prática) e resumo da decisão lido corretamente por leitor de tela.

---

### P11 — Fiscal de contrato

**Edson Pereira** — Fiscal técnico de contratos, Secretaria de Obras e Serviços Urbanos.

> "Quando dá problema na obra, eu anoto no caderno e tiro foto no meu celular. Depois ninguém acha nada."

| Atributo | Valor |
|---|---|
| Perfil padrão | `FISCAL_CONTRATO` (permissões ampliadas no MVP 4 — DEC-035) |
| Escopo típico | `OWN_DEPARTMENTS` |
| Frequência de uso | Rara no MVP 1 (leitura); diária ou semanal no MVP 4 |
| Dispositivo predominante | Celular em campo; desktop para relatórios |
| Letramento digital | Baixo |

**Contexto organizacional.** Designado por portaria (art. 117), em geral acumulando funções técnicas. Atua em campo, registra ocorrências, atesta medições e reporta ao gestor do contrato. Pode ter substituto.

**Objetivos**
- Registrar ocorrências no momento em que acontecem, com fotos.
- Atestar medições corretamente.
- Conhecer as obrigações e os prazos do contratado.
- Proteger-se com registros formais.

**Dores atuais**
- Anotações em caderno e fotos no celular pessoal, sem vínculo com o contrato.
- Não conhece todo o TR; não sabe quando o contrato vence.
- Medo de responsabilização.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Leitura: consultar o TR (modelos de gestão e de fiscalização) dos processos que vai fiscalizar; contribuir com a seção de fiscalização quando convidado como participante |
| 4 | Registrar ocorrências com evidências (`ContractOccurrence`); registrar medições e atestá-las (`ContractMeasurement`); preencher checklists de fiscalização; comunicar o gestor; receber alertas |
| 5 | Consultar o assistente sobre as obrigações do contrato |

**Telas principais:** SCR-006 Detalhe do Processo (leitura, MVP 1) · SCR-022 Contratos, SCR-023 Detalhe do contrato, SCR-024 Fiscalização e SCR-025 Medições (MVP 4).

**O que precisa ver primeiro ao entrar (MVP 4)**
- Contratos que fiscaliza.
- Próximas medições e ocorrências abertas.
- Vencimentos próximos.

**Métricas de sucesso (MVP 4)**
- Pelo menos 90% das ocorrências registradas em até 24 horas.
- Medições atestadas no prazo.
- 100% dos contratos com fiscal e substituto designados.

**Considerações de UX e acessibilidade**
- Registro em poucos toques no celular (foto, descrição, local).
- Tolerância a conectividade instável — estratégia a decidir no detalhamento do MVP 4.
- Formulários curtos; alto contraste para uso sob sol; alvos grandes; uso com uma mão; compatibilidade com o ditado por voz do sistema operacional.

---

### P12 — Gestor de contrato

**Fernanda Lima** — Gestora de contratos, Secretaria Municipal de Educação.

> "Contrato vencido vira contratação emergencial. E contratação emergencial vira problema no tribunal de contas."

| Atributo | Valor |
|---|---|
| Perfil padrão | `GESTOR_CONTRATO` (permissões ampliadas no MVP 4 — DEC-035) |
| Escopo típico | `OWN_DEPARTMENTS` ou `DEPARTMENT` da secretaria, com subárvore |
| Frequência de uso | Rara no MVP 1 (leitura); diária no MVP 4 |
| Dispositivo predominante | Misto — desktop; celular para alertas |
| Letramento digital | Médio |

**Contexto organizacional.** Coordena dezenas de contratos (transporte escolar, alimentação, manutenção) e os respectivos fiscais. Providencia aditivos, reajustes e prorrogações. É a interface com o contratado e com a contabilidade.

**Objetivos**
- Nunca perder um vencimento.
- Decidir a tempo entre prorrogar, encerrar ou iniciar nova contratação.
- Aplicar reajustes corretos e ter visão da execução.

**Dores atuais**
- Planilha de contratos; vencimentos descobertos tarde.
- Aditivos sem histórico organizado.
- Reajustes calculados à mão.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Leitura dos processos que gerarão contratos; contribuir com o modelo de gestão do contrato no TR quando convidada |
| 4 | Carteira de contratos; designação de gestor e fiscais (`ContractManager`, `ContractInspector`); aditivos (`ContractAmendment`); reajustes; alertas de vencimento (180/120/90/60/30 dias); renovação ou novo processo por duplicação (DEC-033); acompanhamento de medições e ocorrências |
| 5 | Previsão de atraso e recomendações |

**Telas principais:** SCR-006 Detalhe do Processo (MVP 1) · SCR-022 a SCR-026 (MVP 4).

**O que precisa ver primeiro ao entrar (MVP 4)**
- Linha do tempo de vencimentos.
- Contratos com ocorrências abertas e aditivos em tramitação.
- Saldo contratual.

**Métricas de sucesso**
- Nenhum contrato vencido sem decisão.
- 100% das prorrogações iniciadas com pelo menos 90 dias de antecedência.
- Nenhuma contratação emergencial causada por vencimento.

**Considerações de UX e acessibilidade**
- Calendário e linha do tempo de vencimentos; alertas configuráveis.
- Prazos expressos em texto ("vence em 28 dias"), além da cor.
- Tabelas ordenáveis por teclado.

---

### P13 — Auditor

**Paulo Henrique Matos** — Auditor de controle externo em fiscalização no município, com acesso temporário. O mesmo perfil atende auditores internos.

> "Não me mostre só o documento final. Me mostre quem fez, quando, qual versão foi aprovada — e prove que não foi alterada depois."

| Atributo | Valor |
|---|---|
| Perfil padrão | `AUDITOR` (somente leitura, com `AUDIT_VIEW`) |
| Escopo típico | `TENANT`; vínculo `EXTERNAL` com validade obrigatória quando externo (DEC-012) |
| Frequência de uso | Esporádica e intensa (campanhas de auditoria) |
| Dispositivo predominante | Desktop |
| Letramento digital | Alto |

**Contexto organizacional.** Pode ser servidor da unidade de auditoria interna (vínculo `INTERNAL`) ou agente de controle externo com vínculo `EXTERNAL` temporário concedido pelo administrador do tenant. Trabalha por amostragem e precisa de evidências íntegras.

**Objetivos**
- Acessar rapidamente o processo completo e sua trilha.
- Verificar integridade (hashes e selos).
- Amostrar e exportar evidências sem alterar nada.

**Dores atuais**
- Pedir documentos e esperar dias.
- Documentos incompletos e sem prova de integridade.
- Sistemas que não mostram o histórico.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Buscar e filtrar processos; ler documentos, versões, tramitações e timeline; consultar a trilha de auditoria com filtros; verificar hashes e selos; baixar PDFs (download auditado — DEC-136); exportar |
| 2 | Consultar relatórios e indicadores |
| 3 | Verificar evidências de publicação (tentativas e comprovantes) |
| 4 | Examinar a execução contratual |

**Telas principais:** SCR-004 Processos · SCR-006 Detalhe do Processo · SCR-037 Auditoria · SCR-027 e SCR-028 Relatórios (MVP 2) · SCR-016 Publicações (MVP 3) · SCR-022 e SCR-023 (MVP 4).

**O que precisa ver primeiro ao entrar**
- Busca global.
- Trilha de auditoria e situação da última verificação de integridade.
- Validade do próprio acesso.

**Métricas de sucesso**
- Evidências de um processo reunidas em até 15 minutos.
- 100% das versões aprovadas com hash verificável.
- Nenhum pedido de documento fora da plataforma para processos integralmente digitais.

**Considerações de UX e acessibilidade**
- Modo de leitura sem ações de edição, para não poluir a interface.
- Exportação com manifesto (lista de arquivos e respectivos hashes) — desejável.
- Atalhos de busca e filtros persistentes em tabelas extensas.

---

### P14 — Usuário somente leitura

**Tatiane Souza** — Assessora do Gabinete do Prefeito.

> "Eu só preciso saber onde está e quando sai. Sem medo de apertar o botão errado."

| Atributo | Valor |
|---|---|
| Perfil padrão | `SOMENTE_LEITURA` |
| Escopo típico | `ORGANIZATION` ou `DEPARTMENT`, conforme a necessidade |
| Frequência de uso | Semanal |
| Dispositivo predominante | Misto — celular e desktop |
| Letramento digital | Médio |

**Contexto organizacional.** Responde a perguntas do prefeito, de vereadores, da imprensa e do Serviço de Informação ao Cidadão (LAI) sobre o andamento das compras. Outros exemplos do mesmo perfil: ouvidoria, comunicação e conselhos internos.

**Objetivos**
- Encontrar o processo e entender a situação em linguagem simples.
- Não correr o risco de alterar nada.

**Dores atuais**
- Liga para várias secretarias e recebe respostas desencontradas.
- Sistemas complexos demais para uma consulta simples.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Buscar processos; ler o painel situacional, a timeline e os documentos visíveis (valores sigilosos mascarados — DEC-030); seguir processos (`OBSERVER`) para receber notificações |
| 2 | Consultar relatórios |
| 4 | Consultar contratos |

**Telas principais:** SCR-004 Processos · SCR-006 Detalhe do Processo · SCR-003 Dashboard · SCR-036 Notificações.

**O que precisa ver primeiro ao entrar**
- Busca em destaque.
- Processos seguidos, com as mudanças recentes.

**Métricas de sucesso**
- Consulta de situação respondida em até 2 minutos.
- Nenhuma ação indisponível oferecida pela interface.

**Considerações de UX e acessibilidade**
- Ações que o usuário não pode executar não aparecem (DEC-134).
- Situação do processo resumida em uma frase; link interno compartilhável que respeita as permissões de quem abre.
- Leitura confortável no celular.

---

### P15 — Consultoria externa

**Bruno Carvalho** — Consultor sênior de uma empresa de consultoria em contratações públicas que atende seis municípios.

> "Atendo seis prefeituras. Preciso trabalhar rápido em todas sem nunca confundir o processo de uma com o de outra."

| Atributo | Valor |
|---|---|
| Perfil padrão | `CONSULTOR_EXTERNO` |
| Forma de acesso | Vínculo `EXTERNAL` com validade em cada tenant (DEC-012) + participação `CONSULTANT` com `expiresAt` em cada processo (DEC-036); sem escopo amplo de visualização |
| Frequência de uso | Diária, alternando entre entes |
| Dispositivo predominante | Desktop (notebook) |
| Letramento digital | Alto |

**Contexto organizacional.** Municípios pequenos dependem de consultoria para ETP, TR e pesquisa de preços. Uma única identidade (`User`) mantém vínculos com vários tenants e escolhe o ente ativo na sessão (DEC-012). Edita documentos em rascunho ou devolvidos; **nunca tramita nem aprova** — quem finaliza e encaminha é o servidor responsável (custódia, DEC-023).

**Objetivos**
- Produzir com qualidade e rapidez em vários entes.
- Reaproveitar o próprio conhecimento e registrar sua contribuição.
- Total isolamento entre clientes.

**Dores atuais**
- Recebe documentos por e-mail e WhatsApp; versões conflitantes.
- Não sabe a situação do processo depois que entrega.
- Às vezes usa a senha de um servidor (risco grave).
- Um sistema diferente em cada cliente.

**Tarefas principais na plataforma**

| MVP | Tarefas |
|---|---|
| 1 | Trocar o ente ativo; ver os processos em que é consultor; editar documentos em `DRAFT` ou `RETURNED` (DFD, ETP, mapa de riscos, pesquisa de preços, TR); comentar; anexar; acompanhar a validade do acesso |
| 2 | Apoiar a elaboração do PCA — exige mecanismo de acesso fora de processo (lacuna) |
| 5 | Usar o assistente e a busca de similares dentro do ente ativo |

**Telas principais:** seletor do ente ativo (cabeçalho) e SCR-039 Perfil (vínculos) · SCR-004 Processos (filtrada pelas participações) · SCR-006 Detalhe do Processo · SCR-007 DFD · SCR-008 ETP · SCR-009 Pesquisa de preços · SCR-011 Riscos · SCR-012 TR · SCR-013 Caixa de tarefas.

**O que precisa ver primeiro ao entrar**
- Ente ativo, de forma inconfundível.
- Processos em que participa, com pendências de edição.
- Acessos que expiram em breve.

**Métricas de sucesso**
- Tempo de elaboração de ETP e TR em queda.
- Menos rodadas de revisão por documento.
- Nenhum incidente de acesso entre entes; nenhuma senha compartilhada.

**Considerações de UX e acessibilidade**
- Indicação permanente do ente ativo (nome e identidade visual) e confirmação ao trocar.
- Aviso antecipado de expiração do vínculo e das participações.
- Troca de ente operável por teclado e anunciada por leitor de tela.

---

## 4. Matriz persona × fase da jornada (RACI simplificado)

**Legenda:** **R** = executa ou elabora · **A** = aprova ou decide formalmente · **C** = contribui ou é consultado · **I** = acompanha ou é informado · **—** = sem participação. O número entre parênteses indica o MVP em que a fase passa a ser conduzida na plataforma.

| Persona | PCA (2) | DFD (1) | ETP e riscos (1) | Pesquisa de preços (1) | TR (1) | Dotação (2) | Edital (2) | Análise jurídica (2) | Controle Interno (2) | Publicação (3) | Contrato e fiscalização (4) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Administrador do órgão¹ | — | — | — | — | — | — | — | — | — | — | — |
| Gestor de contratações | C | I | C | C | C | I | C | I | I | I | I |
| Área requisitante | C² | R | C | C | C | I | I | I | I | I | C |
| Planejamento | R | C | R | C | R | C | C | I | I | I | — |
| Compras | C | — | C | R | C | I | C | I | I | — | C |
| Licitações | I | — | I | I | C | I | R | C | I | R | C |
| Contabilidade | C | — | I | I | I | R | I | — | I | — | C |
| Jurídico / Procuradoria | — | — | C | — | C | — | C | R | I | — | C |
| Controle Interno | I | I | I | I | I | I | I | I | R | I | I |
| Autoridade competente | A | A³ | A⁴ | A⁴ | A⁴ | I | A | I | I | I | A |
| Fiscal de contrato | — | — | — | — | C | — | — | — | — | — | R |
| Gestor de contrato | — | — | C | — | C | — | — | — | — | — | R |
| Auditor | I | I | I | I | I | I | I | I | I | I | I |
| Usuário somente leitura | I | I | I | I | I | I | I | I | I | I | I |
| Consultoria externa | C⁵ | C | C | C | C | — | C | — | — | — | — |

1. Atua de forma transversal: configura estrutura, perfis, templates, workflow e integrações, sem participar do mérito dos processos.
2. A área requisitante propõe as demandas (DFDs) que alimentam o plano; o Planejamento consolida.
3. Aprovação na etapa `APROVACAO_DFD` pelo titular da secretaria solicitante (`DEPARTMENT_HEAD` — DEC-015), frequentemente o secretário que também é autoridade competente da pasta; o substituto pode decidir quando permitido.
4. ETP, mapa de riscos, pesquisa de preços e TR são aprovados em conjunto na etapa `APROVACAO_AUTORIDADE` (DEC-015).
5. Depende de mecanismo de acesso ao PCA fora de processo; DEC-036 cobre apenas participação em processos.

---

## 5. Matriz persona × MVP (relevância)

**Legenda:** **Alta** = público-alvo do MVP, uso intenso · **Média** = uso regular de funcionalidades do MVP · **Baixa** = uso pontual · **Leitura** = apenas consulta, sem tarefas próprias · **—** = sem uso.

| Persona | MVP 1 — Planejamento e Tramitação | MVP 2 — Governança e Controle | MVP 3 — Integrações e Publicação | MVP 4 — Gestão Contratual | MVP 5 — Inteligência e IA |
|---|---|---|---|---|---|
| Administrador do órgão | Alta | Média | Alta | Média | Média |
| Gestor de contratações | Alta | Alta | Média | Média | Alta |
| Área requisitante | Alta | Média | Baixa | Média | Média |
| Planejamento | Alta | Alta | Baixa | Baixa | Alta |
| Compras | Alta | Média | Baixa | Média | Alta |
| Licitações | Leitura | Alta | Alta | Média | Média |
| Contabilidade | Baixa | Alta | Média | Alta | Baixa |
| Jurídico / Procuradoria | Baixa | Alta | Média | Média | Média |
| Controle Interno | Média | Alta | Média | Média | Alta |
| Autoridade competente | Alta | Alta | Média | Média | Média |
| Fiscal de contrato | Leitura | Leitura | Baixa | Alta | Média |
| Gestor de contrato | Leitura | Leitura | Baixa | Alta | Média |
| Auditor | Alta | Média | Média | Alta | Baixa |
| Usuário somente leitura | Média | Média | Baixa | Média | Baixa |
| Consultoria externa | Alta | Média | Baixa | Baixa | Média |

**Leituras importantes**
- O **MVP 1** precisa encantar requisitante, planejamento, compras, gestor de contratações e autoridade — são eles que geram a North Star (processos concluídos na plataforma).
- **Fiscal e gestor de contrato** só ganham tarefas próprias no MVP 4; no MVP 1 têm leitura (DEC-035) e podem colaborar no TR como participantes.
- **Auditor e Controle Interno** têm leitura ampla e acesso à auditoria desde o MVP 1; o Controle Interno ganha etapa própria no MVP 2.
- **Consultoria externa** acessa exclusivamente por participação em processos com validade (DEC-036, DEC-012) — o MVP 1 já é de alto valor para ela.

---

## 6. Quem não é usuário e personas internas

| Ator | Situação no roadmap atual | Observação |
|---|---|---|
| Fornecedor / licitante | Não é usuário | Cotações chegam por e-mail ou documento e são registradas como evidência (`PriceSource`, `Quotation`). Portal do fornecedor e cotação eletrônica são candidatos futuros |
| Cidadão | Não é usuário | Transparência pelos canais oficiais (PNCP, diário oficial, portal do ente — MVP 3) |
| Tribunal de contas (instituição) | Acesso por pessoas | Auditores recebem vínculo `EXTERNAL` temporário (persona P13) ou exportações. Integração com sistemas estaduais de prestação de contas é candidata, fora do roadmap |
| Operador de suporte da plataforma | Interno | Sem acesso a dados por padrão; vínculo temporário de até 72 horas, auditado com `actorType = PLATFORM_OPERATOR` e visível ao administrador do tenant (DEC-139) |
| Implantação e Sucesso do Cliente | Interno | Conduz o onboarding ([visão do produto, §11.3](product-overview.md#113-provisionamento-e-onboarding)); acessa dados apenas pelo mesmo mecanismo do suporte |

---

## 7. Implicações transversais de design

1. **Página inicial por perfil.** O Dashboard (SCR-003) compõe blocos conforme os perfis do usuário, seguindo "o que precisa ver primeiro" de cada persona. Quem tem vários perfis vê a união priorizada: pendências comigo → atrasos → acompanhamento.
2. **Acúmulo de funções.** Em municípios pequenos, a mesma pessoa pode ser requisitante, planejamento e titular da unidade. A interface deve deixar claro em qual papel cada ação é feita, e o sistema continua bloqueando a autoaprovação (DEC-022).
3. **Baixo letramento digital** (Requisitante, Autoridade, Fiscal): wizards, poucos campos por passo, linguagem simples, ajuda contextual e confirmações claras (DEC-181, DEC-184).
4. **Celular para decidir e acompanhar.** Consulta, caixa de tarefas, notificações e aprovações plenamente utilizáveis a partir de 360 px; edição de documentos *desktop-first* (DEC-183). O registro de fiscalização em campo (MVP 4) exigirá decisão específica sobre conectividade.
5. **Acessibilidade.** WCAG 2.1 AA e eMAG 3.1 em todas as telas (DEC-183). Recomenda-se incluir servidores com deficiência nos testes de usabilidade com o piloto.
6. **Linguagem e rótulos.** Nenhum código técnico na interface; rótulos dos enums conforme a [terminologia](terminology.md#14-rótulos-de-enums-na-interface).
7. **Notificações sem fadiga.** Preferências por tipo e canal (`NotificationPreference`); priorizar o que exige ação. Resumo diário consolidado é uma melhoria a avaliar.
