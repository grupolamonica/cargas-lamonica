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
  tipo: string; nome: string; doc: string;
  // PJ (cartão-CNPJ / consulta Receita)
  nome_fantasia: string; inscricao_estadual: string; matriz_filial: string; data_abertura: string;
  porte: string; natureza_juridica: string; atividade_principal: string; atividades_secundarias: string;
  email: string; telefone: string; ente_federativo: string;
  situacao_cadastral: string; situacao_cadastral_data: string; situacao_cadastral_motivo: string;
  situacao_especial: string; situacao_especial_data: string;
  // PF (CNH)
  apelido: string; data_nascimento: string; sexo: string; nacionalidade: string;
  rg: string; rg_orgao: string; rg_uf: string; nome_pai: string; nome_mae: string; naturalidade: string;
  cnh_categoria: string; cnh_registro: string; cnh_numero_prontuario: string; cnh_validade: string;
  cnh_primeira_emissao: string; cnh_codigo_seguranca: string; cnh_orgao_emissor: string;
  cnh_uf_emissor: string; cnh_estado_emissor: string; cnh_observacoes: string; cnh_data_emissao: string;
  // Endereço
  cep: string; logradouro: string; numero: string; complemento: string; bairro: string; cidade: string; uf: string;
};
function ownerForm(o: Dados): OwnerForm {
  const end = asObj(o.endereco);
  const cnh = asObj(o.cnh);
  return {
    tipo: str(o.tipo), nome: str(o.nome), doc: str(o.doc),
    nome_fantasia: str(o.nome_fantasia), inscricao_estadual: str(o.inscricao_estadual),
    matriz_filial: str(o.matriz_filial), data_abertura: str(o.data_abertura), porte: str(o.porte),
    natureza_juridica: str(o.natureza_juridica), atividade_principal: str(o.atividade_principal),
    atividades_secundarias: str(o.atividades_secundarias), email: str(o.email), telefone: str(o.telefone),
    ente_federativo: str(o.ente_federativo), situacao_cadastral: str(o.situacao_cadastral),
    situacao_cadastral_data: str(o.situacao_cadastral_data), situacao_cadastral_motivo: str(o.situacao_cadastral_motivo),
    situacao_especial: str(o.situacao_especial), situacao_especial_data: str(o.situacao_especial_data),
    apelido: str(o.apelido), data_nascimento: str(o.data_nascimento), sexo: str(o.sexo), nacionalidade: str(o.nacionalidade),
    rg: str(o.rg), rg_orgao: str(o.rg_orgao), rg_uf: str(o.rg_uf),
    nome_pai: str(o.nome_pai), nome_mae: str(o.nome_mae), naturalidade: str(o.naturalidade),
    cnh_categoria: str(cnh.categoria), cnh_registro: str(cnh.registro),
    cnh_numero_prontuario: str(cnh.numero_prontuario ?? cnh.numero_espelho),
    cnh_validade: str(cnh.validade), cnh_primeira_emissao: str(cnh.primeira_emissao),
    cnh_codigo_seguranca: str(cnh.codigo_seguranca), cnh_orgao_emissor: str(cnh.orgao_emissor),
    cnh_uf_emissor: str(cnh.uf_emissor), cnh_estado_emissor: str(cnh.estado_emissor),
    cnh_observacoes: str(cnh.observacoes), cnh_data_emissao: str(cnh.data_emissao),
    cep: str(end.cep), logradouro: str(end.logradouro), numero: str(end.numero), complemento: str(end.complemento),
    bairro: str(end.bairro), cidade: str(end.cidade), uf: str(end.uf),
  };
}
function mergeOwner(base: Dados, f: OwnerForm): Dados {
  const out: Dados = { ...base };
  put(out, "nome", f.nome);
  const doc = onlyDigits(f.doc);
  if (doc) out.doc = doc; // doc é chave — só dígitos
  // tipo (pf/pj, obrigatório no ownerSchema): o selecionado no form vence; senão
  // deriva do doc (14 = CNPJ). Owner sem doc + sem escolha fica sem tipo (não cria
  // owner só com tipo — handleSave dropa vazio).
  if (f.tipo === "pf" || f.tipo === "pj") out.tipo = f.tipo;
  else if (!out.tipo && out.doc) out.tipo = onlyDigits(String(out.doc)).length === 14 ? "pj" : "pf";
  // PJ (metadados da Receita)
  put(out, "nome_fantasia", f.nome_fantasia); put(out, "inscricao_estadual", f.inscricao_estadual);
  put(out, "matriz_filial", f.matriz_filial); put(out, "data_abertura", f.data_abertura); put(out, "porte", f.porte);
  put(out, "natureza_juridica", f.natureza_juridica); put(out, "atividade_principal", f.atividade_principal);
  put(out, "atividades_secundarias", f.atividades_secundarias); put(out, "email", f.email); put(out, "telefone", f.telefone);
  put(out, "ente_federativo", f.ente_federativo); put(out, "situacao_cadastral", f.situacao_cadastral);
  put(out, "situacao_cadastral_data", f.situacao_cadastral_data); put(out, "situacao_cadastral_motivo", f.situacao_cadastral_motivo);
  put(out, "situacao_especial", f.situacao_especial); put(out, "situacao_especial_data", f.situacao_especial_data);
  // PF
  put(out, "apelido", f.apelido); put(out, "data_nascimento", f.data_nascimento); put(out, "sexo", f.sexo); put(out, "nacionalidade", f.nacionalidade);
  put(out, "rg", f.rg); put(out, "rg_orgao", f.rg_orgao); putUf(out, "rg_uf", f.rg_uf);
  put(out, "nome_pai", f.nome_pai); put(out, "nome_mae", f.nome_mae); put(out, "naturalidade", f.naturalidade);
  // PF — bloco CNH (preserva as chaves existentes; uf_emissor só 2 letras).
  const cnh: Dados = { ...asObj(base.cnh) };
  put(cnh, "categoria", f.cnh_categoria); put(cnh, "registro", f.cnh_registro); put(cnh, "numero_prontuario", f.cnh_numero_prontuario);
  put(cnh, "validade", f.cnh_validade); put(cnh, "primeira_emissao", f.cnh_primeira_emissao); put(cnh, "codigo_seguranca", f.cnh_codigo_seguranca);
  put(cnh, "orgao_emissor", f.cnh_orgao_emissor); putUf(cnh, "uf_emissor", f.cnh_uf_emissor); put(cnh, "estado_emissor", f.cnh_estado_emissor);
  put(cnh, "observacoes", f.cnh_observacoes); put(cnh, "data_emissao", f.cnh_data_emissao);
  if (Object.keys(cnh).length) out.cnh = cnh;
  // endereço: preserva comprovante_storage_path e demais chaves.
  const end: Dados = { ...asObj(base.endereco) };
  put(end, "cep", f.cep); put(end, "logradouro", f.logradouro); put(end, "numero", f.numero); put(end, "complemento", f.complemento);
  put(end, "bairro", f.bairro); put(end, "cidade", f.cidade); putUf(end, "uf", f.uf);
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

  // "Mesmo proprietário para todos os veículos": quando ligado, o dono do CAVALO
  // é aplicado a cavalo + todas as carretas (owner_doc dos veículos + objeto de
  // proprietário), evitando anexar em cada slot e o mismatch owner_doc≠owner que
  // derruba o disparo (Angellira reaproveita o dono do cavalo p/ as carretas).
  // Init: já está como dono único? (todas as carretas com o mesmo owner_doc do cavalo).
  const [mesmoDono, setMesmoDono] = useState<boolean>(() => {
    const cavDoc = onlyDigits(str(cav0.owner_doc));
    return carretas0.length > 0 && !!cavDoc
      && carretas0.every((c) => onlyDigits(str(asObj(c).owner_doc)) === cavDoc);
  });

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
      // Mostra o motivo REAL do OCR quando não extraiu (ex.: "Vision indisponível",
      // erro do provedor) — em vez do genérico, ajuda a diagnosticar na hora.
      const motivo = res.report?.message ? ` (${res.report.message})` : "";
      setAttachMsg({
        key,
        ok: true,
        text: res.report?.ok
          ? `Anexado — ${n} campo(s) preenchido(s).${motivo ? ` Obs:${motivo}` : ""} Revise e salve.`
          : `Anexado, mas não deu pra ler os campos${motivo} — preencha à mão e salve.`,
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
    // SÓ grava owner com `doc` válido (>=11 díg). ownerSchema.strict exige
    // doc+nome+tipo — um owner só com `tipo` (operador tocou no seletor e não
    // preencheu) passaria o Object.keys>0 e quebraria (422) no re-submit.
    const ownerGravavel = (o: Dados) => onlyDigits(String(o.doc ?? "")).length >= 11;
    if (f.cavaloOwner) {
      const mo = mergeOwner(cavOwner0 ?? {}, f.cavaloOwner);
      if (ownerGravavel(mo)) next.cavalo_owner = mo;
    }
    if (mesmoDono && carretas0.length && ownerGravavel(asObj(next.cavalo_owner))) {
      // "Mesmo dono": o proprietário do cavalo vale p/ todos. Propaga o owner_doc
      // dele pros veículos (cavalo + carretas) — senão o disparo dá OWNER_NAO_
      // CADASTRADO (veículo aponta um doc; dono cadastrado é outro) — e espelha o
      // objeto de proprietário em cada carreta (o Angellira reaproveita o do cavalo).
      const ownerObj = asObj(next.cavalo_owner);
      const ownerDoc = onlyDigits(String(ownerObj.doc));
      const ownerType = ownerDoc.length === 14 ? "cnpj" : "cpf";
      const stampVeic = (veh: unknown): Dados => ({ ...asObj(veh), owner_doc: ownerDoc, owner_doc_type: ownerType });
      if (base.cavalo) next.cavalo = stampVeic(next.cavalo ?? cav0);
      // next.carretas já foi setado acima (carretas0.length é verdadeiro aqui).
      next.carretas = asArr(next.carretas).map(stampVeic);
      next.carreta_owners = carretas0.map(() => ({ ...ownerObj }));
    } else if (carretaOwners0.length || f.carretaOwners.some((o) => Object.values(o).some((v) => String(v ?? "").trim()))) {
      // Donos independentes por carreta. f.carretaOwners tem 1 entrada POR CARRETA
      // (padding); carretas sem owner real são descartadas pelo filtro de doc.
      const merged = f.carretaOwners
        .map((of, i) => mergeOwner(asObj(carretaOwners0[i]), of))
        .filter(ownerGravavel);
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

  const ownerSection = (title: string, o: OwnerForm, which: "cavalo" | number) => {
    const of = (label: string, k: keyof OwnerForm, opts?: { upper?: boolean; mono?: boolean; placeholder?: string }) =>
      field(label, o[k], (val) => setOwner(which, k, val), opts);
    // Modo PF/PJ: o tipo escolhido; senão deriva do documento (14 díg = PJ).
    const mode: "pf" | "pj" = o.tipo === "pj" ? "pj" : o.tipo === "pf" ? "pf" : (onlyDigits(o.doc).length === 14 ? "pj" : "pf");
    const target = which === "cavalo" ? "cavalo_owner" : `carreta_owners.${which}`;
    return (
      <section className="space-y-2" key={`owner-${title}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">{title}</p>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            Tipo:
            <select
              value={mode}
              onChange={(e) => setOwner(which, "tipo", e.target.value)}
              disabled={isSaving}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              <option value="pf">Pessoa Física (CNH)</option>
              <option value="pj">Pessoa Jurídica (CNPJ)</option>
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {of("Nome / Razão social", "nome")}
          {of("CPF / CNPJ", "doc", { mono: true, placeholder: "só números" })}
          {mode === "pj" ? (
            <>
              {of("Nome fantasia", "nome_fantasia")}
              {of("Inscrição estadual", "inscricao_estadual", { mono: true })}
              {of("Matriz / Filial", "matriz_filial")}
              {of("Data de abertura", "data_abertura")}
              {of("Porte", "porte")}
              {of("Natureza jurídica", "natureza_juridica")}
              {of("Atividade principal (CNAE)", "atividade_principal")}
              {of("Atividades secundárias", "atividades_secundarias")}
              {of("E-mail", "email")}
              {of("Telefone", "telefone", { mono: true })}
              {of("Ente federativo (EFR)", "ente_federativo")}
              {of("Situação cadastral", "situacao_cadastral")}
              {of("Data da situação cadastral", "situacao_cadastral_data")}
              {of("Motivo da situação", "situacao_cadastral_motivo")}
              {of("Situação especial", "situacao_especial")}
              {of("Data da situação especial", "situacao_especial_data")}
            </>
          ) : (
            <>
              {of("Apelido", "apelido")}
              {of("Data de nascimento", "data_nascimento", { placeholder: "DD/MM/AAAA (exigido no Angellira p/ PF)" })}
              {of("Sexo", "sexo")}
              {of("Nacionalidade", "nacionalidade")}
              {of("RG", "rg")}
              {of("Órgão emissor (RG)", "rg_orgao")}
              {of("UF do RG", "rg_uf", { upper: true })}
              {of("Nome do pai", "nome_pai")}
              {of("Nome da mãe", "nome_mae")}
              {of("Naturalidade", "naturalidade")}
            </>
          )}
        </div>
        {mode === "pf" ? (
          <div className="space-y-1">
            <p className="text-[11px] font-medium text-primary/50">CNH do proprietário</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {of("Categoria", "cnh_categoria", { upper: true })}
              {of("Nº de registro", "cnh_registro", { mono: true })}
              {of("Nº do prontuário", "cnh_numero_prontuario", { mono: true })}
              {of("Validade", "cnh_validade", { placeholder: "AAAA-MM-DD" })}
              {of("1ª habilitação", "cnh_primeira_emissao", { placeholder: "AAAA-MM-DD" })}
              {of("Código de segurança", "cnh_codigo_seguranca", { mono: true })}
              {of("Órgão emissor / UF", "cnh_orgao_emissor")}
              {of("UF emissora", "cnh_uf_emissor", { upper: true })}
              {of("Estado emissor (cidade/UF)", "cnh_estado_emissor")}
              {of("Observações (EAR etc.)", "cnh_observacoes", { upper: true })}
              {of("Data de emissão", "cnh_data_emissao", { placeholder: "AAAA-MM-DD" })}
            </div>
          </div>
        ) : null}
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-primary/50">Endereço</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {of("CEP", "cep", { mono: true })}
            {of("Logradouro", "logradouro")}
            {of("Número", "numero")}
            {of("Complemento", "complemento")}
            {of("Bairro", "bairro")}
            {of("Cidade", "cidade")}
            {of("UF", "uf", { upper: true })}
          </div>
        </div>
        {attachControl(target, [
          { docKind: "owner-cnh", label: "CNH (PF)" },
          { docKind: "cartao-cnpj", label: "Cartão CNPJ (PJ)" },
          { docKind: "comprovante", label: "Comprovante" },
        ])}
      </section>
    );
  };

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
          {f.carretaOwners.length > 0 ? (
            <label className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={mesmoDono}
                onChange={(e) => setMesmoDono(e.target.checked)}
                disabled={isSaving}
                className="h-4 w-4"
              />
              <span>
                <strong>Mesmo proprietário para todos os veículos</strong> (cavalo + carretas). Preencha/anexe o dono
                uma vez no <em>Proprietário do cavalo</em> — ele é aplicado às carretas automaticamente.
              </span>
            </label>
          ) : null}
          {f.cavaloOwner ? ownerSection("Proprietário do cavalo", f.cavaloOwner, "cavalo") : null}
          {mesmoDono
            ? null
            : f.carretaOwners.map((o, i) => ownerSection(f.carretaOwners.length > 1 ? `Proprietário da carreta ${i + 1}` : "Proprietário da carreta", o, i))}
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
