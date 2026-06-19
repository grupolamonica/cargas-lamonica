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
  (E/F/G) da linha do LH. `""` limpa a célula.
- Wired em `update-monitor-allocation.js` (inline/modal) e
  `reassign-monitor-allocations.js` (arrastar), **após** o commit no banco.

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
const DATA_GID = 438306494;             // gid da aba de dados
const SECRET   = "TROQUE-ESTE-SEGREDO"; // == GOOGLE_SHEET_WRITEBACK_SECRET

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return out_({ ok:false, error:"forbidden" });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets().filter(s => s.getSheetId() === DATA_GID)[0];
    if (!sheet) return out_({ ok:false, error:"aba (gid) nao encontrada" });
    const last = sheet.getLastRow();
    const lhCol = sheet.getRange(1, 1, last, 1).getValues().map(r => String(r[0]).trim());
    let updated = 0;
    (body.updates || []).forEach(u => {
      const lh = String(u.lh || "").trim();
      const i = lhCol.indexOf(lh);            // acha a linha pelo LH (coluna A)
      if (!lh || i < 0) return;
      sheet.getRange(i + 1, 5, 1, 3).setValues([[u.motorista || "", u.cavalo || "", u.carreta || ""]]); // E,F,G
      updated++;
    });
    return out_({ ok:true, updated });
  } catch (err) { return out_({ ok:false, error:String(err) }); }
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
