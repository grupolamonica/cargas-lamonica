# Monitor → Planilha (write-back em tempo real)

Por padrão o sistema **lê** a planilha (export CSV) e grava a alocação só no banco
(`cargas.alloc_*`). O write-back é **opcional** e, quando ligado, espelha cada
edição do Monitor (combobox inline, modal e arrastar) **de volta** na planilha,
em tempo real.

## Como funciona

- `backend/src/application/google-sheets/sheet-writeback.js` →
  `writeAllocationsToSheet(updates)` faz um POST best-effort pra um endpoint
  (Apps Script web app). **Nunca lança**: o banco é a fonte da verdade; se a
  planilha falhar, a edição já está salva e só logamos um aviso.
- Ligado **apenas** se `GOOGLE_SHEET_WRITEBACK_URL` estiver setado (senão no-op).
- Escreve o valor **efetivo** (`alloc_* ?? sheet_*`) nas colunas Motoristas/CAVALO/CARRETA
  (E/F/G) da linha do LH; `status` (L) e `vínculo` (H) só quando enviados. `""` limpa a célula.
- No **update** também grava `dataCarregamento` (C), `dataDescarga` (D), `origem` (I) e
  `destino` (J) quando enviados — usado pelo **sync de status ASPX** (`reconcile-aspx-status.js`,
  DC-316; ver [DC-316-aspx-status-backend.md](./DC-316-aspx-status-backend.md)).
- Wired em `update-monitor-allocation.js` (inline/modal), `reassign-monitor-allocations.js`
  (arrastar) e `reconcile-aspx-status.js` (sync ASPX), **após** o commit no banco.

> **Reimplante necessário para o sync ASPX:** a versão anterior do `doPost` só gravava
> datas/origem/destino no **create**. O bloco `if (!u.createOnly)` abaixo passou a gravar
> C/D/I/J também no **update** — recole e reimplante (**Nova versão**) antes de ligar
> `ASPX_STATUS_RECONCILE_ENABLED=true`. Status + motorista/cavalo/carreta já funcionavam.

### Modos por `update` (carga do SISTEMA lançada na Programação — `lh_manual`)

Uma carga do sistema entra na planilha como **"linha-casca"** (LH + rota + agenda,
**sem** motorista) e só quando a viagem está **ACEITA** (SPX `acceptance_status=1`
ou Nestlé na aba Aceito). O motorista é preenchido depois pela alocação do Monitor.
Cada `update` pode carregar uma flag:

- **(padrão)** — preenche a linha do LH (E/F/G + status/vínculo). Alocação do Monitor.
- **`createOnly`** — cria a linha se o LH **não** existe; se **já** existe, **não toca**
  (não apaga o motorista já preenchido). Usado no **lançamento** (`launch-cargo-from-trip.js`,
  manual + auto DC-201) e no **aceite** (`accept-aspx-trips.js`), passando a linha completa
  (`lh, tipo, dataCarregamento, dataDescarga, origem, destino`).
- **`createIfMissing`** — preenche se existe, senão cria (variante create-or-fill).

Carga do sistema **não-aceita** nunca entra na planilha: o lançamento não escreve, e a
alocação do Monitor é **update-only** (no-op quando a linha não existe).

## Latência / não-bloqueante (importante)

O Apps Script é **lento** (~1–20s por chamada, variável; cold start + execução
no Google). Por isso o write-back é **fire-and-forget**: o backend grava no banco,
**responde na hora** e dispara o POST pra planilha **em background** (sem `await`).
O operador nunca espera o Google — a edição é instantânea e a planilha espelha
alguns segundos depois.

O Apps Script abaixo usa **busca indexada** (`TextFinder` escopado na coluna A)
em vez de ler a coluna inteira (`getValues` de milhares de linhas) — isso derruba
a execução de ~20s pra ~1–2s. **Se você ainda tem a versão antiga (com `getValues`/
`indexOf`), recole a versão abaixo e reimplante** (Nova versão).

## Env (backend)

```
GOOGLE_SHEET_WRITEBACK_URL="https://script.google.com/macros/s/.../exec"
GOOGLE_SHEET_WRITEBACK_SECRET="um-segredo"
```

## Setup do endpoint (Apps Script — usado no staging/teste)

Na planilha alvo: **Extensões → Apps Script**, cole o script abaixo (troque o
`SECRET` e o `DATA_GID` pela aba de dados), salve, e **Implantar → App da Web**
(*Executar como:* Eu · *Acesso:* Qualquer pessoa). Pegue a URL `.../exec`.

> Importante: ao editar o código, reimplante com **"Nova versão"** (editar não
> atualiza o app publicado).

```javascript
// Colunas: A=LH B=TIPO C=DATA CARREGAMENTO D=DATA DESCARGA E=Motoristas F=CAVALO
//          G=CARRETA H=VINCULO I=Origem J=Destino L=STATUS
const DATA_GID = 438306494;             // gid da aba de dados
const SECRET   = "TROQUE-ESTE-SEGREDO"; // == GOOGLE_SHEET_WRITEBACK_SECRET

const COL = { LH:1, TIPO:2, CARREG:3, DESCARGA:4, MOTORISTA:5, CAVALO:6, CARRETA:7, VINCULO:8, ORIGEM:9, DESTINO:10, STATUS:12 };

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return out_({ ok:false, error:"forbidden" });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets().filter(s => s.getSheetId() === DATA_GID)[0];
    if (!sheet) return out_({ ok:false, error:"aba (gid) nao encontrada" });
    const lastRow = sheet.getLastRow();
    const lhRange = sheet.getRange(1, 1, lastRow, 1); // coluna A (LH)
    let updated = 0, created = 0;
    (body.updates || []).forEach(u => {
      const lh = String(u.lh || "").trim();
      if (!lh) return;
      // Busca indexada server-side (NÃO lê a coluna inteira) — ~10x mais rápido.
      const cell = lhRange.createTextFinder(lh).matchEntireCell(true).findNext();
      if (cell) {
        // createOnly = só criar (lançamento/aceite) → NÃO toca a linha existente
        // (não apaga o motorista já preenchido pelo Monitor). Senão, preenche.
        if (!u.createOnly) {
          const row = cell.getRow();
          sheet.getRange(row, COL.MOTORISTA, 1, 3).setValues([[u.motorista||"", u.cavalo||"", u.carreta||""]]);
          if ("status"  in u) sheet.getRange(row, COL.STATUS ).setValue(u.status ||"");
          if ("vinculo" in u) sheet.getRange(row, COL.VINCULO).setValue(u.vinculo||"");
          // Sync de status ASPX (DC-316): datas + origem/destino no UPDATE, condicionais.
          if ("dataCarregamento" in u) sheet.getRange(row, COL.CARREG  ).setValue(u.dataCarregamento||"");
          if ("dataDescarga"     in u) sheet.getRange(row, COL.DESCARGA).setValue(u.dataDescarga||"");
          if ("origem"           in u) sheet.getRange(row, COL.ORIGEM  ).setValue(u.origem ||"");
          if ("destino"          in u) sheet.getRange(row, COL.DESTINO ).setValue(u.destino||"");
          updated++;
        }
      } else if (u.createIfMissing || u.createOnly) {
        // LH NÃO existe → cria na 1ª linha com LH (col A) em branco, linha completa.
        const rowIdx = firstBlankLhRow_(sheet, lastRow);
        sheet.getRange(rowIdx, COL.LH).setValue(lh);
        if ("tipo"             in u) sheet.getRange(rowIdx, COL.TIPO    ).setValue(u.tipo||"");
        if ("dataCarregamento" in u) sheet.getRange(rowIdx, COL.CARREG  ).setValue(u.dataCarregamento||"");
        if ("dataDescarga"     in u) sheet.getRange(rowIdx, COL.DESCARGA).setValue(u.dataDescarga||"");
        sheet.getRange(rowIdx, COL.MOTORISTA, 1, 3).setValues([[u.motorista||"", u.cavalo||"", u.carreta||""]]);
        if ("vinculo" in u) sheet.getRange(rowIdx, COL.VINCULO).setValue(u.vinculo||"");
        if ("origem"  in u) sheet.getRange(rowIdx, COL.ORIGEM ).setValue(u.origem ||"");
        if ("destino" in u) sheet.getRange(rowIdx, COL.DESTINO).setValue(u.destino||"");
        sheet.getRange(rowIdx, COL.STATUS).setValue(u.status||""); // status vazio se sem motorista
        created++;
      }
    });
    return out_({ ok:true, updated, created });
  } catch (err) { return out_({ ok:false, error:String(err) }); }
}

// 1ª linha (após o cabeçalho) com a coluna A (LH) em branco; senão, a próxima linha nova.
function firstBlankLhRow_(sheet, lastRow) {
  if (lastRow < 2) return 2;
  const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0] || "").trim() === "") return i + 2;
  }
  return lastRow + 1;
}
function out_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
```

## Produção

Para prod, prefira uma **service account** (Sheets API) no lugar do Apps Script
com acesso "qualquer pessoa", ou um Apps Script protegido por segredo forte +
deploy dedicado na planilha de produção. O transporte é trocável (só muda como
`writeAllocationsToSheet` envia); a lógica de "quais linhas mudaram" é a mesma.

> Trade-off: o write-back **re-acopla** o sistema à planilha (o oposto de
> "abandonar a planilha"). Use de forma consciente — em geral só na transição.
