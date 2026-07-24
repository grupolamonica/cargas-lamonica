import { useState } from "react";
import { Check, Loader2, Paperclip } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { onlyDigits } from "@/lib/brazilianValidators";
import { anexarDocumentoCadastro } from "@/services/readModels";

type Dados = Record<string, unknown>;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArr = (v: unknown): Dados[] => (Array.isArray(v) ? (v as Dados[]) : []);
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** grava trimmed se não-vazio; senão remove a chave (não escreve string vazia). */
function put(obj: Record<string, unknown>, k: string, v: string) {
  const t = v.trim();
  if (t) obj[k] = t;
  else delete obj[k];
}
/** ano/eixos etc: inteiro no range ou preserva o que já havia (não grava lixo). */
function putInt(obj: Record<string, unknown>, k: string, v: string, min: number, max: number) {
  const t = v.trim();
  if (!t) { delete obj[k]; return; }
  const n = Number.parseInt(t.replace(/\D/g, ""), 10);
  if (Number.isFinite(n) && n >= min && n <= max) obj[k] = n;
  // valor inválido → mantém o que já estava (não sobrescreve com lixo)
}
/** UF: grava só quando são exatamente 2 letras; vazio remove; parcial preserva. */
function putUf(obj: Record<string, unknown>, k: string, v: string) {
  const t = v.trim().toUpperCase();
  if (!t) { delete obj[k]; return; }
  if (/^[A-Z]{2}$/.test(t)) obj[k] = t;
}

// Campos editáveis do veículo (string) + placa (upper) + ano (int). NÃO edita
// crlv_url, owner_doc, owner_doc_type, frota (identidade/roteamento) — preservados.
type VeiculoForm = { placa: string; marca: string; modelo: string; ano: string; cor: string; renavam: string; chassi: string; antt: string };
function veiculoForm(v: Dados): VeiculoForm {
  return {
    placa: str(v.placa), marca: str(v.marca), modelo: str(v.modelo), ano: str(v.ano),
    cor: str(v.cor), renavam: str(v.renavam), chassi: str(v.chassi), antt: str(v.antt),
  };
}
function mergeVeiculo(base: Dados, f: VeiculoForm): Dados {
  const out: Dados = { ...base };
  if (f.placa.trim()) out.placa = f.placa.trim().toUpperCase();
  put(out, "marca", f.marca); put(out, "modelo", f.modelo); put(out, "cor", f.cor);
  put(out, "renavam", f.renavam); put(out, "chassi", f.chassi); put(out, "antt", f.antt);
  putInt(out, "ano", f.ano, 1950, 2100);
  return out;
}

// Proprietário PF — identidade + pessoais (o que a Angellira exige: name/birth/
// filiacao/rg/naturalidade) + endereço. NÃO edita tipo, owner_doc_url,
// antt_titular, dados_bancarios, rntrc — preservados.
type OwnerForm = {
  nome: string; doc: string; data_nascimento: string;
  rg: string; rg_orgao: string; rg_uf: string; nome_pai: string; nome_mae: string; naturalidade: string;
  cep: string; logradouro: string; numero: string; bairro: string; cidade: string; uf: string;
};
function ownerForm(o: Dados): OwnerForm {
  const end = asObj(o.endereco);
  return {
    nome: str(o.nome), doc: str(o.doc), data_nascimento: str(o.data_nascimento),
    rg: str(o.rg), rg_orgao: str(o.rg_orgao), rg_uf: str(o.rg_uf),
    nome_pai: str(o.nome_pai), nome_mae: str(o.nome_mae), naturalidade: str(o.naturalidade),
    cep: str(end.cep), logradouro: str(end.logradouro), numero: str(end.numero),
    bairro: str(end.bairro), cidade: str(end.cidade), uf: str(end.uf),
  };
}
function mergeOwner(base: Dados, f: OwnerForm): Dados {
  const out: Dados = { ...base };
  put(out, "nome", f.nome);
  const doc = onlyDigits(f.doc);
  if (doc) out.doc = doc; // doc é chave — só dígitos
  // tipo (pf/pj) é obrigatório no ownerSchema. Quando o owner nasce do zero (base
  // sem tipo — proprietário faltante preenchido/anexado agora), deriva do doc:
  // 14 dígitos = CNPJ (pj), senão CPF (pf). Owner existente mantém o tipo do base.
  if (!out.tipo && out.doc) {
    out.tipo = onlyDigits(String(out.doc)).length === 14 ? "pj" : "pf";
  }
  put(out, "data_nascimento", f.data_nascimento);
  put(out, "rg", f.rg); put(out, "rg_orgao", f.rg_orgao);
  putUf(out, "rg_uf", f.rg_uf);
  put(out, "nome_pai", f.nome_pai); put(out, "nome_mae", f.nome_mae); put(out, "naturalidade", f.naturalidade);
  // endereço: preserva comprovante_storage_path e demais chaves.
  const end: Dados = { ...asObj(base.endereco) };
  put(end, "cep", f.cep); put(end, "logradouro", f.logradouro); put(end, "numero", f.numero);
  put(end, "bairro", f.bairro); put(end, "cidade", f.cidade);
  putUf(end, "uf", f.uf);
  if (Object.keys(end).length) out.endereco = end;
  return out;
}

/** Sobrepõe em `cur` só os campos NÃO-vazios de `next` (o OCR do anexo atualiza o
 * que extraiu, mas NÃO apaga o que o operador já digitou e o OCR não trouxe). */
function overlayNonEmpty<T extends Record<string, string>>(cur: T, next: T): T {
  const out = { ...cur };
  (Object.keys(next) as (keyof T)[]).forEach((k) => {
    if (String(next[k] ?? "").trim()) out[k] = next[k];
  });
  return out;
}

/**
 * Editor de CAMPOS do cadastro (amigável) — corrige dados que vieram errados
 * (OCR ruim, CPF não informado, data de nascimento do proprietário faltando,
 * etc.) ANTES de aprovar/disparar. Edita TODOS os conjuntos: motorista + CNH +
 * endereço + cavalo + carreta(s) + PROPRIETÁRIOS (cavalo e carretas), incluindo a
 * data de nascimento do PF — que a Angellira exige e faltava causando erro no
 * disparo. Read-modify-write: preserva o resto do JSONB (documentos/urls,
 * antt_titular, dados_bancarios, rntrc, repom, nao_conformidade…).
 */
export function CadastroCamposEditorModal({
  open,
  dados,
  cadastroId,
  onClose,
  onSave,
  isSaving,
}: {
  open: boolean;
  dados: Dados | null;
  cadastroId: string;
  onClose: () => void;
  onSave: (dados: Dados) => void;
  isSaving: boolean;
}) {
  // Cópia de trabalho do `dados`. O "anexar documento" mescla o resultado do OCR
  // AQUI (não persiste no servidor) e re-preenche a seção afetada; o handleSave
  // ("Salvar") grava a partir desta cópia — incluindo os novos *_url. O pai monta
  // este componente SÓ quando aberto (Motoristas.tsx: selectedPendente && showCamposEditor),
  // então cada abertura remonta com o `dados` ATUAL (reprocessar/editar-JSON já o
  // atualizam) — sem estado stale entre aberturas.
  const [workDados, setWorkDados] = useState<Dados>(() => asObj(dados));
  const base = workDados;
  const m0 = asObj(base.motorista);
  const cnh0 = asObj(m0.cnh);
  const end0 = asObj(m0.endereco);
  const cav0 = asObj(base.cavalo);
  const carretas0 = asArr(base.carretas);
  const cavOwner0 = base.cavalo_owner ? asObj(base.cavalo_owner) : null;
  const carretaOwners0 = asArr(base.carreta_owners);

  const [f, setF] = useState(() => ({
    // Motorista
    nome: str(m0.nome),
    cpf: str(m0.cpf),
    data_nascimento: str(m0.data_nascimento),
    telefone: str(Array.isArray(m0.telefones) ? (m0.telefones as unknown[])[0] : m0.telefone_primario),
    rg: str(m0.rg),
    rg_orgao: str(m0.rg_orgao),
    rg_uf: str(m0.rg_uf),
    nome_pai: str(m0.nome_pai),
    nome_mae: str(m0.nome_mae),
    naturalidade: str(m0.naturalidade),
    // CNH
    registro: str(cnh0.registro),
    categoria: str(cnh0.categoria),
    validade: str(cnh0.validade),
    primeira_emissao: str(cnh0.primeira_emissao),
    codigo_seguranca: str(cnh0.codigo_seguranca),
    numero_espelho: str(cnh0.numero_espelho),
    uf_emissor: str(cnh0.uf_emissor),
    observacoes: str(cnh0.observacoes),
    // Endereço
    cep: str(end0.cep),
    logradouro: str(end0.logradouro),
    numero: str(end0.numero),
    bairro: str(end0.bairro),
    cidade: str(end0.cidade),
    uf: str(end0.uf),
    // Conjuntos
    cavalo: base.cavalo ? veiculoForm(cav0) : null,
    carretas: carretas0.map(veiculoForm),
    // Proprietário do cavalo: exibe sempre que houver cavalo (mesmo sem owner
    // ainda) — permite anexar o doc faltante do proprietário.
    cavaloOwner: base.cavalo ? ownerForm(cavOwner0 ?? {}) : null,
    // Um proprietário POR carreta (mesmo que carreta_owners venha vazio, como no
    // cadastro migrado do JOSE) — assim a seção aparece pra anexar o doc.
    carretaOwners: carretas0.map((_, i) => ownerForm(asObj(carretaOwners0[i]))),
  }));

  // ── Anexar documento faltante (OCR + pré-preenchimento) ──────────────────
  const [attachBusy, setAttachBusy] = useState<string | null>(null);
  const [attachMsg, setAttachMsg] = useState<{ key: string; ok: boolean; text: string } | null>(null);

  const handleAttach = async (docKind: string, target: string, file: File, key: string) => {
    setAttachBusy(key);
    setAttachMsg(null);
    try {
      const res = await anexarDocumentoCadastro(cadastroId, { docKind, target, file });
      const merged = asObj(res.dados);
      setWorkDados(merged); // passa a valer no handleSave (inclui o novo *_url)
      // Re-preenche SÓ a seção afetada a partir do dados mesclado (preserva edições
      // que o operador já fez nas outras seções).
      setF((cur) => {
        if (target === "cavalo") {
          return cur.cavalo ? { ...cur, cavalo: overlayNonEmpty(cur.cavalo, veiculoForm(asObj(merged.cavalo))) } : cur;
        }
        const cm = /^carretas\.(\d+)$/.exec(target);
        if (cm) {
          const i = Number(cm[1]);
          return { ...cur, carretas: cur.carretas.map((c, idx) => (idx === i ? overlayNonEmpty(c, veiculoForm(asObj(asArr(merged.carretas)[i]))) : c)) };
        }
        if (target === "cavalo_owner") {
          const ocr = ownerForm(asObj(merged.cavalo_owner));
          return { ...cur, cavaloOwner: cur.cavaloOwner ? overlayNonEmpty(cur.cavaloOwner, ocr) : ocr };
        }
        const om = /^carreta_owners\.(\d+)$/.exec(target);
        if (om) {
          const i = Number(om[1]);
          return { ...cur, carretaOwners: cur.carretaOwners.map((o, idx) => (idx === i ? overlayNonEmpty(o, ownerForm(asObj(asArr(merged.carreta_owners)[i]))) : o)) };
        }
        return cur;
      });
      const n = res.report?.filled?.length ?? 0;
      setAttachMsg({
        key,
        ok: true,
        text: res.report?.ok
          ? `Anexado — ${n} campo(s) preenchido(s). Revise e salve.`
          : "Anexado (não deu pra ler os campos — preencha à mão e salve).",
      });
    } catch (e) {
      setAttachMsg({ key, ok: false, text: e instanceof Error ? e.message : "Falha ao anexar." });
    } finally {
      setAttachBusy(null);
    }
  };

  // Chaves flat de string (motorista/CNH/endereço). Cavalo/carretas/owners têm
  // setters próprios (setVeic/setOwner).
  type FlatKey =
    | "nome" | "cpf" | "data_nascimento" | "telefone" | "rg" | "rg_orgao" | "rg_uf"
    | "nome_pai" | "nome_mae" | "naturalidade"
    | "registro" | "categoria" | "validade" | "primeira_emissao" | "codigo_seguranca" | "numero_espelho" | "uf_emissor" | "observacoes"
    | "cep" | "logradouro" | "numero" | "bairro" | "cidade" | "uf";
  const set = (k: FlatKey, v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const setVeic = (which: "cavalo" | number, k: keyof VeiculoForm, v: string) =>
    setF((cur) => {
      if (which === "cavalo") return cur.cavalo ? { ...cur, cavalo: { ...cur.cavalo, [k]: v } } : cur;
      return { ...cur, carretas: cur.carretas.map((c, i) => (i === which ? { ...c, [k]: v } : c)) };
    });
  const setOwner = (which: "cavalo" | number, k: keyof OwnerForm, v: string) =>
    setF((cur) => {
      if (which === "cavalo") return cur.cavaloOwner ? { ...cur, cavaloOwner: { ...cur.cavaloOwner, [k]: v } } : cur;
      return { ...cur, carretaOwners: cur.carretaOwners.map((o, i) => (i === which ? { ...o, [k]: v } : o)) };
    });

  const handleSave = () => {
    const next: Dados = { ...base };

    // ── Motorista ──
    const motorista: Record<string, unknown> = { ...m0 };
    put(motorista, "nome", f.nome);
    // CPF é a chave (aprovação/dedup): só atualiza se não-vazio — limpar o campo
    // NÃO apaga o CPF que já existia.
    const cpfClean = onlyDigits(f.cpf);
    if (cpfClean) motorista.cpf = cpfClean;
    put(motorista, "data_nascimento", f.data_nascimento);
    put(motorista, "rg", f.rg);
    put(motorista, "rg_orgao", f.rg_orgao);
    putUf(motorista, "rg_uf", f.rg_uf);
    put(motorista, "nome_pai", f.nome_pai);
    put(motorista, "nome_mae", f.nome_mae);
    put(motorista, "naturalidade", f.naturalidade);
    const tel = onlyDigits(f.telefone);
    if (tel) {
      // Preserva um eventual 2º telefone já cadastrado (o editor só mostra o 1º);
      // telefone_primario === telefones[0] (contrato W-09).
      const extras = Array.isArray(m0.telefones)
        ? (m0.telefones as unknown[]).slice(1).map((t) => onlyDigits(String(t))).filter(Boolean)
        : [];
      motorista.telefones = [tel, ...extras].slice(0, 2);
      motorista.telefone_primario = tel;
    }
    const cnh: Record<string, unknown> = { ...cnh0 };
    put(cnh, "registro", f.registro);
    put(cnh, "categoria", f.categoria);
    put(cnh, "validade", f.validade);
    put(cnh, "primeira_emissao", f.primeira_emissao);
    put(cnh, "codigo_seguranca", f.codigo_seguranca);
    put(cnh, "numero_espelho", f.numero_espelho);
    put(cnh, "uf_emissor", f.uf_emissor);
    put(cnh, "observacoes", f.observacoes);
    if (Object.keys(cnh).length) motorista.cnh = cnh;
    const endereco: Record<string, unknown> = { ...end0 };
    put(endereco, "cep", f.cep);
    put(endereco, "logradouro", f.logradouro);
    put(endereco, "numero", f.numero);
    put(endereco, "bairro", f.bairro);
    put(endereco, "cidade", f.cidade);
    putUf(endereco, "uf", f.uf);
    if (Object.keys(endereco).length) motorista.endereco = endereco;
    next.motorista = motorista;

    // ── Cavalo + carretas ──
    if (base.cavalo && f.cavalo) next.cavalo = mergeVeiculo(cav0, f.cavalo);
    if (carretas0.length) next.carretas = carretas0.map((c, i) => (f.carretas[i] ? mergeVeiculo(c, f.carretas[i]) : c));

    // ── Proprietários ── (owner pode ter sido CRIADO via anexo — workDados já o
    // tem; ou preenchido à mão. Merge não-destrutivo a partir do existente.)
    if (f.cavaloOwner) {
      const mo = mergeOwner(cavOwner0 ?? {}, f.cavaloOwner);
      if (Object.keys(mo).length) next.cavalo_owner = mo;
    }
    // NUNCA grava owner `{}` vazio (viola ownerSchema.strict — exige tipo/doc/nome):
    // f.carretaOwners tem 1 entrada POR CARRETA (padding p/ renderizar a seção),
    // então carretas sem owner real virariam {} — filtra os vazios. (Com no máx. 2
    // carretas e preenchimento em ordem, sobra sempre o(s) owner(s) real(is) no topo.)
    if (carretaOwners0.length || f.carretaOwners.some((o) => Object.values(o).some((v) => String(v ?? "").trim()))) {
      const merged = f.carretaOwners
        .map((of, i) => mergeOwner(asObj(carretaOwners0[i]), of))
        .filter((o) => Object.keys(o).length);
      if (merged.length) next.carreta_owners = merged;
    }

    onSave(next);
  };

  const field = (label: string, value: string, onChange: (v: string) => void, opts?: { upper?: boolean; mono?: boolean; placeholder?: string }) => (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(opts?.upper ? e.target.value.toUpperCase() : e.target.value)}
        placeholder={opts?.placeholder}
        disabled={isSaving}
        className={opts?.mono ? "h-8 font-mono text-sm" : "h-8 text-sm"}
      />
    </div>
  );
  // atalho p/ campos do motorista/cnh/endereço (state flat)
  const mfield = (label: string, k: FlatKey, opts?: { upper?: boolean; mono?: boolean; placeholder?: string }) =>
    field(label, f[k], (v) => set(k, v), opts);

  // Linha de "anexar documento faltante" (upload + OCR + pré-preenche a seção).
  const attachControl = (target: string, kinds: { docKind: string; label: string }[]) => (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="text-[11px] text-muted-foreground">Anexar doc faltante:</span>
      {kinds.map((k) => {
        const key = `${target}:${k.docKind}`;
        const busy = attachBusy === key;
        return (
          <label
            key={key}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium ${
              busy || isSaving ? "pointer-events-none opacity-60" : "hover:bg-muted"
            }`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Paperclip className="h-3 w-3" />}
            {k.label}
            <input
              type="file"
              className="hidden"
              accept="image/*,application/pdf,.heic,.heif"
              disabled={busy || isSaving}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // permite re-selecionar o mesmo arquivo
                if (file) void handleAttach(k.docKind, target, file, key);
              }}
            />
          </label>
        );
      })}
      {attachMsg && attachMsg.key.startsWith(`${target}:`) ? (
        <span className={`text-[11px] ${attachMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
          {attachMsg.text}
        </span>
      ) : null}
    </div>
  );

  const veiculoSection = (title: string, v: VeiculoForm, which: "cavalo" | number) => (
    <section className="space-y-2" key={`veic-${title}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">{title}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field("Placa", v.placa, (val) => setVeic(which, "placa", val), { upper: true, mono: true })}
        {field("Marca", v.marca, (val) => setVeic(which, "marca", val))}
        {field("Modelo", v.modelo, (val) => setVeic(which, "modelo", val))}
        {field("Ano", v.ano, (val) => setVeic(which, "ano", val), { mono: true, placeholder: "AAAA" })}
        {field("Cor", v.cor, (val) => setVeic(which, "cor", val))}
        {field("Renavam", v.renavam, (val) => setVeic(which, "renavam", val), { mono: true })}
        {field("Chassi", v.chassi, (val) => setVeic(which, "chassi", val), { mono: true, upper: true })}
        {field("ANTT/RNTRC", v.antt, (val) => setVeic(which, "antt", val), { mono: true })}
      </div>
      {attachControl(which === "cavalo" ? "cavalo" : `carretas.${which}`, [{ docKind: "crlv", label: "CRLV" }])}
    </section>
  );

  const ownerSection = (title: string, o: OwnerForm, which: "cavalo" | number) => (
    <section className="space-y-2" key={`owner-${title}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">{title}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field("Nome / Razão social", o.nome, (val) => setOwner(which, "nome", val))}
        {field("CPF/CNPJ", o.doc, (val) => setOwner(which, "doc", val), { mono: true, placeholder: "só números" })}
        {field("Data de nascimento", o.data_nascimento, (val) => setOwner(which, "data_nascimento", val), { placeholder: "DD/MM/AAAA (exigido no Angellira p/ PF)" })}
        {field("RG", o.rg, (val) => setOwner(which, "rg", val))}
        {field("Órgão emissor (RG)", o.rg_orgao, (val) => setOwner(which, "rg_orgao", val))}
        {field("UF do RG", o.rg_uf, (val) => setOwner(which, "rg_uf", val), { upper: true })}
        {field("Nome do pai", o.nome_pai, (val) => setOwner(which, "nome_pai", val))}
        {field("Nome da mãe", o.nome_mae, (val) => setOwner(which, "nome_mae", val))}
        {field("Naturalidade", o.naturalidade, (val) => setOwner(which, "naturalidade", val))}
        {field("CEP", o.cep, (val) => setOwner(which, "cep", val), { mono: true })}
        {field("Logradouro", o.logradouro, (val) => setOwner(which, "logradouro", val))}
        {field("Número", o.numero, (val) => setOwner(which, "numero", val))}
        {field("Bairro", o.bairro, (val) => setOwner(which, "bairro", val))}
        {field("Cidade", o.cidade, (val) => setOwner(which, "cidade", val))}
        {field("UF", o.uf, (val) => setOwner(which, "uf", val), { upper: true })}
      </div>
      {attachControl(which === "cavalo" ? "cavalo_owner" : `carreta_owners.${which}`, [
        { docKind: "owner-cnh", label: "CNH (PF)" },
        { docKind: "cartao-cnpj", label: "Cartão CNPJ (PJ)" },
        { docKind: "comprovante", label: "Comprovante" },
      ])}
    </section>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl">
        <DialogHeader>
          <DialogTitle>Editar dados do cadastro</DialogTitle>
          <DialogDescription>
            Corrija os campos que vieram errados (motorista, veículos e proprietários) antes de aprovar/disparar. Documentos e demais dados são preservados.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">Motorista</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {mfield("Nome", "nome")}
              {mfield("CPF", "cpf", { mono: true, placeholder: "só números" })}
              {mfield("Data de nascimento", "data_nascimento", { placeholder: "DD/MM/AAAA" })}
              {mfield("Telefone (WhatsApp)", "telefone", { mono: true, placeholder: "DDD + número" })}
              {mfield("RG", "rg")}
              {mfield("Órgão emissor (RG)", "rg_orgao")}
              {mfield("UF do RG", "rg_uf", { upper: true })}
              {mfield("Naturalidade", "naturalidade")}
              {mfield("Nome do pai", "nome_pai")}
              {mfield("Nome da mãe", "nome_mae")}
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">CNH</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {mfield("Nº de registro", "registro", { mono: true })}
              {mfield("Categoria", "categoria", { upper: true })}
              {mfield("Validade", "validade", { placeholder: "AAAA-MM-DD" })}
              {mfield("1ª habilitação", "primeira_emissao", { placeholder: "AAAA-MM-DD" })}
              {mfield("Código de segurança", "codigo_seguranca", { mono: true })}
              {mfield("Nº do espelho", "numero_espelho", { mono: true })}
              {mfield("UF emissor", "uf_emissor", { upper: true })}
              {mfield("Observações (EAR etc.)", "observacoes", { upper: true, placeholder: "verso da CNH — obrigatório no SPX (ex.: EAR)" })}
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">Endereço do motorista</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {mfield("CEP", "cep", { mono: true })}
              {mfield("Logradouro", "logradouro")}
              {mfield("Número", "numero")}
              {mfield("Bairro", "bairro")}
              {mfield("Cidade", "cidade")}
              {mfield("UF", "uf", { upper: true })}
            </div>
          </section>

          {f.cavalo ? veiculoSection("Cavalo", f.cavalo, "cavalo") : null}
          {f.carretas.map((c, i) => veiculoSection(f.carretas.length > 1 ? `Carreta ${i + 1}` : "Carreta", c, i))}
          {f.cavaloOwner ? ownerSection("Proprietário do cavalo", f.cavaloOwner, "cavalo") : null}
          {f.carretaOwners.map((o, i) => ownerSection(f.carretaOwners.length > 1 ? `Proprietário da carreta ${i + 1}` : "Proprietário da carreta", o, i))}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving || attachBusy !== null}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            // Bloqueia Salvar enquanto um anexo está em voo — senão o handleSave usaria
            // o workDados PRÉ-anexo e o *_url do doc recém-anexado se perderia (upload órfão).
            disabled={isSaving || attachBusy !== null}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Salvar alterações
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
