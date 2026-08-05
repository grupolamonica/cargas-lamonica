# Guia dos indicadores — Painel de TV da Operação

Para quem acompanha a TV: o que cada painel significa, o que é normal e **que ação tomar** quando mudar de cor.

## Como ler a TV (regra geral)

- **Verde = ok · Amarelo = atenção (anotar/observar) · Vermelho = agir.**
- A TV cicla entre 2 telas a cada 45s: **Operação** (o sistema e o negócio) e **Infra** (servidores e detalhes técnicos).
- Regra de bolso: 1 painel vermelho → seguir a ação da tabela. Vários vermelhos ao mesmo tempo → o site provavelmente caiu: confirmar e acionar o responsável técnico **imediatamente**.
- "Acionar TI" neste guia = chamar o responsável técnico (Danilo).

---

## Tela 1 — OPERAÇÃO

### Linha 1 — O sistema está no ar?

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **Site (cargas.grupolamonica.com)** | Um robô abre o site de fora a cada 30s, como um usuário real (inclui teste do banco) | **FORA DO AR**: confirme abrindo o site no celular pelo 4G (fora do wifi). Se realmente caiu → acionar TI **na hora**. É o alerta mais grave da TV |
| **Backend** | A API (motor do sistema) respondendo | **FORA**: o site pode até abrir, mas nada funciona (login, cargas, cadastro). Aguarde 1–2 min (religa sozinho); se não voltar → TI na hora |
| **Bots (Angellira · SPX · Unificada · OCR)** | Os 4 robôs de integração | **FORA** em qualquer um: cadastros aprovados param de subir para aquele sistema / OCR de documentos falha no wizard. → TI no mesmo dia |
| **Uptime do backend** | Tempo desde o último reinício | Amarelo (<1h) logo após um deploy é **normal**. Amarelo **sem** deploy conhecido = reinício inesperado → avisar TI. Zerando toda hora = grave |
| **Erros 5xx agora** | % de requisições falhando com erro do servidor (últimos 5 min) | Amarelo (>1%): observar se persiste. **Vermelho (>5%): usuários estão vendo tela de erro agora** → TI na hora |

### Linha 2 — Tráfego e velocidade

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **Requisições/s** | Volume de uso do sistema | Não tem certo/errado — aprenda o padrão do dia. Zerado com site NO AR = suspeito (divulgação parou? link quebrado?). Pico gigante fora de hora = cruzar com % 5xx e latência (pode ser robô/ataque) |
| **% erros 5xx (gráfico)** | Histórico do painel de erros | Pico curto e isolado (deploy) é normal. **Sustentado** = problema real → TI |
| **Latência p95** | Tempo de resposta que cobre 95% dos usuários | <1s ótimo. Acima de **3s persistente** = sistema lento para valer → cruzar com pool/CPU na tela Infra e avisar TI |

### Linha 3 — Banco de dados (o coração)

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **Fila do pool pg (waiting)** | Pedidos **esperando** vaga para falar com o banco | **0 = saudável.** 1–2 = começo de saturação (observar). **≥3 sustentado = o sistema vai travar → TI urgente** |
| **Pool pg (conexões vs teto)** | Conexões do backend vs máximo (20, linha tracejada) | Encostando no tracejado o tempo todo = investigar queries lentas / aumentar pool → TI |
| **Memória do backend (RSS)** | Memória em uso pela API | Sobe-e-desce cíclico é normal. **Rampa contínua sem descer** = vazamento; perto de 320 MiB+ crescendo → TI (vai reiniciar sozinho) |
| **Supabase — conexões** | Total de conexões abertas no banco (máx **90**) | **≥70 amarelo, ≥80 vermelho → risco real de o site cair → TI urgente** |
| **Supabase — disco usado** | % do disco do banco | ≥70% = planejar upgrade (sem pressa). ≥85% = agir na semana → TI |

### Linha 4 — Operação e custos

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **Automação com ERRO (24h)** | Cadastros aprovados que **falharam** ao subir para Angellira/SPX/Unificada | **≥1 (vermelho): a própria operação resolve** → painel do operador → *Cadastros com erro* → reprocessar/corrigir. Se o erro repetir no mesmo cadastro → TI |
| **Acessos hoje** | Visitas de motoristas ao portal (contagem real, 1 por pessoa a cada 30s) | Padrão típico: ~250–330/dia. Muito abaixo em dia útil = checar divulgação/WhatsApp/link |
| **Motoristas únicos hoje** | Quantos motoristas diferentes acessaram | Padrão típico: ~170–225/dia. Mesma leitura acima |
| **Supabase — egress 30d** | Banda consumida da cota mensal do banco (**250 GB** no plano Pro) | Amarelo (200 GB): revisar o que está consumindo → TI. Vermelho (250 GB): custo extra/risco de bloqueio → TI + gestão |
| **Supabase — egress (taxa)** | Consumo de banda em tempo real | Pico grande fora de horário comercial = investigar (export? robô?) |

---

## Tela 2 — INFRA

### Linha 1 — O servidor e o site vistos de fora

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **VPS — CPU / RAM / disco** | Saúde do servidor onde tudo roda | CPU >70% ou RAM >80% **sustentado** → TI. **Disco >75% → TI na semana** (disco cheio derruba tudo de uma vez) |
| **Certificado TLS (dias p/ vencer)** | Validade do "cadeado" do site — renova sozinho ~30 dias antes | **Amarelo (<21 dias) = a renovação automática travou** → TI. Se chegar a 0, o site mostra erro de segurança para todo mundo |
| **Latência do site visto de fora** | O "ping" completo do site, incluindo banco | Normal ~100–250 ms. Picos >2s frequentes = internet/servidor sofrendo → observar; se persistir → TI |

### Linha 2 — Quem está pesando?

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **CPU por container** | Consumo de processador de cada peça (backend, site, cada bot) | Um container destoando muito dos demais = suspeito → TI investiga |
| **RAM por container** | Idem para memória | Rampa contínua num container = vazamento → TI |

### Linha 3 — Tráfego detalhado

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **Tráfego por serviço** | Divide as requisições entre site, API, OCR (e os vizinhos torre/riderank no mesmo servidor) | Ajuda a localizar onde está um pico ou uma queda |
| **% erros 4xx** | Erros "do cliente" (sessão expirada, dados inválidos) | Tem baseline normal — olhe a **tendência**. Salto repentino = fluxo quebrou (ex.: após deploy) ou tentativa de invasão → TI |
| **Latência p50/p95/p99** | A régua completa de velocidade: típico / maioria / piores casos | p50 alto = **tudo** lento (grave). p99 alto com p50 baixo = alguns endpoints pesados (investigar sem urgência) |

### Linha 4 — Banco em detalhe e logs

| Painel | O que é | Ação quando alertar |
|---|---|---|
| **VPS — rede** | Tráfego de rede do servidor | Pico anormal fora de hora = investigar |
| **Supabase — disco (IOPS)** | Atividade de leitura/escrita do banco | Picos em sync/ETL são normais; alto o tempo todo = queries pesadas → TI |
| **Supabase — CPU e RAM** | O servidor do banco em si | >80% sustentado = plano do Supabase ficando pequeno → TI + gestão (upgrade) |
| **Erros nos logs (por serviço)** | Quantas linhas de erro cada peça está escrevendo nos logs | Serviço com barras **contínuas** = investigar → TI. |

---

## Cola rápida — "vi X, faço Y"

| Vi na TV | Faço |
|---|---|
| Site **FORA DO AR** | Confirmar no 4G → **TI na hora** |
| **Erros 5xx vermelho** | **TI na hora** (usuários vendo erro) |
| **Fila do pool ≥3** ou **conexões ≥80** | **TI urgente** (queda iminente) |
| **Automação com ERRO ≥1** | **Operação resolve**: painel do operador → Cadastros com erro |
| Bot FORA / Uptime zerando sem deploy | TI no mesmo dia |
| Disco (VPS ou Supabase) vermelho | TI na semana |
| Egress amarelo/vermelho | TI + gestão (custo) |
| Acessos muito abaixo do padrão | Checar divulgação/WhatsApp/link |
| Qualquer amarelo persistente | Anotar horário + print → avisar TI sem urgência |

> Dúvidas técnicas ou ajuste de painel: ver [monitoring/README.md](./README.md). Guia gerado em 2026-07-31 junto com a implantação do painel.
