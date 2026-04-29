# Backlog de Campos — Cadastro de Motorista PJ

> Gap analysis entre o guia oficial do AngelLira e o que já está implementado em [`/cadastro`](frontend/src/pages/CadastroDocumentos.tsx).

**Legenda:** ✅ pronto · ⚠️ parcial · ❌ falta

---

## 0. Cabeçalho do cadastro (antes das abas)

| Campo | Status | Onde encaixar |
|---|---|---|
| Tag de pedágio (Sem Parar / ConectCar / Move Mais / Veloe / Endered / Não possui) | ❌ | **Nova section "Operacional"** no topo da aba **Cavalo** (ou nova aba "Operacional") com `select`. Salva em `form.cavalo.tag_pedagio` |
| Possui Pancary? (Sim/Não) | ❌ | Mesma section "Operacional", `checkbox` em `form.cavalo.possui_pancary` |
| Tipo de composição (Sem carreta / 1 carreta / 2 carretas Bitrem) | ⚠️ | **Nova radio no topo da aba Carreta**. Substitui o checkbox atual `carreta_proprietario_diferente` por uma escolha de composição. Mapeia direto pra `carretas_extras.length`: `sem` → 0+exclui carreta principal; `1` → carreta principal; `bitrem` → carreta principal + 1 extra obrigatória |
| Rastreador | ❌ | Nova section "Rastreador" — provável `select` (marca) + `numero` + `arquivo` (foto/contrato). Pode ficar na aba Cavalo |

---

## 1. Aba Motorista

| Campo | Status | Onde já está / o que falta |
|---|---|---|
| É o mesmo proprietário do cavalo? (Sim/Não) | ✅ | Checkbox `motorista.tambem_proprietario` na aba Motorista |
| CNH digital (PDF) | ✅ | `arquivos.cnh` + OCR auto-extrai 9 campos |
| Comprovante de residência (PDF) | ✅ | `arquivos.comprovante_motorista` + OCR + consulta CEP |
| **Selfie segurando a CNH** | ❌ | **Novo upload** `arquivos.selfie_cnh` na aba Motorista, sem OCR (validação manual) |
| Telefone | ✅ | `motorista.telefones[]` (array dinâmico, formato 10 ou 11 dígitos) |

---

## 2. Aba Cavalo

| Campo | Status | Observação |
|---|---|---|
| Placa | ✅ | Validação Mercosul/antiga + cross-check OCR |
| CRLV digital (PDF) | ✅ | `arquivos.crlv_cavalo` + OCR |
| **ANTT (PDF — documento separado)** | ⚠️ | Hoje só temos o **número RNTRC** (consultado via API). Falta upload do **PDF do RNTRC**. Adicionar `arquivos.antt_cavalo` — opcional |

---

## 3. Aba Proprietário (cavalo)

> Aplica-se quando proprietário é diferente do motorista. Mesma estrutura para PF e PJ.

| Campo | Status | Onde encaixar |
|---|---|---|
| Tipo de pessoa (PF / PJ) | ✅ | Toggle propTipo |
| CNH / RG (PDF) | ✅ | `arquivos.cnh_proprietario` + flag `tem_cnh` |
| Comprovante de residência | ✅ | `arquivos.comprovante_proprietario` + OCR |
| **Cartão PIS (número)** | ❌ | Novo campo numérico `proprietario_pf.cartao_pis` (11 dígitos) |
| **Estado civil (6 opções)** | ❌ | Novo `select` `proprietario_pf.estado_civil` (Solteiro / Casado / Divorciado / Viúvo / Separado / União Estável) |
| **Cor/Raça (6 opções)** | ❌ | Novo `select` `proprietario_pf.cor_raca` (Branca / Preta / Parda / Amarela / Indígena / Não Declarado) |
| **Dados bancários (banco, agência, conta, tipo)** | ❌ | Novo grupo de 4 campos: `proprietario_pf.banco{nome,codigo}`, `agencia`, `conta`, `tipo` (Corrente/Poupança) |
| Telefone | ✅ | `proprietario_pf.telefones[]` |
| Cartão CNPJ (PDF — se PJ) | ✅ | `arquivos.cartao_cnpj` + OCR + consulta Receita |
| **Inscrição Estadual (ou "ISENTO")** | ❌ | Novo `proprietario_pj.inscricao_estadual` (string com flag/checkbox "Isento") |

---

## 4. **Proprietário da ANTT do Cavalo** (NOVO BLOCO)

> Conceito novo: o **transportador no RNTRC** pode ser diferente do **proprietário do veículo no CRLV**. Comum em frota terceirizada (motorista TAC dirige veículo de empresa registrada na ANTT como ETC).

| Campo | Status | Onde encaixar |
|---|---|---|
| Mesmo proprietário do cavalo? (Sim/Não) | ❌ | Checkbox `proprietario_antt_cavalo_igual` no topo do bloco. Se `true` → reaproveita os dados do bloco anterior |
| Se diferente: tipo PF/PJ | ❌ | Mesma estrutura do "Proprietário do cavalo" |
| Todos os mesmos campos | ❌ | Replica os 10 campos do bloco anterior |

**Onde:** **nova section** "Proprietário da ANTT (cavalo)" na aba **Proprietário**, abaixo do bloco atual de "Proprietário do cavalo".

---

## 5. Carreta 1 (e adicionais)

| Campo | Status | Observação |
|---|---|---|
| CRLV (PDF) | ✅ | `arquivos.crlv_carreta` + OCR |
| **ANTT (PDF)** | ❌ | Falta upload do PDF do RNTRC da carreta. Adicionar `arquivos.antt_carreta` |
| Proprietário (mesmo do cavalo?) | ⚠️ | Hoje temos `carreta_proprietario_diferente` (binário). Funciona, mas **falta cobrir o caso "proprietário da ANTT é diferente"** |
| Proprietário da ANTT (mesmo da carreta?) | ❌ | Mesmo conceito do item 4. Novo bloco condicional |

---

## 6. Carreta 2 — Bitrem

| Campo | Status |
|---|---|
| Existência da Carreta 2 | ⚠️ Já temos `carretas_extras[]` (array de N carretas), mas falta amarrar com a opção "Bitrem" do **tipo de composição** (item 0) |
| CRLV + ANTT | ⚠️ CRLV ok via OCR. ANTT (PDF) falta |
| Proprietário Carreta 2 | ⚠️ Hoje carretas extras compartilham proprietário com a principal. Falta opção de proprietário independente |
| Proprietário da ANTT Carreta 2 | ❌ Novo |

---

## Resumo do que precisa ser adicionado (priorizado)

### 🔴 Alta prioridade (afeta o JSON final)

| # | Campo | Aba | Tipo |
|---|---|---|---|
| 1 | **Tipo de composição** | Carreta (header) | Radio: sem / 1 / bitrem |
| 2 | **Selfie segurando CNH** | Motorista | Upload |
| 3 | **ANTT PDF (cavalo + carreta)** | Cavalo / Carreta | Upload |
| 4 | **Cartão PIS** (proprietário PF) | Proprietário | Texto numérico (11 dígitos) |
| 5 | **Estado civil** | Proprietário PF | Select |
| 6 | **Cor/Raça** | Proprietário PF | Select |
| 7 | **Dados bancários** | Proprietário | Grupo (banco, agência, conta, tipo) |
| 8 | **Inscrição Estadual** | Proprietário PJ | Texto + checkbox "ISENTO" |
| 9 | **Proprietário da ANTT** (cavalo + carreta) | Proprietário | Bloco novo replicado |

### 🟡 Média prioridade (operacional)

| # | Campo | Aba | Tipo |
|---|---|---|---|
| 10 | Tag de pedágio | Cavalo | Select 6 opções |
| 11 | Possui Pancary | Cavalo | Checkbox |
| 12 | Rastreador | Cavalo | Grupo (marca + número + arquivo) |

### 🟢 Refinamentos

- Substituir `carreta_proprietario_diferente` (boolean simples) por **escolha "tipo de composição"** mais explícita
- Permitir cada carreta extra ter proprietário próprio (hoje compartilha com principal)

---

## Mapeamento JSON sugerido

Esquema atual + extensões (sem quebrar compatibilidade existente):

```jsonc
{
  // ── Já existente ──
  "id_cadastro": "",
  "carreta_proprietario_diferente": false,
  "arquivos": {
    "cnh": "", "crlv_cavalo": "", "crlv_carreta": "",
    "comprovante_motorista": "", "comprovante_proprietario": "",
    "cartao_cnpj": "", "cnh_proprietario": "",
    "cartao_cnpj_carreta": "", "cnh_proprietario_carreta": "",

    // ── Novos uploads ──
    "selfie_cnh": "",
    "antt_cavalo": "",
    "antt_carreta": ""
  },
  "motorista": { /* já existe + */
    "tag_pedagio": "",          // ← novo (1-6)
    "possui_pancary": false     // ← novo
  },
  "cavalo": { /* já existe + */
    "tag_pedagio": "",
    "possui_pancary": false,
    "rastreador": {             // ← novo grupo
      "marca": "",
      "numero": "",
      "arquivo": ""
    }
  },
  "tipo_composicao": "1_carreta",  // ← novo: "sem" | "1_carreta" | "bitrem"

  // ── Bloco proprietário PF estendido ──
  "proprietario_pf": { /* já existe + */
    "cartao_pis": "",
    "estado_civil": "",       // 6 opções
    "cor_raca": "",           // 6 opções
    "dados_bancarios": {      // ← novo grupo
      "banco_codigo": "",
      "banco_nome": "",
      "agencia": "",
      "conta": "",
      "tipo": ""              // "corrente" | "poupanca"
    }
  },

  "proprietario_pj": { /* já existe + */
    "inscricao_estadual": "",  // texto ou "ISENTO"
    "isento_ie": false,
    "dados_bancarios": { /* mesma estrutura acima */ }
  },

  // ── Novo bloco: proprietário da ANTT (transportador no RNTRC) ──
  "proprietario_antt_cavalo_igual": true,  // se true, reaproveita proprietario_*
  "proprietario_antt_cavalo": {
    "tipo": "",  // "PJ" | "PF"
    "pj": { /* mesmos campos de proprietario_pj */ },
    "pf": { /* mesmos campos de proprietario_pf */ }
  },

  // ── Carretas extras (já implementado, estender com proprietário individual) ──
  "carretas_extras": [
    {
      "veiculo": { /* já existe */ },
      "arquivo_crlv": "",       // já existe
      "arquivo_antt": "",       // ← novo
      "proprietario_diferente": false,  // ← novo
      "proprietario_pj": { /* mesma estrutura */ },
      "proprietario_pf": { /* mesma estrutura */ },
      "proprietario_antt_igual": true,
      "proprietario_antt": { /* opcional */ }
    }
  ]
}
```

---

## Plano de execução sugerido

**Etapa 1 (rápida) — campos simples sem lógica nova**
- Cartão PIS, Estado civil, Cor/Raça, Inscrição Estadual no `proprietario_pf` e `proprietario_pj`
- Selfie da CNH (upload novo)
- ANTT PDF (cavalo + carreta) — uploads novos

**Etapa 2 (média) — grupos novos**
- Dados bancários (1 sub-section reutilizada para PF e PJ)
- Tag de pedágio + Possui Pancary
- Rastreador

**Etapa 3 (maior) — lógica nova**
- Tipo de composição (substituir checkbox atual por radio com 3 opções)
- Bloco "Proprietário da ANTT" (cavalo + cada carreta) — replica estrutura existente

**Etapa 4 (refinamento)**
- Cada carreta extra com proprietário próprio (atualmente compartilha)

---

**Próximo passo:** me confirma quais etapas/itens você quer que eu comece a implementar (pode ser tudo da Etapa 1 numa tacada, ou ir item por item).
