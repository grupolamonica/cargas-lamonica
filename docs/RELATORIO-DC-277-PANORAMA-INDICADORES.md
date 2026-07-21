# Panorama da Plataforma + Indicadores de Uso — Lamonica Cargas

**Card:** [DC-277](https://gestaolamonica.atlassian.net/browse/DC-277) — *Documentação: Panorama dos projetos e indicadores de uso da plataforma* (Epic DC-276).
**Solicitante:** Danilo · **Consolidação:** Antonio César · **Frente de Mensageria/Cadastro:** Samuel (DC-262 / DC-243).
**Data:** 21/07/2026 · **Ambiente:** produção — `https://cargas.grupolamonica.com` (VPS + Docker + Traefik + CI/CD).

**Base do material:** [`RELATORIO-EVOLUCAO-SISTEMA.md`](./RELATORIO-EVOLUCAO-SISTEMA.md) (linha do tempo técnica, 11/06), [`RELATORIO-PLATAFORMA-PRODUTO-COMERCIAL.md`](./RELATORIO-PLATAFORMA-PRODUTO-COMERCIAL.md) (visão de produto, 30/06) e o deck de evolução (17/07), atualizados para 21/07. **Indicadores medidos diretamente no banco de produção** (mesma fonte da Epic DC-241) — tabelas e consultas no Anexo A.

> **Nota de método.** Cada frente é marcada como **🟢 em produção**, **🟡 parcial / em validação** ou **🔵 em construção**. Os indicadores usam números reais do banco; onde a medição tem limite (ex.: `booked_at` não populado, `request_ip` como proxy de visitante), o limite é declarado — números honestos sustentam a leitura de gestão.

---

## Sumário Executivo

Em ~3 meses de produção (17/04 → 21/07), a Lamonica Cargas consolidou-se como **plataforma logística de dois lados em operação real**: recebeu **18.863 acessos** ao portal do motorista, **movimentou ~25 mil eventos** rastreados, geriu **2.137 spots de carga** (Shopee + Nestlé + sistema) e registrou **638 aprovações de reserva pela fila/portal**. A base de cadastro passou de dezenas para **600 registros na esteira** e **105 cadastros automáticos concluídos** em portais de risco externos (Angellira/SPX), com forte aceleração em julho.

**Onde estamos por frente:**

| Frente | Estado | Leitura de uma linha |
|---|---|---|
| **Cargas** (Programação, Spots, Fila, Monitor, Portal) | 🟢 produção | Coluna vertebral: oferta, alocação e acompanhamento rodando diariamente |
| **Cadastro** (wizard v2 + automação externa) | 🟢🟡 | Automação de portais externos disparando; conversão do wizard ainda é o gargalo |
| **Torre de Controle / GR** (Galileu) | 🟡 em validação | Veredito de risco, tela de GR e cofre de credenciais em homologação |
| **Ranking** (vínculo/score do motorista) | 🟡 parcial | 127 motoristas classificados por vínculo; score operacional cruza com a Torre |
| **Mensageria** (padrão N8N — DC-262) | 🔵 em construção | Infra de disparo (Evolution) pronta; conexão do gateway em implantação |
| **Apoio:** SPX/Shopee, Angellira, Nestlé/Galileu, BRK | 🟢🟡 | Integrações que alimentam as frentes acima |

---

# Parte 1 — Status por frente

Para cada frente: **✔ o que já foi feito · ▶ em que passo está hoje · → próximos passos.**

## 1. Cargas — Programação, Spots Automáticos, Fila, Monitor e Portal 🟢

A frente mais madura e a que roda todo dia. Reúne a oferta de cargas, a alocação de motoristas e o acompanhamento operacional.

**✔ Feito**
- **Portal do motorista** (vitrine pública 24/7): busca por rota/veículo/data, valor + bônus + exigências, candidatura em poucos toques.
- **Fila / Reservas**: pré-cadastro → fila → aprovação pelo operador, com reserva atômica e alocação direta. Histórico exportável em CSV.
- **Monitor** (planilha viva ↔ sistema): sincronização bidirecional com a planilha Shopee, selo de risco vigente (Angellira/ASPX/SPX) na própria tela, alocação editável (fixo / cascata / trava por rota), reserva com histórico de rota, status operacional Rodopar.
- **Programação** (tela nova, jul/2026): viagens SPX/Shopee **ao vivo**, fonte **Nestlé** espelhada (coletor Galileu), aceite direto no painel, filtros multi-select (cliente/rota/status/lançado/aceito), importação de programação em lote com remediação de cliente/rota.
- **Spots automáticos (DC-201)**: auto-lançamento de spots quando a rota tem preço cadastrado, com botão liga/desliga (modal) por ciclo.
- **Cargas Casadas**: viagem composta (multi-stop) reservada como unidade atômica, com cascade-cancel.
- **Recorrência**: auto-avanço de cargas recorrentes + clone ao reservar, com auto-cura de cadeias órfãs.

**▶ Hoje**
- Programação SPX+Shopee+**Nestlé** consolidada; aceitação Shopee automática (**DC-200**) e conexão Nestlé (**DC-261**) em **validação**.
- Monitor com filtro por usuário (**DC-275**) em validação; ajustes de layout/ordenação (DC-179) no backlog.

**→ Próximos passos**
- **DC-204** — buscar preço de rotas internamente e cadastrar rotas automaticamente (alimenta o auto-lançamento de spots).
- **DC-202** (em andamento) — notificar motoristas por WhatsApp quando chegar spot (depende da Mensageria).
- **DC-247 / DC-225** — cascata ao descer motorista de carga cancelada + auditoria da troca de motorista/cavalo/carreta.

## 2. Cadastro — Wizard v2 + Automação Externa (CAM) 🟢🟡

Onboarding do motorista/veículo e o "moat" da operação: cadastro automático nos portais de gerenciamento de risco.

**✔ Feito**
- **Wizard v2** (candidatura a partir de carga **ou** avulso): multi-step, pula etapas já vigentes, cascata ANTT/RNTRC, OCR de documentos (Infosimples + GPT-4o Vision), drafts com retomada.
- **Automação Aprovar → portais externos (Epic DC-111)**: ao aprovar, o backend cria proprietário/cavalo/carreta/motorista no **Angellira** e faz onboarding no **SPX/Shopee Express**, de forma idempotente, com retry e circuit breaker.
- **Selos de aptidão** no perfil do motorista: Angellira, **SPX** (situação) e **BRK / Brasil Risk** (vigência), sincronizados de forma read-only.
- **Busca por nome/CPF/placa** na aba de cadastros pendentes; anexo de documentos.

**▶ Hoje**
- Cadastro automático externo **acelerando** (ver Parte 2, §4): 105 concluídos, forte salto em julho.
- **DC-195** (anexo obrigatório) e **DC-232** (relatório de motivos de abandono) em validação; **DC-198** (WhatsApp ao aprovar) em andamento.

**→ Próximos passos**
- **Elevar a conversão do wizard** — hoje a maioria dos cadastros v2 fica em rascunho (ver §4). Trabalho conduzido em DC-232 (abandono) + DC-181 (triagem/pendências).
- **DC-199** — avaliar Consulta Pancary; **DC-222** (em validação) — clareza de erros e saúde da sessão SPX no painel.

## 3. Torre de Controle / Gerenciamento de Risco (Galileu) 🟡

Cockpit de risco e da frota — GPS, dossiê, score operacional e ocorrências (`torre.grupolamonica.com`, sistema irmão que consome a plataforma).

**✔ Feito**
- **Integração Galileu (Epic DC-216)**: base do gerenciamento de risco conectada à operação.
- **Coletor Galileu** (`bots/galileu`): automação que traz a programação Nestlé para a plataforma (tabelas `nestle_ofertas` / `nestle_embarques`).
- Endpoint de consulta de risco em lote por placa e cruzamento de aptidão por nome/placa.

**▶ Hoje**
- **DC-234** (veredito de risco consolidado + feed de alertas), **DC-235** (tela de risco: Motoristas/Veículos/Alertas) e **DC-236** (cofre de credenciais do rastreador) em **validação**.

**→ Próximos passos**
- Concluir a tela de GR e o feed de alertas; **DC-248** — sincronizar escopo do cadastro puxado; documentação do Projeto Galileu (**DC-267/268/269**).

## 4. Ranking (Lamonica Ranking) 🟡

Posição / pontuação / vínculo / status do motorista — insumo de priorização e reputação, cruzado com a Torre.

**✔ Feito**
- **Classificação por vínculo** de **127 motoristas** (FROTA, AGREGADO DEDICADO, PX, PME) exposta na fila do operador (entregue no PR #48).
- Base de motoristas conhecida de **1.851 registros** (histórico Angellira/ASPX), com 1.192 com correspondência ASPX.

**▶ Hoje**
- Vínculo já visível na operação; score operacional é calculado no ecossistema da Torre.

**→ Próximos passos**
- Consolidar posição/pontuação numa visão única de ranking (definição de produto com a gestão).

## 5. Mensageria — padrão N8N (DC-262) 🔵

Camada de comunicação automática com o motorista (reserva, spot, cadastro aprovado). **Frente do Samuel.**

**✔ Feito**
- **Fundação driver-outreach**: detecção de gatilhos, tabelas de opt-out/log, templates de mensagem editáveis, guardrails anti-ban (drip, cap horário/diário, jitter, spintax).
- **Envio via Evolution** com fila (Wave B/C), tela de controle do operador e captura do QR do WhatsApp por webhook.
- Tela de oportunidades clicáveis + modal de cargas por motorista.

**▶ Hoje**
- **DC-262** (tela de mensageria padrão N8N) em andamento. Infra pronta; **32 tentativas** de disparo registradas (gatilho de reserva), ainda **falhando** — o gateway não está conectado de forma estável em produção. Estado: **em implantação, não em produção**.

**→ Próximos passos**
- Estabilizar a conexão do gateway e ligar em produção os gatilhos já prontos (todos já iniciados no board): **DC-192** (ao reservar, em validação), **DC-202** (spot, em andamento), **DC-198** (cadastro aprovado, em andamento).
- **DC-176** — avaliar migração para a API Oficial do WhatsApp (decisão da diretoria).

## 6. Frentes de apoio (integrações que sustentam as demais)

| Frente | Estado | O que entrega |
|---|---|---|
| **SPX / Shopee** | 🟢 | Programação ao vivo + aceite no painel; cadastro no SPX; login headless com self-heal de cookie/sessão |
| **Angellira** | 🟢 | Validação e cadastro no GR; selo de aptidão vigente |
| **Nestlé / Galileu** | 🟡 | Coletor traz ofertas (**9.112** ofertas coletadas) e espelha na Programação |
| **BRK / Brasil Risk** | 🟢 | Cookie automático + consulta de aptidão + selo de vigência |

---

# Parte 2 — Indicadores de uso (evolução no tempo)

Período coberto: **17/04 → 21/07/2026**. Julho é **parcial** (21 dias). Fuso: America/São_Paulo. Fontes no Anexo A.

## 1. Movimentos no site

Volume total de eventos/movimentações rastreados na plataforma.

| Tipo de movimento | Fonte | Total |
|---|---|---:|
| Acessos ao portal do motorista | `driver_portal_visits` | **18.863** |
| Eventos de funil (candidatura → fila → aprovação) | `load_public_lead_events` | **5.295** |
| Reservas registradas no Monitor | `monitor_reservas` | **225** |
| Visualizações de região do motorista | `analytics_events` | **768** |
| Cliques em patrocinadores | `analytics_events` | **170** |
| **Total de movimentos rastreados** | | **≈ 25.321** |

> A tabela `analytics_events` — citada como base no card — hoje só captura **cliques de patrocinador** (170) e **visualização de região** (768, coletada em mai/2026). O grosso do movimento real está em tabelas dedicadas (`driver_portal_visits`, `load_public_lead_events`). **Recomendação de instrumentação:** unificar a captura de eventos de página em `analytics_events` (fecha a lacuna medida pela Epic DC-241 / DC-242).

## 2. Acessos à plataforma

Acessos ao portal do motorista, por mês, com média diária e tendência. *(Base: `driver_portal_visits`, uma linha por visita.)*

| Mês | Acessos | Dias ativos | Média/dia | IPs distintos |
|---|---:|---:|---:|---:|
| Abr/2026 (parcial) | 1.428 | 11 | 129,8 | 926 |
| Mai/2026 | **8.650** | 31 | **279,0** | 5.262 |
| Jun/2026 | 5.195 | 30 | 173,2 | 3.137 |
| Jul/2026 (até 21) | 3.590 | 21 | 171,0 | 2.234 |
| **Total** | **18.863** | 93 | **≈ 203/dia** | 11.030 (distintos no período)¹ |

¹ *11.030 = IPs distintos deduplicados no período inteiro (não a soma das colunas mensais, que seria 11.559, pois o mesmo IP reaparece em meses diferentes).*

**Leitura da evolução.** Pico de audiência em **maio** (8.650 acessos, 279/dia) — mês de lançamento e da coleta de visualização de região. Estabilização em torno de **~170 acessos/dia** em jun–jul, com média móvel de **164/dia nos últimos 30 dias** e **pico de 292 acessos em 15/07**. Julho (parcial) já soma 3.590 e mantém o patamar. Ou seja: depois do pico de lançamento, o portal firmou um **piso diário consistente de tráfego** — sinal de uso recorrente, não de curiosidade pontual.

## 3. Cargas fechadas

"Fechar carga" na plataforma tem dois recortes; apresentamos ambos, com honestidade sobre a medição.

### 3a. Aprovações de reserva pela fila/portal *(sinal nativo da plataforma)*

Reservas que o operador **aprovou** (o motorista fechou a carga pelo fluxo digital). *(Base: `load_public_leads.approved_at`.)*

| Mês | Aprovações |
|---|---:|
| Abr/2026 | 18 |
| Mai/2026 | 117 |
| Jun/2026 | **258** |
| Jul/2026 (até 21) | 245 |
| **Total** | **638** |

**Leitura.** Crescimento consistente: **18 → 117 → 258 → 245** (jul parcial já quase iguala jun). É o indicador mais limpo de "negócio fechado pela plataforma" e está em **trajetória de alta**.

### 3b. Spots de carga geridos na plataforma *(oferta total, inclui espelho de planilha)*

Cargas criadas por fonte. *(Base: `cargas.created_at` × `sheet_source`.)*

| Mês | Shopee | Nestlé | Sistema | Total |
|---|---:|---:|---:|---:|
| Abr/2026 | 4 | – | 234 | 238 |
| Mai/2026 | 396 | – | 205 | 601 |
| Jun/2026 | 586 | – | 49 | 635 |
| Jul/2026 (até 21) | 447 | 94 | 122 | 663 |
| **Total** | 1.433 | 94 | 610 | **2.137** |

Situação atual do estoque de cargas: **1.688 fechadas (BOOKED)**, 355 expiradas, 82 abertas, 6 canceladas, 4 reservadas, 2 em rascunho — total **2.137**.

> **Limite de medição.** A coluna `booked_at` não é populada no espelhamento de planilha, então não há série temporal direta de "fechamento" para as cargas Shopee/Nestlé — por isso usamos as **aprovações de reserva (§3a)** como série de fechamento nativo. As cargas Shopee/Nestlé (1.527) refletem a operação real espelhada da planilha; as 610 "sistema" nascem na plataforma. **Instrumentação sugerida (DC-244):** popular `booked_at` no sync para medir fechamento por período em todas as fontes.

## 4. Cadastros feitos pelo sistema

Cadastros de motorista processados pela plataforma, por origem. *(Base: `pending_driver_registrations` + `external_registration_jobs` + `driver_profiles`.)*

### 4a. Esteira de cadastro (600 registros)

| Origem | Registros | O que é |
|---|---:|---|
| `bot-migracao-v1` | **330** | Carga inicial da base migrada em massa pelo robô |
| `v2` (wizard) | **225** | Cadastro feito pelo motorista no celular (wizard v2) |
| `bot-runtime-v1` | 45 | Cadastro em runtime via robô |
| **Total** | **600** | |

**Conversão do wizard v2** (o gargalo honesto):

| Mês | Iniciados (rascunho) | Finalizados |
|---|---:|---:|
| Mai | 18 | 0 |
| Jun | 98 | 5 |
| Jul (até 21) | 102 | 2 |
| **Total** | **218** | **7** |

**Leitura.** O motorista **abre** o wizard (218 rascunhos), mas **poucos concluem** (7 finalizados). A massa da base entrou por **migração/robô**, não pelo autoatendimento. Esse é o principal ponto de trabalho de produto (DC-232 analisa os motivos de abandono).

### 4b. Cadastro automático em portais de risco (Epic DC-111)

Cadastros disparados automaticamente ao aprovar, nos portais externos. *(Base: `external_registration_jobs`.)*

| Mês | Angellira (OK) | SPX (OK) | Erros | Total tentativas |
|---|---:|---:|---:|---:|
| Jun/2026 | 13 | 1 | 5 | 19 |
| Jul/2026 (até 21) | **78** | 13 | 43 | 137 |
| **Total** | **91** | **14** | 48 | 156 |

**Leitura.** **Salto de escala em julho** — de 14 concluídos em junho para **78 concluídos** só em julho no Angellira (91 no acumulado das duas medições). Total geral: **105 cadastros automáticos concluídos** (Angellira + SPX; 67% de sucesso sobre 156 tentativas — os erros são majoritariamente sessão SPX expirada e duplicidade, tratados em DC-222, em validação). É a automação que mais **elimina trabalho manual** de re-digitação em portais de risco.

Perfis de motorista com login no portal (`driver_profiles`): **32** (5 em jun, 27 em jul).

---

## Critério de aceite (DC-277)

- [x] **Material cobrindo as 2 partes** — Parte 1 (status por frente) + Parte 2 (indicadores).
- [x] **Cada frente com status atual + próximos passos** — 6 frentes (Cargas, Cadastro, Torre/GR, Ranking, Mensageria, Apoio) no formato Feito/Hoje/Próximos.
- [x] **Cada indicador com números por período (mês/dia) e leitura de evolução** — Movimentos, Acessos, Cargas fechadas, Cadastros, com tabelas mensais e tendência.
- [x] **Reaproveita a fonte de dados da Epic DC-241** — mesmas tabelas de produção (Anexo A).
- [x] **Formato final** — documento (este arquivo) **+** apresentação (deck HTML executivo).

---

## Observações e recomendações de instrumentação

1. **Unificar `analytics_events`** para capturar page views/visitas (hoje só sponsor click + region view) — fecha a lacuna de "acessos" da DC-242.
2. **Popular `booked_at`** no sync de planilha (DC-244) para medir fechamento de carga por período em todas as fontes.
3. **Mensageria em produção** é o desbloqueio de maior alavancagem: liga os gatilhos WhatsApp (reserva/spot/cadastro) que hoje estão prontos mas inativos.
4. **Conversão do wizard** (7/218 finalizados) é o principal gargalo de captação — priorizar DC-232/DC-181.
5. `request_ip` é um proxy grosseiro de "visitante único" (NAT/operadora agrupam IPs); tratar "IPs distintos" como ordem de grandeza, não headcount.

---

## Anexo A — Fontes de dados (produção)

Todos os números da Parte 2 vêm do banco de produção (Supabase `lbpzkdec`), agregados por `AT TIME ZONE 'America/Sao_Paulo'`:

| Indicador | Tabela(s) | Coluna de tempo |
|---|---|---|
| Acessos | `driver_portal_visits` | `visited_at` |
| Movimentos / funil | `load_public_lead_events`, `analytics_events`, `monitor_reservas` | `created_at` |
| Cargas fechadas (nativo) | `load_public_leads` | `approved_at` |
| Cargas / spots | `cargas` (`sheet_source`) | `created_at` |
| Cadastros (esteira) | `pending_driver_registrations` | `created_at`, `versao_cadastro`, `status` |
| Cadastro automático | `external_registration_jobs` | `created_at`, `target`, `status` |
| Perfis / base | `driver_profiles`, `motoristas_historico`, `driver_vinculos` | `created_at` |

*Documento consolidado para DC-277. Parte 1 atualizada a partir dos relatórios de evolução (11/06) e de produto (30/06) + histórico Git e board Jira até 21/07. Parte 2 medida diretamente na produção em 21/07/2026.*
