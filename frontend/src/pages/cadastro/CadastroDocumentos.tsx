import { useMemo, useState } from "react";
import {
  Building2,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileBadge,
  FileText,
  Fingerprint,
  Hash,
  IdCard,
  Loader2,
  Lock,
  MapPin,
  Phone,
  Plus,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Truck,
  Upload,
  User,
  Users,
  X,
} from "lucide-react";

import Logo from "@/components/Logo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { normalizeDateInputValue } from "@/lib/dateDisplay";
import {
  type AnttStatus,
  type CnpjConsultaResult,
  type VeiculoSituacaoResult,
  consultaAnttVeiculo,
  consultaCep,
  consultaCnpj,
  consultaVeiculoSituacao,
  finalizarCadastro,
  ocrCartaoCnpj,
  ocrCnh,
  ocrComprovante,
  ocrCrlv,
} from "./cadastroApi";
import {
  validateCep,
  validateChassi,
  validateCnhRegistro,
  validateCnpj,
  validateCpf,
  validatePis,
  validatePlaca,
  validateRenavam,
  validateTelefone,
} from "@/lib/validators";

// ───────────────────────────── Tipos (espelham o JSON) ─────────────────────────────

type CNHData = {
  registro: string;
  categoria: string;
  codigo_seguranca: string;
  numero_espelho: string;
  uf_emissor: string;
  validade: string;
  primeira_emissao: string;
};

type Endereco = {
  cep: string;
  uf: string;
  cidade: string;
  bairro: string;
  logradouro: string;
  numero: string;
};

type DadosBancarios = {
  banco_codigo: string;     // 3 digitos do COMPE/STR (ex: 341, 001)
  banco_nome: string;       // ex: "Itau", "Banco do Brasil"
  agencia: string;          // 4-5 digitos
  conta: string;            // numero da conta + digito
  tipo: "" | "corrente" | "poupanca";
};

type Rastreador = {
  marca: string;
  numero: string;
  arquivo: string;          // contrato/foto opcional
};

type Operacional = {
  tag_pedagio: string;      // SEM_PARAR | CONECTCAR | MOVE_MAIS | VELOE | ENDERED | NAO_POSSUI
  possui_pancary: boolean;
  rastreador: Rastreador;
};

type PessoaBase = {
  nome: string;
  cpf: string;
  data_nascimento: string;
  nome_pai: string;
  nome_mae: string;
  naturalidade: string;
  rg: string;
  rg_orgao: string;
  rg_uf: string;
};

type Motorista = PessoaBase & {
  tambem_proprietario: boolean;
  telefones: string[];
};

type ProprietarioPF = PessoaBase &
  Endereco & {
    situacao: string;
    telefones: string[];
    // Quando false, o proprietario nao tem CNH e o documento anexado e o RG.
    // Pula a validacao dos campos de CNH e troca o label do upload.
    tem_cnh: boolean;
    // ── Campos AngelLira (Etapa 1) ──
    cartao_pis: string;       // 11 digitos (PIS/PASEP/NIS/NIT)
    estado_civil: string;     // 6 opcoes
    cor_raca: string;         // 6 opcoes IBGE
    // ── Campos AngelLira (Etapa 2) ──
    dados_bancarios: DadosBancarios;
  };

type ProprietarioPJ = Endereco & {
  nome: string;
  cnpj: string;
  telefones: string[];
  // ── Campos AngelLira (Etapa 1) ──
  inscricao_estadual: string;
  isento_ie: boolean;         // quando true, IE = "ISENTO"
  // ── Campos AngelLira (Etapa 2) ──
  dados_bancarios: DadosBancarios;
};

type Veiculo = {
  placa: string;
  tipo: string;
  carroceria: string;
  proprietario: string;
  marca: string;
  modelo: string;
  ano_fabricacao: string;
  ano_modelo: string;
  cor: string;
  uf_emplacamento: string;
  cidade_emplacamento: string;
  renavam: string;
  chassi: string;
  eixos: string;
  frota: string;
  antt: string;
  ultimo_licenciamento: string;
};

type Arquivos = {
  cnh: string;
  crlv_cavalo: string;
  crlv_carreta: string;
  comprovante_motorista: string;
  comprovante_proprietario: string;
  cartao_cnpj: string;
  cnh_proprietario: string;
  cartao_cnpj_carreta: string;
  cnh_proprietario_carreta: string;
  // ── Novos uploads AngelLira (Etapa 1) ──
  selfie_cnh: string;       // motorista segurando a CNH
  antt_cavalo: string;      // PDF do RNTRC do cavalo
  antt_carreta: string;     // PDF do RNTRC da carreta
};

// Carreta extra (alem da principal `carreta`). Cada item tem seu proprio
// veiculo + arquivo CRLV. O proprietario das carretas extras e compartilhado
// com `proprietario_*_carreta` (assumimos mesmo dono pra todas as carretas
// adicionais — operacao tipica em frota propria).
type CarretaExtra = {
  veiculo: Veiculo;
  arquivo_crlv: string;
};

type TipoComposicao = "sem_carreta" | "1_carreta" | "bitrem";

// Proprietario da ANTT (transportador no RNTRC). Pode ser diferente do
// dono do veiculo no CRLV — caso comum em frota terceirizada (ETC com varios
// motoristas TAC). Quando `igual_proprietario_veiculo` e true, reaproveita
// os dados do bloco proprietario_p* correspondente.
type ProprietarioAntt = {
  igual_proprietario_veiculo: boolean;
  tipo: "" | "PJ" | "PF";
  proprietario_pj: ProprietarioPJ;
  proprietario_pf: ProprietarioPF;
  cnh_proprietario_pf: CNHData;
};

type FormData = {
  id_cadastro: string;
  // sem_carreta: so o cavalo. 1_carreta: cavalo + 1 carreta. bitrem: cavalo + 2 carretas (a principal + 1 extra).
  tipo_composicao: TipoComposicao;
  carreta_proprietario_diferente: boolean;
  arquivos: Arquivos;
  motorista: Motorista;
  cnh: CNHData;
  endereco_motorista: Endereco;
  cavalo: Veiculo;
  carreta: Veiculo;
  carretas_extras: CarretaExtra[];
  proprietario_pj: ProprietarioPJ;
  proprietario_pf: ProprietarioPF;
  proprietario_pj_carreta: ProprietarioPJ;
  proprietario_pf_carreta: ProprietarioPF;
  cnh_proprietario_pf: CNHData;
  cnh_proprietario_pf_carreta: CNHData;
  // ── Etapa 2: dados operacionais do cavalo ──
  operacional: Operacional;
  // ── Etapa 3: proprietario do RNTRC (transportador na ANTT) ──
  proprietario_antt_cavalo: ProprietarioAntt;
  proprietario_antt_carreta: ProprietarioAntt;
};

type ProprietarioTipo = "PJ" | "PF" | "";

// ───────────────────────────── Estados iniciais ─────────────────────────────

const emptyEndereco: Endereco = { cep: "", uf: "", cidade: "", bairro: "", logradouro: "", numero: "" };
const emptyPessoa: PessoaBase = {
  nome: "",
  cpf: "",
  data_nascimento: "",
  nome_pai: "",
  nome_mae: "",
  naturalidade: "",
  rg: "",
  rg_orgao: "",
  rg_uf: "",
};
const emptyCNH: CNHData = {
  registro: "",
  categoria: "",
  codigo_seguranca: "",
  numero_espelho: "",
  uf_emissor: "",
  validade: "",
  primeira_emissao: "",
};
const emptyVeiculo: Veiculo = {
  placa: "",
  tipo: "",
  carroceria: "",
  proprietario: "",
  marca: "",
  modelo: "",
  ano_fabricacao: "",
  ano_modelo: "",
  cor: "",
  uf_emplacamento: "",
  cidade_emplacamento: "",
  renavam: "",
  chassi: "",
  eixos: "",
  frota: "",
  antt: "",
  ultimo_licenciamento: "",
};
const emptyDadosBancarios: DadosBancarios = {
  banco_codigo: "",
  banco_nome: "",
  agencia: "",
  conta: "",
  tipo: "",
};
const emptyProprietarioPJ: ProprietarioPJ = {
  nome: "",
  cnpj: "",
  telefones: [],
  ...emptyEndereco,
  inscricao_estadual: "",
  isento_ie: false,
  dados_bancarios: { ...emptyDadosBancarios },
};
const emptyProprietarioPF: ProprietarioPF = {
  ...emptyPessoa,
  situacao: "",
  telefones: [],
  tem_cnh: true,
  ...emptyEndereco,
  cartao_pis: "",
  estado_civil: "",
  cor_raca: "",
  dados_bancarios: { ...emptyDadosBancarios },
};

// Gera um id de sessao curto e URL-safe ([A-Za-z0-9_-]) usado como nome
// inicial da pasta em anexos_tmp/. Quando o OCR da CNH retorna o nome do
// motorista, o backend renomeia a pasta e devolve o slug pelo campo
// idCadastroPasta — atualizamos o state com setForm.
function genIdCadastro(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `cad_${Date.now().toString(36)}_${random}`;
}

const initialForm: FormData = {
  id_cadastro: "",
  tipo_composicao: "1_carreta",
  carreta_proprietario_diferente: false,
  arquivos: {
    cnh: "",
    crlv_cavalo: "",
    crlv_carreta: "",
    comprovante_motorista: "",
    comprovante_proprietario: "",
    cartao_cnpj: "",
    cnh_proprietario: "",
    cartao_cnpj_carreta: "",
    cnh_proprietario_carreta: "",
    selfie_cnh: "",
    antt_cavalo: "",
    antt_carreta: "",
  },
  motorista: { ...emptyPessoa, tambem_proprietario: false, telefones: [""] },
  cnh: { ...emptyCNH },
  endereco_motorista: { ...emptyEndereco },
  cavalo: { ...emptyVeiculo },
  carreta: { ...emptyVeiculo },
  carretas_extras: [],
  proprietario_pj: { ...emptyProprietarioPJ },
  proprietario_pf: { ...emptyProprietarioPF },
  proprietario_pj_carreta: { ...emptyProprietarioPJ },
  proprietario_pf_carreta: { ...emptyProprietarioPF },
  cnh_proprietario_pf: { ...emptyCNH },
  cnh_proprietario_pf_carreta: { ...emptyCNH },
  operacional: {
    tag_pedagio: "",
    possui_pancary: false,
    rastreador: { marca: "", numero: "", arquivo: "" },
  },
  proprietario_antt_cavalo: {
    igual_proprietario_veiculo: true,
    tipo: "",
    proprietario_pj: { ...emptyProprietarioPJ },
    proprietario_pf: { ...emptyProprietarioPF },
    cnh_proprietario_pf: { ...emptyCNH },
  },
  proprietario_antt_carreta: {
    igual_proprietario_veiculo: true,
    tipo: "",
    proprietario_pj: { ...emptyProprietarioPJ },
    proprietario_pf: { ...emptyProprietarioPF },
    cnh_proprietario_pf: { ...emptyCNH },
  },
};

// ───────────────────────────── Formatadores e constantes ─────────────────────────────

const onlyDigits = (value: string) => value.replace(/\D/g, "");

const formatCpf = (value: string) =>
  onlyDigits(value)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");

const formatCnpj = (value: string) =>
  onlyDigits(value)
    .slice(0, 14)
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");

const formatPlaca = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 7);

const formatCep = (value: string) =>
  onlyDigits(value)
    .slice(0, 8)
    .replace(/(\d{5})(\d)/, "$1-$2");

const formatTelefone = (value: string) => {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length === 0) return "";
  if (digits.length <= 10) {
    return digits.replace(/(\d{2})(\d{0,4})(\d{0,4}).*/, (_, a, b, c) =>
      [a && `(${a})`, b && ` ${b}`, c && `-${c}`].filter(Boolean).join(""),
    );
  }
  return digits.replace(/(\d{2})(\d{5})(\d{0,4}).*/, (_, a, b, c) =>
    [a && `(${a})`, b && ` ${b}`, c && `-${c}`].filter(Boolean).join(""),
  );
};

const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

const CATEGORIAS_CNH = ["A", "B", "AB", "C", "D", "E", "AC", "AD", "AE"];

const ESTADOS_CIVIS = [
  { value: "SOLTEIRO", label: "Solteiro(a)" },
  { value: "CASADO", label: "Casado(a)" },
  { value: "DIVORCIADO", label: "Divorciado(a)" },
  { value: "VIUVO", label: "Viuvo(a)" },
  { value: "SEPARADO", label: "Separado(a)" },
  { value: "UNIAO_ESTAVEL", label: "Uniao Estavel" },
];

const CORES_RACAS = [
  { value: "BRANCA", label: "Branca" },
  { value: "PRETA", label: "Preta" },
  { value: "PARDA", label: "Parda" },
  { value: "AMARELA", label: "Amarela" },
  { value: "INDIGENA", label: "Indigena" },
  { value: "NAO_DECLARADO", label: "Nao declarado" },
];

const formatPis = (value: string) =>
  onlyDigits(value)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{5})(\d)/, "$1.$2")
    .replace(/(\d{2})(\d)$/, "$1-$2");

// Tags de pedagio (catalogo do guia AngelLira).
const TAGS_PEDAGIO = [
  { value: "SEM_PARAR", label: "Sem Parar" },
  { value: "CONECTCAR", label: "ConectCar" },
  { value: "MOVE_MAIS", label: "Move Mais" },
  { value: "VELOE", label: "Veloe" },
  { value: "ENDERED", label: "Endered" },
  { value: "NAO_POSSUI", label: "Nao possui" },
];

// Top bancos brasileiros — usuario tambem pode digitar livremente o codigo.
const BANCOS_COMUNS = [
  { codigo: "001", nome: "Banco do Brasil" },
  { codigo: "033", nome: "Santander" },
  { codigo: "077", nome: "Inter" },
  { codigo: "104", nome: "Caixa Economica Federal" },
  { codigo: "212", nome: "Banco Original" },
  { codigo: "237", nome: "Bradesco" },
  { codigo: "260", nome: "Nu Pagamentos (Nubank)" },
  { codigo: "290", nome: "PagBank" },
  { codigo: "323", nome: "Mercado Pago" },
  { codigo: "336", nome: "C6 Bank" },
  { codigo: "341", nome: "Itau Unibanco" },
  { codigo: "380", nome: "PicPay" },
  { codigo: "422", nome: "Banco Safra" },
  { codigo: "655", nome: "Banco Votorantim / BV" },
  { codigo: "748", nome: "Sicredi" },
  { codigo: "756", nome: "Sicoob" },
];

// ───────────────────────────── Classes de UI ─────────────────────────────

const inputBase =
  "admin-input-surface w-full rounded-xl border py-3 text-sm outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10";
const inputWithIcon = `${inputBase} pl-11 pr-4`;
const inputNoIcon = `${inputBase} px-4`;
const labelClasses = "text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground";
const sectionTitleClasses = "text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-primary/80";
const subSectionClasses = "text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-foreground/70";

// ───────────────────────────── Sub-componentes de UI ─────────────────────────────

type IconType = typeof User;

const Field = ({
  label,
  icon: Icon,
  children,
  span,
  error,
}: {
  label: string;
  icon?: IconType;
  children: React.ReactNode;
  span?: "full" | "half";
  error?: string;
}) => (
  <div className={`space-y-1.5 ${span === "full" ? "sm:col-span-2" : ""}`}>
    <label className={labelClasses}>{label}</label>
    <div className={`relative ${error ? "[&>input]:border-destructive [&>select]:border-destructive [&_input]:border-destructive [&_select]:border-destructive" : ""}`}>
      {Icon ? (
        <Icon className={`absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 ${error ? "text-destructive" : "text-muted-foreground"}`} />
      ) : null}
      {children}
    </div>
    {error ? (
      <p className="text-xs font-medium text-destructive">{error}</p>
    ) : null}
  </div>
);

const TextInput = ({
  value,
  onChange,
  icon,
  placeholder,
  required,
  inputMode,
  maxLength,
  type = "text",
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  icon?: IconType;
  placeholder?: string;
  required?: boolean;
  inputMode?: "text" | "numeric" | "tel" | "email";
  maxLength?: number;
  type?: string;
  disabled?: boolean;
}) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    required={required}
    inputMode={inputMode}
    maxLength={maxLength}
    disabled={disabled}
    className={`${icon ? inputWithIcon : inputNoIcon} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
  />
);

const SelectInput = ({
  value,
  onChange,
  options,
  required,
  icon,
  placeholder = "Selecione",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  required?: boolean;
  icon?: IconType;
  placeholder?: string;
}) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    required={required}
    className={icon ? inputWithIcon : inputNoIcon}
  >
    <option value="" disabled>
      {placeholder}
    </option>
    {options.map((opt) => (
      <option key={opt.value} value={opt.value}>
        {opt.label}
      </option>
    ))}
  </select>
);

const FileUploadField = ({
  label,
  value,
  onChange,
  onFile,
  required,
  accept = "image/*,application/pdf",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onFile?: (file: File) => void | Promise<void>;
  required?: boolean;
  accept?: string;
}) => {
  const id = useMemo(() => `file-${Math.random().toString(36).slice(2, 9)}`, []);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-1.5">
      <label className={labelClasses}>{label}</label>
      <label
        htmlFor={id}
        className={`admin-input-surface flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-all duration-200 hover:border-primary/30 ${
          busy ? "cursor-wait opacity-80" : "cursor-pointer"
        }`}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : (
          <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className={`flex-1 truncate ${value ? "text-foreground" : "text-muted-foreground"}`}>
          {busy ? "Processando documento..." : value || "Selecionar arquivo (PDF, JPG, PNG)"}
        </span>
      </label>
      <input
        id={id}
        type="file"
        accept={accept}
        required={required && !value}
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) {
            onChange("");
            return;
          }
          onChange(file.name);
          if (onFile) {
            setBusy(true);
            try {
              await onFile(file);
            } finally {
              setBusy(false);
            }
          }
        }}
        className="hidden"
      />
    </div>
  );
};

const TelefonesField = ({
  values,
  onChange,
}: {
  values: string[];
  onChange: (v: string[]) => void;
}) => {
  const update = (idx: number, value: string) => {
    const next = [...values];
    next[idx] = formatTelefone(value);
    onChange(next);
  };
  const add = () => onChange([...values, ""]);
  const remove = (idx: number) => onChange(values.filter((_, i) => i !== idx));

  return (
    <div className="space-y-2 sm:col-span-2">
      <label className={labelClasses}>Telefones</label>
      <div className="space-y-2">
        {values.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhum telefone informado.</p>
        ) : (
          values.map((tel, idx) => {
            const telError = validateTelefone(tel).reason;
            return (
              <div key={idx} className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Phone
                      className={`absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 ${
                        telError ? "text-destructive" : "text-muted-foreground"
                      }`}
                    />
                    <input
                      type="tel"
                      value={tel}
                      onChange={(e) => update(idx, e.target.value)}
                      placeholder="(00) 00000-0000"
                      inputMode="numeric"
                      className={`${inputWithIcon} ${telError ? "border-destructive" : ""}`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                    aria-label="Remover telefone"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {telError ? (
                  <p className="text-xs font-medium text-destructive">{telError}</p>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/[0.04] px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
      >
        <Plus className="h-3.5 w-3.5" />
        Adicionar telefone
      </button>
    </div>
  );
};

// ───────────────────────────── Grupos reutilizáveis ─────────────────────────────

const PessoaFields = ({
  value,
  onChange,
  required,
}: {
  value: PessoaBase;
  onChange: (v: PessoaBase) => void;
  required?: boolean;
}) => {
  const set = <K extends keyof PessoaBase>(k: K, v: PessoaBase[K]) =>
    onChange({ ...value, [k]: v });
  return (
    <>
      <Field label="Nome completo" icon={User} span="full">
        <TextInput value={value.nome} onChange={(v) => set("nome", v)} required={required} icon={User} />
      </Field>
      <Field label="CPF" icon={Fingerprint} error={validateCpf(value.cpf).reason}>
        <TextInput
          value={value.cpf}
          onChange={(v) => set("cpf", formatCpf(v))}
          required={required}
          inputMode="numeric"
          icon={Fingerprint}
          placeholder="000.000.000-00"
        />
      </Field>
      <Field label="Data de nascimento" icon={Calendar}>
        <TextInput
          type="date"
          value={value.data_nascimento}
          onChange={(v) => set("data_nascimento", v)}
          required={required}
          icon={Calendar}
        />
      </Field>
      <Field label="Nome do pai" icon={User}>
        <TextInput value={value.nome_pai} onChange={(v) => set("nome_pai", v)} icon={User} />
      </Field>
      <Field label="Nome da mae" icon={User}>
        <TextInput value={value.nome_mae} onChange={(v) => set("nome_mae", v)} required={required} icon={User} />
      </Field>
      <Field label="Naturalidade" icon={MapPin}>
        <TextInput
          value={value.naturalidade}
          onChange={(v) => set("naturalidade", v)}
          icon={MapPin}
          placeholder="Cidade / UF de nascimento"
        />
      </Field>
      <Field label="RG" icon={Hash}>
        <TextInput value={value.rg} onChange={(v) => set("rg", v)} icon={Hash} required={required} />
      </Field>
      <Field label="Orgao emissor">
        <TextInput value={value.rg_orgao} onChange={(v) => set("rg_orgao", v)} placeholder="Ex.: SSP" />
      </Field>
      <Field label="UF emissor">
        <SelectInput
          value={value.rg_uf}
          onChange={(v) => set("rg_uf", v)}
          options={UFS.map((uf) => ({ value: uf, label: uf }))}
          placeholder="UF"
        />
      </Field>
    </>
  );
};

const EnderecoFields = ({
  value,
  onChange,
  required,
}: {
  value: Endereco;
  onChange: (v: Endereco) => void;
  required?: boolean;
}) => {
  const set = <K extends keyof Endereco>(k: K, v: Endereco[K]) => onChange({ ...value, [k]: v });
  const [cepLoading, setCepLoading] = useState(false);
  const { toast } = useToast();

  const handleCepLookup = async () => {
    if (onlyDigits(value.cep).length !== 8) {
      toast({
        title: "CEP invalido",
        description: "Digite os 8 digitos do CEP.",
        variant: "destructive",
      });
      return;
    }
    setCepLoading(true);
    try {
      const result = await consultaCep(value.cep);
      onChange({
        ...value,
        uf: result.uf || value.uf,
        cidade: result.cidade || value.cidade,
        bairro: result.bairro || value.bairro,
        logradouro: result.logradouro || value.logradouro,
      });
      toast({
        title: "CEP encontrado",
        description: "Endereco preenchido automaticamente.",
      });
    } catch (e) {
      toast({
        title: "Falha ao consultar CEP",
        description: e instanceof Error ? e.message : "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setCepLoading(false);
    }
  };

  return (
    <>
      {(() => {
        const cepError = validateCep(value.cep).reason;
        return (
          <div className="space-y-1.5">
            <label className={labelClasses}>CEP</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <MapPin
                  className={`absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 ${
                    cepError ? "text-destructive" : "text-muted-foreground"
                  }`}
                />
                <input
                  type="text"
                  value={value.cep}
                  onChange={(e) => set("cep", formatCep(e.target.value))}
                  required={required}
                  inputMode="numeric"
                  placeholder="00000-000"
                  className={`${inputWithIcon} ${cepError ? "border-destructive" : ""}`}
                />
              </div>
              <button
                type="button"
                onClick={handleCepLookup}
                disabled={cepLoading || !value.cep}
                className="admin-input-surface inline-flex h-12 shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-semibold text-foreground/80 transition-all hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
                title="Buscar endereco via CEP"
              >
                {cepLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">Buscar</span>
              </button>
            </div>
            {cepError ? (
              <p className="text-xs font-medium text-destructive">{cepError}</p>
            ) : null}
          </div>
        );
      })()}
      <Field label="UF">
        <SelectInput
          value={value.uf}
          onChange={(v) => set("uf", v)}
          options={UFS.map((uf) => ({ value: uf, label: uf }))}
          required={required}
          placeholder="UF"
        />
      </Field>
      <Field label="Cidade">
        <TextInput value={value.cidade} onChange={(v) => set("cidade", v)} required={required} />
      </Field>
      <Field label="Bairro">
        <TextInput value={value.bairro} onChange={(v) => set("bairro", v)} required={required} />
      </Field>
      <Field label="Logradouro" span="full">
        <TextInput
          value={value.logradouro}
          onChange={(v) => set("logradouro", v)}
          required={required}
          placeholder="Rua, avenida, travessa..."
        />
      </Field>
      <Field label="Numero">
        <TextInput value={value.numero} onChange={(v) => set("numero", v)} required={required} />
      </Field>
    </>
  );
};

const CnhFields = ({
  value,
  onChange,
  required,
}: {
  value: CNHData;
  onChange: (v: CNHData) => void;
  required?: boolean;
}) => {
  const set = <K extends keyof CNHData>(k: K, v: CNHData[K]) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label="N. de registro" icon={Hash} error={validateCnhRegistro(value.registro).reason}>
        <TextInput
          value={value.registro}
          onChange={(v) => set("registro", onlyDigits(v).slice(0, 11))}
          required={required}
          inputMode="numeric"
          icon={Hash}
          placeholder="11 digitos"
          maxLength={11}
        />
      </Field>
      <Field label="Categoria">
        <SelectInput
          value={value.categoria}
          onChange={(v) => set("categoria", v)}
          options={CATEGORIAS_CNH.map((c) => ({ value: c, label: c }))}
          required={required}
        />
      </Field>
      <Field label="Codigo de seguranca">
        <TextInput
          value={value.codigo_seguranca}
          onChange={(v) => set("codigo_seguranca", v)}
          placeholder="Verso da CNH"
        />
      </Field>
      <Field label="Numero do espelho">
        <TextInput
          value={value.numero_espelho}
          onChange={(v) => set("numero_espelho", v)}
          placeholder="Numero do espelho"
        />
      </Field>
      <Field label="UF emissor">
        <SelectInput
          value={value.uf_emissor}
          onChange={(v) => set("uf_emissor", v)}
          options={UFS.map((uf) => ({ value: uf, label: uf }))}
          required={required}
          placeholder="UF"
        />
      </Field>
      <Field label="Validade" icon={Calendar}>
        <TextInput
          type="date"
          value={value.validade}
          onChange={(v) => set("validade", v)}
          required={required}
          icon={Calendar}
        />
      </Field>
      <Field label="Primeira emissao" icon={Calendar}>
        <TextInput
          type="date"
          value={value.primeira_emissao}
          onChange={(v) => set("primeira_emissao", v)}
          icon={Calendar}
        />
      </Field>
    </>
  );
};

const VeiculoFields = ({
  value,
  onChange,
  required,
  crlvSnapshot,
}: {
  value: Veiculo;
  onChange: (v: Veiculo) => void;
  required?: boolean;
  crlvSnapshot?: { placa: string; chassi: string; renavam: string };
}) => {
  const set = <K extends keyof Veiculo>(k: K, v: Veiculo[K]) => onChange({ ...value, [k]: v });

  // Cross-check com OCR do CRLV (quando disponivel). Verde = bate, ambar =
  // divergente. Tolerante a vazio (se snapshot esta vazio para um campo, nao
  // faz a comparacao). Comparacao normalizada (uppercase + so alfanumerico).
  const normalize = (s: string) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const compareWithSnap = (campo: "placa" | "chassi" | "renavam") => {
    if (!crlvSnapshot) return null;
    const ocr = normalize(crlvSnapshot[campo]);
    if (!ocr) return null;
    const atual = normalize(value[campo]);
    if (!atual) return null;
    return atual === ocr ? "match" : "diff";
  };

  const placaCheck = compareWithSnap("placa");
  const chassiCheck = compareWithSnap("chassi");
  const renavamCheck = compareWithSnap("renavam");

  const renderCheckBadge = (status: "match" | "diff" | null, ocrValue?: string) => {
    if (!status) return null;
    if (status === "match") {
      return (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-600">
          <CheckCircle2 className="h-3 w-3" />
          Confere com o CRLV
        </p>
      );
    }
    return (
      <p className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-700 dark:text-amber-500">
        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Diverge do CRLV
          {ocrValue ? <> (extraído: <strong>{ocrValue}</strong>)</> : null}
        </span>
      </p>
    );
  };

  return (
    <>
      <Field label="Placa" icon={FileBadge} error={validatePlaca(value.placa).reason}>
        <TextInput
          value={value.placa}
          onChange={(v) => set("placa", formatPlaca(v))}
          required={required}
          icon={FileBadge}
          placeholder="ABC1D23"
          maxLength={7}
        />
        {renderCheckBadge(placaCheck, crlvSnapshot?.placa)}
      </Field>
      <Field label="Tipo">
        <TextInput
          value={value.tipo}
          onChange={(v) => set("tipo", v)}
          placeholder="Ex.: Cavalo mecanico"
          required={required}
        />
      </Field>
      <Field label="Carroceria">
        <TextInput
          value={value.carroceria}
          onChange={(v) => set("carroceria", v)}
          placeholder="Ex.: Graneleira, Bau, Sider"
        />
      </Field>
      <Field label="Proprietario (nome no CRLV)" icon={User}>
        <TextInput
          value={value.proprietario}
          onChange={(v) => set("proprietario", v)}
          icon={User}
        />
      </Field>
      <Field label="Marca">
        <TextInput value={value.marca} onChange={(v) => set("marca", v)} required={required} />
      </Field>
      <Field label="Modelo">
        <TextInput value={value.modelo} onChange={(v) => set("modelo", v)} required={required} />
      </Field>
      <Field label="Ano fabricacao" icon={Calendar}>
        <TextInput
          value={value.ano_fabricacao}
          onChange={(v) => set("ano_fabricacao", onlyDigits(v).slice(0, 4))}
          inputMode="numeric"
          icon={Calendar}
          placeholder="AAAA"
          required={required}
          maxLength={4}
        />
      </Field>
      <Field label="Ano modelo" icon={Calendar}>
        <TextInput
          value={value.ano_modelo}
          onChange={(v) => set("ano_modelo", onlyDigits(v).slice(0, 4))}
          inputMode="numeric"
          icon={Calendar}
          placeholder="AAAA"
          required={required}
          maxLength={4}
        />
      </Field>
      <Field label="Cor">
        <TextInput value={value.cor} onChange={(v) => set("cor", v)} required={required} />
      </Field>
      <Field label="UF emplacamento">
        <SelectInput
          value={value.uf_emplacamento}
          onChange={(v) => set("uf_emplacamento", v)}
          options={UFS.map((uf) => ({ value: uf, label: uf }))}
          placeholder="UF"
        />
      </Field>
      <Field label="Cidade emplacamento">
        <TextInput value={value.cidade_emplacamento} onChange={(v) => set("cidade_emplacamento", v)} />
      </Field>
      <Field label="Renavam" icon={Hash} error={validateRenavam(value.renavam).reason}>
        <TextInput
          value={value.renavam}
          onChange={(v) => set("renavam", onlyDigits(v).slice(0, 11))}
          inputMode="numeric"
          icon={Hash}
          placeholder="11 digitos"
          required={required}
          maxLength={11}
        />
        {renderCheckBadge(renavamCheck, crlvSnapshot?.renavam)}
      </Field>
      <Field label="Chassi" error={validateChassi(value.chassi).reason}>
        <TextInput
          value={value.chassi}
          onChange={(v) => set("chassi", v.toUpperCase().slice(0, 17))}
          placeholder="17 caracteres"
          required={required}
          maxLength={17}
        />
        {renderCheckBadge(chassiCheck, crlvSnapshot?.chassi)}
      </Field>
      <Field label="Eixos">
        <TextInput
          value={value.eixos}
          onChange={(v) => set("eixos", onlyDigits(v).slice(0, 2))}
          inputMode="numeric"
          maxLength={2}
        />
      </Field>
      <Field label="Frota">
        <TextInput value={value.frota} onChange={(v) => set("frota", v)} placeholder="Identificacao interna" />
      </Field>
      <Field label="ANTT (RNTRC)">
        <TextInput value={value.antt} onChange={(v) => set("antt", v)} />
      </Field>
      <Field label="Ultimo licenciamento" icon={Calendar}>
        <TextInput
          type="date"
          value={value.ultimo_licenciamento}
          onChange={(v) => set("ultimo_licenciamento", v)}
          icon={Calendar}
        />
      </Field>
    </>
  );
};

// Consulta CNPJ via API local (FastAPI :8765 -> proxy /ocr-api).
// Plugado em: campo CNPJ dos blocos PJ + auto-preenchimento via CRLV (quando o
// proprietario do veiculo for PJ).
async function fetchCnpjData(
  cnpj: string,
): Promise<{ campos: Partial<ProprietarioPJ>; result: CnpjConsultaResult }> {
  const result = await consultaCnpj(cnpj);
  const telefones = result.telefones.map(formatTelefone).filter(Boolean);

  return {
    campos: {
      ...(result.nome ? { nome: result.nome } : {}),
      ...(result.cep ? { cep: formatCep(result.cep) } : {}),
      ...(result.uf ? { uf: result.uf } : {}),
      ...(result.cidade ? { cidade: result.cidade } : {}),
      ...(result.bairro ? { bairro: result.bairro } : {}),
      ...(result.logradouro ? { logradouro: result.logradouro } : {}),
      ...(result.numero ? { numero: result.numero } : {}),
      ...(telefones.length ? { telefones } : {}),
    },
    result,
  };
}

const CnpjLookupField = ({
  value,
  onChange,
  onLookup,
  loading,
}: {
  value: string;
  onChange: (v: string) => void;
  onLookup: () => void;
  loading: boolean;
}) => {
  const cnpjError = validateCnpj(value).reason;
  return (
    <div className="space-y-1.5">
      <label className={labelClasses}>CNPJ</label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Building2
            className={`absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 ${
              cnpjError ? "text-destructive" : "text-muted-foreground"
            }`}
          />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(formatCnpj(e.target.value))}
            required
            inputMode="numeric"
            placeholder="00.000.000/0000-00"
            className={`${inputWithIcon} ${cnpjError ? "border-destructive" : ""}`}
          />
        </div>
        <button
          type="button"
          onClick={onLookup}
          disabled={loading || !value || !!cnpjError}
          className="admin-input-surface inline-flex h-12 shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-semibold text-foreground/80 transition-all hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
          title="Buscar dados via CNPJ"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="hidden sm:inline">Buscar</span>
        </button>
      </div>
      {cnpjError ? (
        <p className="text-xs font-medium text-destructive">{cnpjError}</p>
      ) : null}
    </div>
  );
};

const DadosBancariosFields = ({
  value,
  onChange,
}: {
  value: DadosBancarios;
  onChange: (v: DadosBancarios) => void;
}) => {
  const set = <K extends keyof DadosBancarios>(k: K, v: DadosBancarios[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <>
      <Field label="Banco" icon={Building2} span="full">
        <SelectInput
          value={value.banco_codigo}
          onChange={(codigo) => {
            const banco = BANCOS_COMUNS.find((b) => b.codigo === codigo);
            onChange({
              ...value,
              banco_codigo: codigo,
              banco_nome: banco?.nome ?? value.banco_nome,
            });
          }}
          options={BANCOS_COMUNS.map((b) => ({
            value: b.codigo,
            label: `${b.codigo} - ${b.nome}`,
          }))}
          icon={Building2}
          placeholder="Selecione o banco"
        />
      </Field>
      <Field label="Agencia" icon={Hash}>
        <TextInput
          value={value.agencia}
          onChange={(v) => set("agencia", onlyDigits(v).slice(0, 6))}
          placeholder="0000"
          inputMode="numeric"
          icon={Hash}
          maxLength={6}
        />
      </Field>
      <Field label="Conta (com digito)" icon={Hash}>
        <TextInput
          value={value.conta}
          onChange={(v) => set("conta", v.replace(/[^\d-]/g, "").slice(0, 15))}
          placeholder="000000-0"
          inputMode="numeric"
          icon={Hash}
        />
      </Field>
      <Field label="Tipo de conta">
        <SelectInput
          value={value.tipo}
          onChange={(v) => set("tipo", v as DadosBancarios["tipo"])}
          options={[
            { value: "corrente", label: "Conta Corrente" },
            { value: "poupanca", label: "Conta Poupanca" },
          ]}
        />
      </Field>
    </>
  );
};

const ProprietarioPJFields = ({
  value,
  onChange,
  onCnpjResult,
}: {
  value: ProprietarioPJ;
  onChange: (v: ProprietarioPJ) => void;
  onCnpjResult?: (result: CnpjConsultaResult) => void;
}) => {
  const set = <K extends keyof ProprietarioPJ>(k: K, v: ProprietarioPJ[K]) =>
    onChange({ ...value, [k]: v });
  const [lookupLoading, setLookupLoading] = useState(false);
  const { toast } = useToast();

  const handleLookup = async () => {
    if (onlyDigits(value.cnpj).length !== 14) {
      toast({
        title: "CNPJ invalido",
        description: "Digite os 14 digitos do CNPJ.",
        variant: "destructive",
      });
      return;
    }
    setLookupLoading(true);
    try {
      const { campos, result } = await fetchCnpjData(value.cnpj);
      onChange({ ...value, ...campos });
      onCnpjResult?.(result);
      toast({
        title: "Dados encontrados",
        description: result.situacao
          ? `${result.nome} - Situacao: ${result.situacao}`
          : "Os campos abaixo foram preenchidos automaticamente.",
      });
    } catch (error) {
      toast({
        title: "Nao foi possivel consultar",
        description:
          error instanceof Error ? error.message : "Tente novamente em instantes.",
        variant: "destructive",
      });
    } finally {
      setLookupLoading(false);
    }
  };

  return (
    <>
      <Field label="Razao social" icon={Building2} span="full">
        <TextInput value={value.nome} onChange={(v) => set("nome", v)} required icon={Building2} />
      </Field>
      <CnpjLookupField
        value={value.cnpj}
        onChange={(v) => set("cnpj", v)}
        onLookup={handleLookup}
        loading={lookupLoading}
      />
      <Field label="Inscricao Estadual" icon={Hash}>
        <div className="space-y-2">
          <TextInput
            value={value.isento_ie ? "ISENTO" : value.inscricao_estadual}
            onChange={(v) => set("inscricao_estadual", v)}
            placeholder="Numero da IE"
            icon={Hash}
            disabled={value.isento_ie}
          />
          <label className="flex items-center gap-2 text-xs text-foreground/85">
            <input
              type="checkbox"
              checked={value.isento_ie}
              onChange={(e) => {
                const checked = e.target.checked;
                onChange({
                  ...value,
                  isento_ie: checked,
                  inscricao_estadual: checked ? "ISENTO" : "",
                });
              }}
              className="h-4 w-4 rounded border-primary/30 text-primary focus:ring-primary"
            />
            Empresa <strong>isenta</strong> de Inscricao Estadual
          </label>
        </div>
      </Field>
      <TelefonesField values={value.telefones} onChange={(v) => set("telefones", v)} />
      <EnderecoFields value={value} onChange={(addr) => onChange({ ...value, ...addr })} required />
      <div className="sm:col-span-2 mt-2 border-t border-border/60 pt-3">
        <p className={`${labelClasses} mb-3`}>Dados bancarios</p>
      </div>
      <DadosBancariosFields
        value={value.dados_bancarios}
        onChange={(v) => onChange({ ...value, dados_bancarios: v })}
      />
    </>
  );
};

const ProprietarioPFFields = ({
  value,
  onChange,
}: {
  value: ProprietarioPF;
  onChange: (v: ProprietarioPF) => void;
}) => {
  const setPessoa = (p: PessoaBase) => onChange({ ...value, ...p });
  const setEndereco = (a: Endereco) => onChange({ ...value, ...a });
  return (
    <>
      <PessoaFields value={value} onChange={setPessoa} required />
      <Field
        label="Cartao PIS / NIS / PASEP"
        icon={Hash}
        error={validatePis(value.cartao_pis).reason}
      >
        <TextInput
          value={value.cartao_pis}
          onChange={(v) => onChange({ ...value, cartao_pis: formatPis(v) })}
          placeholder="000.00000.00-0"
          inputMode="numeric"
          icon={Hash}
        />
      </Field>
      <Field label="Estado civil">
        <SelectInput
          value={value.estado_civil}
          onChange={(v) => onChange({ ...value, estado_civil: v })}
          options={ESTADOS_CIVIS}
        />
      </Field>
      <Field label="Cor / Raca (IBGE)">
        <SelectInput
          value={value.cor_raca}
          onChange={(v) => onChange({ ...value, cor_raca: v })}
          options={CORES_RACAS}
        />
      </Field>
      <Field label="Situacao">
        <TextInput
          value={value.situacao}
          onChange={(v) => onChange({ ...value, situacao: v })}
          placeholder="Ex.: Ativo, Aposentado..."
        />
      </Field>
      <TelefonesField
        values={value.telefones}
        onChange={(v) => onChange({ ...value, telefones: v })}
      />
      <EnderecoFields value={value} onChange={setEndereco} required />
      <div className="sm:col-span-2 mt-2 border-t border-border/60 pt-3">
        <p className={`${labelClasses} mb-3`}>Dados bancarios</p>
      </div>
      <DadosBancariosFields
        value={value.dados_bancarios}
        onChange={(v) => onChange({ ...value, dados_bancarios: v })}
      />
    </>
  );
};

// ───────────────────────────── Wrappers de seção ─────────────────────────────

const Section = ({
  title,
  icon: Icon,
  description,
  children,
  collapsible,
  defaultOpen = true,
  badge,
}: {
  title: string;
  icon: IconType;
  description?: string;
  children: React.ReactNode;
  /** Quando true, a seção pode ser colapsada via chevron no header */
  collapsible?: boolean;
  /** Estado inicial quando collapsible — default aberto para preservar UX prévia */
  defaultOpen?: boolean;
  /** Texto pequeno opcional ao lado do chevron, ex: "5 campos preenchidos" */
  badge?: string;
}) => {
  const [open, setOpen] = useState(defaultOpen);

  const HeaderInner = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex-1 space-y-0.5 text-left">
        <h3 className="text-sm font-semibold text-foreground sm:text-[0.95rem]">{title}</h3>
        {description ? (
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {collapsible ? (
        <div className="flex items-center gap-2">
          {badge ? (
            <span className="hidden sm:inline rounded-full border border-primary/15 bg-primary/[0.06] px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary/80">
              {badge}
            </span>
          ) : null}
          <span className="hidden text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground sm:inline">
            {open ? "Ocultar detalhes" : "Verificar detalhes"}
          </span>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </div>
      ) : null}
    </>
  );

  return (
    <section className="admin-card-surface overflow-hidden rounded-xl border shadow-[0_2px_12px_-8px_rgba(15,23,42,0.08)]">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-start gap-3 border-b border-border/60 bg-gradient-to-br from-primary/[0.04] via-card to-card px-5 py-4 transition-colors hover:bg-primary/[0.05] sm:px-6 sm:py-5"
        >
          {HeaderInner}
        </button>
      ) : (
        <header className="flex items-start gap-3 border-b border-border/60 bg-gradient-to-br from-primary/[0.04] via-card to-card px-5 py-4 sm:px-6 sm:py-5">
          {HeaderInner}
        </header>
      )}
      {(!collapsible || open) && (
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 sm:p-6">{children}</div>
      )}
    </section>
  );
};

const SubSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="sm:col-span-2">
    <p className={`${subSectionClasses} mb-3 mt-2`}>{title}</p>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
  </div>
);

// ─── Status de validade CRLV ───
// CRLV e valido ate 31/12 do ano do `ultimo_licenciamento`. Apos essa data,
// o veiculo precisa de novo licenciamento (proximo exercicio).
function crlvStatusFromLicenciamento(licenciamentoIso: string): {
  level: "ok" | "soon" | "expired" | "unknown";
  label: string;
  validadeFmt: string;
  ultimoFmt: string;
  diasRestantes: number | null;
  anoExercicio: number | null;
} {
  if (!licenciamentoIso) {
    return {
      level: "unknown",
      label: "CRLV sem data de licenciamento",
      validadeFmt: "",
      ultimoFmt: "",
      diasRestantes: null,
      anoExercicio: null,
    };
  }
  const data = new Date(`${licenciamentoIso}T00:00:00`);
  if (Number.isNaN(data.getTime())) {
    return {
      level: "unknown",
      label: "Data de licenciamento invalida",
      validadeFmt: "",
      ultimoFmt: "",
      diasRestantes: null,
      anoExercicio: null,
    };
  }

  const anoExercicio = data.getFullYear();
  const fimDoAno = new Date(anoExercicio, 11, 31);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diasRestantes = Math.floor((fimDoAno.getTime() - today.getTime()) / 86400000);
  const validadeFmt = fimDoAno.toLocaleDateString("pt-BR");
  const ultimoFmt = data.toLocaleDateString("pt-BR");

  if (diasRestantes < 0) {
    const diasAtraso = -diasRestantes;
    return {
      level: "expired",
      label: `CRLV vencido ha ${diasAtraso} dia${diasAtraso === 1 ? "" : "s"} (exercicio ${anoExercicio})`,
      validadeFmt,
      ultimoFmt,
      diasRestantes,
      anoExercicio,
    };
  }
  if (diasRestantes <= 60) {
    return {
      level: "soon",
      label: `CRLV vence em ${diasRestantes} dia${diasRestantes === 1 ? "" : "s"}`,
      validadeFmt,
      ultimoFmt,
      diasRestantes,
      anoExercicio,
    };
  }
  return {
    level: "ok",
    label: `CRLV vigente (exercicio ${anoExercicio})`,
    validadeFmt,
    ultimoFmt,
    diasRestantes,
    anoExercicio,
  };
}

const CrlvStatusCard = ({
  ultimoLicenciamento,
  placa,
  onlineResult,
  onlineLoading,
  onVerifyOnline,
}: {
  ultimoLicenciamento: string;
  placa: string;
  onlineResult?: VeiculoSituacaoResult;
  onlineLoading?: boolean;
  onVerifyOnline?: () => void;
}) => {
  const status = crlvStatusFromLicenciamento(ultimoLicenciamento);

  const styles: Record<typeof status.level, { border: string; bg: string; iconWrap: string; Icon: typeof ShieldCheck }> = {
    ok: {
      border: "border-emerald-500/30",
      bg: "bg-emerald-500/[0.06]",
      iconWrap: "bg-emerald-500/15 text-emerald-600",
      Icon: ShieldCheck,
    },
    soon: {
      border: "border-amber-500/30",
      bg: "bg-amber-500/[0.06]",
      iconWrap: "bg-amber-500/15 text-amber-600",
      Icon: ShieldAlert,
    },
    expired: {
      border: "border-destructive/30",
      bg: "bg-destructive/[0.06]",
      iconWrap: "bg-destructive/15 text-destructive",
      Icon: ShieldAlert,
    },
    unknown: {
      border: "border-border",
      bg: "bg-muted/30",
      iconWrap: "bg-muted text-muted-foreground",
      Icon: ShieldAlert,
    },
  };

  const s = styles[status.level];
  const Icon = s.Icon;

  return (
    <div className={`sm:col-span-2 rounded-xl border px-4 py-4 ${s.border} ${s.bg}`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${s.iconWrap}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold text-foreground">{status.label}</p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {placa && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Placa</dt>
                <dd className="text-foreground/90">{placa}</dd>
              </div>
            )}
            {status.ultimoFmt && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Ultimo licenciamento</dt>
                <dd className="text-foreground/90">{status.ultimoFmt}</dd>
              </div>
            )}
            {status.validadeFmt && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                  {status.level === "expired" ? "Venceu em" : "Vigente ate"}
                </dt>
                <dd className="text-foreground/90">{status.validadeFmt}</dd>
              </div>
            )}
          </dl>
          {status.level === "expired" && (
            <p className="text-xs leading-5 text-destructive/85">
              <strong>Atencao:</strong> veiculo com CRLV vencido nao pode circular. E necessario
              fazer o novo licenciamento (exercicio {(status.anoExercicio ?? 0) + 1}) antes de
              aprovar o cadastro.
            </p>
          )}
          {status.level === "soon" && (
            <p className="text-xs leading-5 text-amber-700 dark:text-amber-400">
              <strong>Aviso:</strong> o CRLV vence em breve. Recomende renovar antes do
              vencimento para evitar circular irregular.
            </p>
          )}
          {status.level === "unknown" && (
            <p className="text-xs leading-5 text-muted-foreground">
              Anexe o CRLV ou preencha o campo "Ultimo licenciamento" para verificar.
            </p>
          )}

          {/* Botao de verificacao online (DENATRAN/SINESP) */}
          {onVerifyOnline && (
            <div className="pt-2">
              <button
                type="button"
                onClick={onVerifyOnline}
                disabled={onlineLoading || !placa || placa.replace(/[^A-Z0-9]/gi, "").length !== 7}
                className="admin-input-surface inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold text-foreground/80 transition-all hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
                title="Consulta DENATRAN/SINESP por placa (paga, ~R$ 0,50-1,50)"
              >
                {onlineLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                <span>
                  {onlineLoading
                    ? "Consultando DENATRAN..."
                    : "Verificar situacao online (DENATRAN)"}
                </span>
              </button>
            </div>
          )}

          {/* Resultado da consulta online */}
          {onlineResult && onlineResult.found && (
            <div
              className={`mt-2 rounded-xl border px-3 py-3 ${
                onlineResult.ok
                  ? "border-emerald-500/25 bg-emerald-500/[0.04]"
                  : "border-destructive/25 bg-destructive/[0.04]"
              }`}
            >
              <p className="text-xs font-semibold text-foreground">
                {onlineResult.ok ? "Veiculo regular" : "Atencao"} -{" "}
                {onlineResult.situacao || onlineResult.licenciamento_situacao || "?"}
              </p>
              <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 text-[0.7rem] sm:grid-cols-2">
                {onlineResult.licenciamento_situacao && (
                  <div>
                    <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                      Licenciamento
                    </dt>
                    <dd className="text-foreground/85">
                      {onlineResult.licenciamento_situacao}
                      {onlineResult.licenciamento_ano
                        ? ` - ${onlineResult.licenciamento_ano}`
                        : ""}
                    </dd>
                  </div>
                )}
                {onlineResult.ipva_situacao && (
                  <div>
                    <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                      IPVA
                    </dt>
                    <dd className="text-foreground/85">{onlineResult.ipva_situacao}</dd>
                  </div>
                )}
                {onlineResult.debitos_total && (
                  <div>
                    <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                      Debitos
                    </dt>
                    <dd className="text-foreground/85">{onlineResult.debitos_total}</dd>
                  </div>
                )}
                {onlineResult.multas_qtd && (
                  <div>
                    <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                      Multas
                    </dt>
                    <dd className="text-foreground/85">{onlineResult.multas_qtd}</dd>
                  </div>
                )}
                {onlineResult.restricoes && (
                  <div className="sm:col-span-2">
                    <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                      Restricoes
                    </dt>
                    <dd className="text-foreground/85">{onlineResult.restricoes}</dd>
                  </div>
                )}
              </dl>
              {onlineResult.produto_usado && (
                <p className="mt-1.5 text-[0.65rem] text-muted-foreground/70">
                  Fonte: {onlineResult.produto_usado}
                </p>
              )}
            </div>
          )}
          {onlineResult && !onlineResult.found && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Veiculo nao localizado em DENATRAN/SINESP.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

type CnhValidityLevel = "ok" | "soon" | "expired" | "unknown";

function cnhStatusFromValidade(validadeIso: string): {
  level: CnhValidityLevel;
  label: string;
  validadeFmt: string;
  diasRestantes: number | null;
} {
  if (!validadeIso) {
    return { level: "unknown", label: "Sem data de validade", validadeFmt: "", diasRestantes: null };
  }
  const expiry = new Date(`${validadeIso}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) {
    return { level: "unknown", label: "Data invalida", validadeFmt: "", diasRestantes: null };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diasRestantes = Math.floor((expiry.getTime() - today.getTime()) / 86400000);
  const validadeFmt = expiry.toLocaleDateString("pt-BR");

  if (diasRestantes < 0) {
    return {
      level: "expired",
      label: `CNH vencida ha ${-diasRestantes} dia${-diasRestantes === 1 ? "" : "s"}`,
      validadeFmt,
      diasRestantes,
    };
  }
  if (diasRestantes <= 30) {
    return {
      level: "soon",
      label: `CNH vence em ${diasRestantes} dia${diasRestantes === 1 ? "" : "s"}`,
      validadeFmt,
      diasRestantes,
    };
  }
  return {
    level: "ok",
    label: "CNH vigente",
    validadeFmt,
    diasRestantes,
  };
}

const CnhStatusCard = ({
  validade,
  categoria,
  registro,
}: {
  validade: string;
  categoria: string;
  registro: string;
}) => {
  const status = cnhStatusFromValidade(validade);

  const styles: Record<CnhValidityLevel, { border: string; bg: string; iconWrap: string; Icon: typeof ShieldCheck }> = {
    ok: {
      border: "border-emerald-500/30",
      bg: "bg-emerald-500/[0.06]",
      iconWrap: "bg-emerald-500/15 text-emerald-600",
      Icon: ShieldCheck,
    },
    soon: {
      border: "border-amber-500/30",
      bg: "bg-amber-500/[0.06]",
      iconWrap: "bg-amber-500/15 text-amber-600",
      Icon: ShieldAlert,
    },
    expired: {
      border: "border-destructive/30",
      bg: "bg-destructive/[0.06]",
      iconWrap: "bg-destructive/15 text-destructive",
      Icon: ShieldAlert,
    },
    unknown: {
      border: "border-border",
      bg: "bg-muted/30",
      iconWrap: "bg-muted text-muted-foreground",
      Icon: ShieldAlert,
    },
  };

  const s = styles[status.level];
  const Icon = s.Icon;

  return (
    <div className={`sm:col-span-2 rounded-xl border px-4 py-4 ${s.border} ${s.bg}`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${s.iconWrap}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold text-foreground">{status.label}</p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {status.validadeFmt && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                  Validade
                </dt>
                <dd className="text-foreground/90">{status.validadeFmt}</dd>
              </div>
            )}
            {registro && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                  Registro
                </dt>
                <dd className="text-foreground/90">{registro}</dd>
              </div>
            )}
            {categoria && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                  Categoria
                </dt>
                <dd className="text-foreground/90">{categoria}</dd>
              </div>
            )}
          </dl>
          {status.level === "expired" && (
            <p className="text-xs leading-5 text-destructive/85">
              <strong>Atencao:</strong> motorista nao pode dirigir com CNH vencida.
              Renove antes de aprovar o cadastro.
            </p>
          )}
          {status.level === "soon" && (
            <p className="text-xs leading-5 text-amber-700 dark:text-amber-400">
              <strong>Aviso:</strong> a CNH expira em breve. Recomende renovacao.
            </p>
          )}
          {status.level === "unknown" && (
            <p className="text-xs leading-5 text-muted-foreground">
              Anexe a CNH ou preencha o campo "Validade" para verificar.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

const CnpjStatusCard = ({ result }: { result: CnpjConsultaResult }) => {
  const ok = result.ok;
  const styles = ok
    ? {
        border: "border-emerald-500/30",
        bg: "bg-emerald-500/[0.06]",
        iconWrap: "bg-emerald-500/15 text-emerald-600",
      }
    : {
        border: "border-destructive/30",
        bg: "bg-destructive/[0.06]",
        iconWrap: "bg-destructive/15 text-destructive",
      };

  const fmtMoney = (s: string) => {
    if (!s) return "";
    const n = Number(String(s).replace(/[^\d.,]/g, "").replace(",", "."));
    if (Number.isNaN(n)) return s;
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  };

  return (
    <div className={`sm:col-span-2 rounded-xl border px-4 py-4 ${styles.border} ${styles.bg}`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${styles.iconWrap}`}>
          {ok ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        </div>
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-sm font-semibold text-foreground">
              CNPJ {ok ? "regular" : "irregular"} - {result.situacao || "?"}
            </p>
            {result.situacao_data && (
              <span className="text-xs text-muted-foreground">
                desde {result.situacao_data}
              </span>
            )}
          </div>
          {result.situacao_motivo && !ok && (
            <p className="text-xs text-destructive/85">
              <strong>Motivo:</strong> {result.situacao_motivo}
            </p>
          )}
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
            {result.nome_fantasia && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Nome fantasia</dt>
                <dd className="text-foreground/90">{result.nome_fantasia}</dd>
              </div>
            )}
            {result.abertura_data && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Abertura</dt>
                <dd className="text-foreground/90">{result.abertura_data}</dd>
              </div>
            )}
            {result.atividade_principal && (
              <div className="sm:col-span-2">
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">CNAE principal</dt>
                <dd className="text-foreground/90">
                  {result.atividade_principal_codigo && (
                    <span className="font-mono text-muted-foreground">
                      {result.atividade_principal_codigo}{" "}
                    </span>
                  )}
                  {result.atividade_principal}
                </dd>
              </div>
            )}
            {result.natureza_juridica && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Natureza juridica</dt>
                <dd className="text-foreground/90">{result.natureza_juridica}</dd>
              </div>
            )}
            {result.porte && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Porte</dt>
                <dd className="text-foreground/90">{result.porte}</dd>
              </div>
            )}
            {result.capital_social && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Capital social</dt>
                <dd className="text-foreground/90">{fmtMoney(result.capital_social)}</dd>
              </div>
            )}
            {result.email && (
              <div>
                <dt className="font-semibold uppercase tracking-wide text-muted-foreground">Email</dt>
                <dd className="text-foreground/90">{result.email}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  );
};

const AnttStatusCard = ({
  result,
  loading,
  onValidate,
  placa,
}: {
  result: AnttStatus | undefined;
  loading: boolean;
  onValidate: () => void;
  placa: string;
}) => {
  const placaLimpa = placa.replace(/[^A-Z0-9]/gi, "");
  const podeConsultar = placaLimpa.length === 7;

  return (
    <div className="sm:col-span-2 space-y-3">
      <button
        type="button"
        onClick={onValidate}
        disabled={loading || !podeConsultar}
        className="admin-input-surface inline-flex w-full items-center justify-center gap-2 rounded-xl border px-5 py-3 text-sm font-semibold text-foreground/85 transition-all hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        title={podeConsultar ? "Consultar ANTT do veiculo" : "Preencha a placa primeiro"}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4 text-primary" />
        )}
        <span>
          {loading
            ? "Consultando ANTT..."
            : `Validar ANTT${podeConsultar ? " da placa " + placa : ""}`}
        </span>
      </button>

      {result && (
        <div
          className={`rounded-xl border px-4 py-4 ${
            !result.found
              ? "border-amber-500/30 bg-amber-500/[0.06]"
              : result.ok
                ? "border-emerald-500/30 bg-emerald-500/[0.06]"
                : "border-destructive/30 bg-destructive/[0.06]"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                !result.found
                  ? "bg-amber-500/15 text-amber-600"
                  : result.ok
                    ? "bg-emerald-500/15 text-emerald-600"
                    : "bg-destructive/15 text-destructive"
              }`}
            >
              {result.ok && result.found ? (
                <ShieldCheck className="h-4 w-4" />
              ) : (
                <ShieldAlert className="h-4 w-4" />
              )}
            </div>
            <div className="flex-1 space-y-2">
              <p className="text-sm font-semibold text-foreground">
                {!result.found
                  ? "Veiculo nao localizado na ANTT"
                  : result.ok
                    ? `ANTT regular${result.situacao ? " - " + result.situacao : ""}`
                    : `ANTT irregular${result.situacao ? " - " + result.situacao : ""}`}
              </p>
              {result.found && (
                <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
                  {result.rntrc && (
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                        RNTRC
                      </dt>
                      <dd className="text-foreground/90">{result.rntrc}</dd>
                    </div>
                  )}
                  {result.transportador && (
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                        Transportador
                      </dt>
                      <dd className="text-foreground/90">{result.transportador}</dd>
                    </div>
                  )}
                  {result.cnpj_transportador && (
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                        CNPJ
                      </dt>
                      <dd className="text-foreground/90">{result.cnpj_transportador}</dd>
                    </div>
                  )}
                  {result.tipo_transportador && (
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                        Tipo
                      </dt>
                      <dd className="text-foreground/90">{result.tipo_transportador}</dd>
                    </div>
                  )}
                  {result.vencimento && (
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-muted-foreground">
                        Vencimento
                      </dt>
                      <dd className="text-foreground/90">{result.vencimento}</dd>
                    </div>
                  )}
                </dl>
              )}
              {!result.found && result.rawMessage && (
                <p className="text-xs text-muted-foreground">{result.rawMessage}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const AutoExtractHint = () => (
  <div className="sm:col-span-2 flex items-start gap-3 rounded-xl border border-primary/15 bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent px-4 py-3.5 text-xs leading-5">
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <Sparkles className="h-3.5 w-3.5" />
    </span>
    <div className="flex-1 space-y-0.5">
      <p className="text-xs font-semibold text-foreground">
        Preenchimento automatico via OCR
      </p>
      <p className="text-xs leading-5 text-foreground/70">
        Anexe o documento e os campos abaixo serao pre-preenchidos. Confira e ajuste se preciso.
      </p>
    </div>
  </div>
);

// ───────────────────────────── Proprietário da ANTT (transportador) ─────────────────────────────
// Bloco reutilizável para "Proprietário da ANTT do cavalo" e "Proprietário da
// ANTT da carreta". Quando `igual_proprietario_veiculo` é true, mostra apenas
// uma confirmação visual. Senão, expõe toggle PJ/PF + dados completos.

const ProprietarioAnttSection = ({
  title,
  description,
  value,
  onChange,
  onCnpjResult,
  cnpjResult,
}: {
  title: string;
  description?: string;
  value: ProprietarioAntt;
  onChange: (v: ProprietarioAntt) => void;
  onCnpjResult?: (r: CnpjConsultaResult) => void;
  cnpjResult?: CnpjConsultaResult;
}) => {
  const igual = value.igual_proprietario_veiculo;
  const badgeText = igual
    ? "= proprietario do veiculo"
    : value.tipo === "PJ"
      ? countFilledStatic(value.proprietario_pj as unknown as Record<string, unknown>, [
          "nome",
          "cnpj",
          "cep",
          "uf",
          "cidade",
          "bairro",
          "logradouro",
          "numero",
          "telefones",
          "inscricao_estadual",
        ])
      : value.tipo === "PF"
        ? countFilledStatic(value.proprietario_pf as unknown as Record<string, unknown>, [
            "nome",
            "cpf",
            "data_nascimento",
            "rg",
            "cep",
            "uf",
            "cidade",
            "telefones",
            "cartao_pis",
          ])
        : "—";

  return (
    <Section
      title={title}
      icon={Users}
      description={description}
      collapsible
      defaultOpen={false}
      badge={badgeText}
    >
      <div className="sm:col-span-2">
        <label className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3 text-sm">
          <input
            type="checkbox"
            checked={igual}
            onChange={(e) =>
              onChange({ ...value, igual_proprietario_veiculo: e.target.checked })
            }
            className="mt-0.5 h-4 w-4 rounded border-primary/30 text-primary focus:ring-primary"
          />
          <span className="text-foreground/85">
            <strong>Mesmo proprietario do veiculo</strong> (CRLV)
            <span className="block text-xs text-muted-foreground">
              Marque quando o transportador no RNTRC for a mesma pessoa/empresa que consta no
              CRLV. Desmarque para informar um transportador diferente (caso comum em frota
              terceirizada — ETC com motoristas TAC).
            </span>
          </span>
        </label>
      </div>

      {!igual && (
        <>
          <div className="sm:col-span-2">
            <label className={labelClasses}>Tipo de proprietario na ANTT</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["PJ", "PF"] as const).map((tipo) => (
                <button
                  key={tipo}
                  type="button"
                  onClick={() => onChange({ ...value, tipo })}
                  className={`rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
                    value.tipo === tipo
                      ? "admin-primary-button border-transparent text-white"
                      : "admin-input-surface text-foreground/80 hover:border-primary/30"
                  }`}
                >
                  {tipo === "PJ" ? "Pessoa Juridica (PJ)" : "Pessoa Fisica (PF)"}
                </button>
              ))}
            </div>
          </div>

          {value.tipo === "PJ" && (
            <SubSection title="Empresa transportadora (PJ na ANTT)">
              <ProprietarioPJFields
                value={value.proprietario_pj}
                onChange={(pj) => onChange({ ...value, proprietario_pj: pj })}
                onCnpjResult={onCnpjResult}
              />
              {cnpjResult ? <CnpjStatusCard result={cnpjResult} /> : null}
            </SubSection>
          )}

          {value.tipo === "PF" && (
            <>
              <SubSection title="Transportador autonomo (TAC / PF)">
                <ProprietarioPFFields
                  value={value.proprietario_pf}
                  onChange={(pf) => onChange({ ...value, proprietario_pf: pf })}
                />
              </SubSection>
              <SubSection title="CNH do transportador (PF)">
                <CnhFields
                  value={value.cnh_proprietario_pf}
                  onChange={(c) => onChange({ ...value, cnh_proprietario_pf: c })}
                  required
                />
                <CnhStatusCard
                  validade={value.cnh_proprietario_pf.validade}
                  categoria={value.cnh_proprietario_pf.categoria}
                  registro={value.cnh_proprietario_pf.registro}
                />
              </SubSection>
            </>
          )}
        </>
      )}
    </Section>
  );
};

// Versao "estatica" do countFilled fora do componente, usada por
// ProprietarioAnttSection (que precisa estar fora pra evitar re-render desnecessario).
function countFilledStatic(obj: Record<string, unknown>, keys: string[]): string {
  const filled = keys.filter((k) => {
    const v = obj[k];
    if (Array.isArray(v)) return v.some((s) => String(s).trim().length > 0);
    return v != null && String(v).trim().length > 0;
  }).length;
  return `${filled}/${keys.length}`;
}

// ───────────────────────────── Página ─────────────────────────────

type TabId = "motorista" | "cavalo" | "carreta" | "proprietario" | "operacional";
type TabDef = { id: TabId; label: string; icon: IconType; isComplete: (f: FormData, propTipo: ProprietarioTipo, propCarretaTipo: ProprietarioTipo) => boolean };

const isPessoaFilled = (p: PessoaBase) =>
  Boolean(p.nome && p.cpf && p.data_nascimento && p.rg && p.nome_mae);
const isCnhFilled = (c: CNHData) =>
  Boolean(c.registro && c.categoria && c.uf_emissor && c.validade);
const isEnderecoFilled = (e: Endereco) =>
  Boolean(e.cep && e.uf && e.cidade && e.bairro && e.logradouro && e.numero);
const isVeiculoFilled = (v: Veiculo) =>
  Boolean(v.placa && v.tipo && v.marca && v.modelo && v.ano_fabricacao && v.ano_modelo && v.cor && v.renavam && v.chassi);

const TABS: TabDef[] = [
  {
    id: "motorista",
    label: "Motorista",
    icon: User,
    // Inclui dados pessoais + CNH + endereco (consolidado nesta aba).
    isComplete: (f) =>
      isPessoaFilled(f.motorista) &&
      f.motorista.telefones.some((t) => t.length > 0) &&
      isCnhFilled(f.cnh) &&
      Boolean(f.arquivos.cnh) &&
      isEnderecoFilled(f.endereco_motorista) &&
      Boolean(f.arquivos.comprovante_motorista),
  },
  {
    id: "cavalo",
    label: "Cavalo",
    icon: Truck,
    isComplete: (f) => isVeiculoFilled(f.cavalo) && Boolean(f.arquivos.crlv_cavalo),
  },
  {
    id: "carreta",
    label: "Carreta",
    icon: Truck,
    // Depende do tipo de composicao:
    //   sem_carreta -> sempre completa (nao precisa carreta)
    //   1_carreta   -> carreta principal preenchida + CRLV
    //   bitrem      -> carreta principal + ao menos 1 extra preenchida + CRLVs
    isComplete: (f) => {
      if (f.tipo_composicao === "sem_carreta") return true;
      const principalOk = isVeiculoFilled(f.carreta) && Boolean(f.arquivos.crlv_carreta);
      if (f.tipo_composicao === "1_carreta") return principalOk;
      // bitrem: principal + ao menos 1 extra completa
      const extrasOk =
        f.carretas_extras.length >= 1 &&
        f.carretas_extras.every(
          (e) => isVeiculoFilled(e.veiculo) && Boolean(e.arquivo_crlv),
        );
      return principalOk && extrasOk;
    },
  },
  {
    id: "operacional",
    label: "Operacional",
    icon: Hash,
    // Aba operacional e opcional — sempre considerada completa (todos os
    // campos sao "soft requirements"). Quem precisa rastreador anota; quem
    // nao tem, deixa em branco.
    isComplete: () => true,
  },
  {
    id: "proprietario",
    label: "Proprietario",
    icon: Users,
    isComplete: (f, propTipo, propCarretaTipo) => {
      let cavaloOk = true;
      if (!f.motorista.tambem_proprietario) {
        if (propTipo === "PJ") {
          cavaloOk = Boolean(
            f.proprietario_pj.nome && f.proprietario_pj.cnpj && f.arquivos.cartao_cnpj,
          );
        } else if (propTipo === "PF") {
          // Quando tem_cnh=false, a CNH nao e exigida — RG (em PessoaBase) ja basta.
          const cnhOk = f.proprietario_pf.tem_cnh
            ? isCnhFilled(f.cnh_proprietario_pf)
            : true;
          cavaloOk =
            isPessoaFilled(f.proprietario_pf) &&
            cnhOk &&
            Boolean(f.arquivos.cnh_proprietario);
        } else {
          cavaloOk = false;
        }
      }

      let carretaOk = true;
      if (f.carreta_proprietario_diferente) {
        if (propCarretaTipo === "PJ") {
          carretaOk = Boolean(
            f.proprietario_pj_carreta.nome &&
              f.proprietario_pj_carreta.cnpj &&
              f.arquivos.cartao_cnpj_carreta,
          );
        } else if (propCarretaTipo === "PF") {
          const cnhCarretaOk = f.proprietario_pf_carreta.tem_cnh
            ? isCnhFilled(f.cnh_proprietario_pf_carreta)
            : true;
          carretaOk =
            isPessoaFilled(f.proprietario_pf_carreta) &&
            cnhCarretaOk &&
            Boolean(f.arquivos.cnh_proprietario_carreta);
        } else {
          carretaOk = false;
        }
      }

      return cavaloOk && carretaOk;
    },
  },
];

const CadastroDocumentos = () => {
  const [form, setForm] = useState<FormData>(() => ({
    ...initialForm,
    id_cadastro: genIdCadastro(),
  }));
  const [propTipo, setPropTipo] = useState<ProprietarioTipo>("");
  const [propCarretaTipo, setPropCarretaTipo] = useState<ProprietarioTipo>("");
  const [activeTab, setActiveTab] = useState<TabId>("motorista");
  // Concessionaria: campo obrigatorio na request, mas ignorado pelo backend
  // quando OCR_COMPROVANTE_PROVIDER=local. Mandamos um valor valido qualquer.
  const concessionaria = "neoenergia";
  const [anttResults, setAnttResults] = useState<{ cavalo?: AnttStatus; carreta?: AnttStatus }>({});
  const [anttLoading, setAnttLoading] = useState<{ cavalo?: boolean; carreta?: boolean }>({});
  const [cnpjResults, setCnpjResults] = useState<{
    cavalo?: CnpjConsultaResult;
    carreta?: CnpjConsultaResult;
  }>({});
  const [veiculoResults, setVeiculoResults] = useState<{
    cavalo?: VeiculoSituacaoResult;
    carreta?: VeiculoSituacaoResult;
  }>({});
  const [veiculoLoading, setVeiculoLoading] = useState<{ cavalo?: boolean; carreta?: boolean }>({});
  // Snapshot dos campos extraidos do CRLV via OCR — usado para cross-check
  // visual (placa/chassi/renavam digitados vs. originais do documento).
  const [crlvSnapshot, setCrlvSnapshot] = useState<{
    cavalo?: { placa: string; chassi: string; renavam: string };
    carreta?: { placa: string; chassi: string; renavam: string };
  }>({});
  const [loading, setLoading] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const { toast } = useToast();

  const currentIndex = TABS.findIndex((t) => t.id === activeTab);
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === TABS.length - 1;

  // Progressive unlock: aba N e acessivel apenas se todas as abas 0..N-1
  // estao completas. A aba atual e sempre acessivel (mesmo incompleta — ela
  // tem que estar para o usuario poder preencher).
  const isTabUnlocked = (idx: number): boolean => {
    for (let i = 0; i < idx; i++) {
      if (!TABS[i].isComplete(form, propTipo, propCarretaTipo)) return false;
    }
    return true;
  };

  const currentTabComplete = TABS[currentIndex].isComplete(form, propTipo, propCarretaTipo);

  const goPrev = () => !isFirst && setActiveTab(TABS[currentIndex - 1].id);

  // ⚠️ MODO LIVRE (debug): trava de unlock progressivo desativada para
  // permitir testar cada aba independente. Para reativar, volte os
  // condicionais em goNext, tryChangeTab e na renderizacao do TabsTrigger.
  const FREE_NAV = true;

  // Lista descritiva do que falta na aba atual — usado pra mostrar feedback
  // util quando o usuario tenta avancar com a etapa incompleta.
  const listMissingFieldsForTab = (tab: TabId): string[] => {
    const missing: string[] = [];
    const m = form.motorista;
    const e = form.endereco_motorista;

    if (tab === "motorista") {
      if (!m.nome) missing.push("Nome completo");
      if (!m.cpf) missing.push("CPF");
      else if (validateCpf(m.cpf).reason) missing.push("CPF invalido");
      if (!m.data_nascimento) missing.push("Data de nascimento");
      if (!m.rg) missing.push("RG");
      if (!m.nome_mae) missing.push("Nome da mae");
      if (!m.telefones.some((t) => t.length > 0)) missing.push("Pelo menos 1 telefone");
      else {
        m.telefones.forEach((t, i) => {
          if (t && validateTelefone(t).reason) missing.push(`Telefone #${i + 1} invalido`);
        });
      }
      if (!form.cnh.registro) missing.push("Registro da CNH");
      if (!form.cnh.categoria) missing.push("Categoria da CNH");
      if (!form.cnh.uf_emissor) missing.push("UF emissor da CNH");
      if (!form.cnh.validade) missing.push("Validade da CNH");
      if (!form.arquivos.cnh) missing.push("Anexar imagem da CNH");
      // Endereco do motorista (consolidado nesta aba)
      if (!e.cep) missing.push("CEP do endereco");
      else if (validateCep(e.cep).reason) missing.push("CEP invalido");
      if (!e.uf) missing.push("UF do endereco");
      if (!e.cidade) missing.push("Cidade do endereco");
      if (!e.bairro) missing.push("Bairro do endereco");
      if (!e.logradouro) missing.push("Logradouro do endereco");
      if (!e.numero) missing.push("Numero do endereco");
      if (!form.arquivos.comprovante_motorista) missing.push("Anexar comprovante de residencia");
    }

    const veiculoChecks = (label: string, v: typeof form.cavalo, anexo: string) => {
      if (!v.placa) missing.push(`${label}: Placa`);
      else if (validatePlaca(v.placa).reason) missing.push(`${label}: Placa invalida`);
      if (!v.tipo) missing.push(`${label}: Tipo`);
      if (!v.marca) missing.push(`${label}: Marca`);
      if (!v.modelo) missing.push(`${label}: Modelo`);
      if (!v.ano_fabricacao) missing.push(`${label}: Ano fabricacao`);
      if (!v.ano_modelo) missing.push(`${label}: Ano modelo`);
      if (!v.cor) missing.push(`${label}: Cor`);
      if (!v.renavam) missing.push(`${label}: Renavam`);
      else if (validateRenavam(v.renavam).reason) missing.push(`${label}: Renavam invalido`);
      if (!v.chassi) missing.push(`${label}: Chassi`);
      else if (validateChassi(v.chassi).reason) missing.push(`${label}: Chassi invalido`);
      if (!anexo) missing.push(`${label}: Anexar CRLV`);
    };

    if (tab === "cavalo") veiculoChecks("Cavalo", form.cavalo, form.arquivos.crlv_cavalo);
    if (tab === "carreta") veiculoChecks("Carreta", form.carreta, form.arquivos.crlv_carreta);

    if (tab === "proprietario") {
      if (!form.motorista.tambem_proprietario) {
        if (!propTipo) missing.push("Selecione o tipo do proprietario (PJ ou PF)");
        else if (propTipo === "PJ") {
          if (!form.proprietario_pj.nome) missing.push("Razao social do proprietario");
          if (!form.proprietario_pj.cnpj) missing.push("CNPJ do proprietario");
          else if (validateCnpj(form.proprietario_pj.cnpj).reason)
            missing.push("CNPJ do proprietario invalido");
          if (!form.arquivos.cartao_cnpj) missing.push("Anexar cartao CNPJ");
        } else if (propTipo === "PF") {
          if (!form.proprietario_pf.nome) missing.push("Nome do proprietario");
          if (!form.proprietario_pf.cpf) missing.push("CPF do proprietario");
          else if (validateCpf(form.proprietario_pf.cpf).reason)
            missing.push("CPF do proprietario invalido");
          if (form.proprietario_pf.tem_cnh && !form.cnh_proprietario_pf.registro)
            missing.push("Registro da CNH do proprietario");
          if (!form.arquivos.cnh_proprietario)
            missing.push(
              form.proprietario_pf.tem_cnh
                ? "Anexar CNH do proprietario"
                : "Anexar RG do proprietario",
            );
        }
      }
      if (form.carreta_proprietario_diferente) {
        if (!propCarretaTipo)
          missing.push("Selecione o tipo do proprietario da carreta (PJ ou PF)");
        else if (propCarretaTipo === "PJ") {
          if (!form.proprietario_pj_carreta.nome) missing.push("Razao social proprietario carreta");
          if (!form.proprietario_pj_carreta.cnpj) missing.push("CNPJ proprietario carreta");
          else if (validateCnpj(form.proprietario_pj_carreta.cnpj).reason)
            missing.push("CNPJ proprietario carreta invalido");
          if (!form.arquivos.cartao_cnpj_carreta) missing.push("Anexar cartao CNPJ (carreta)");
        } else if (propCarretaTipo === "PF") {
          if (!form.proprietario_pf_carreta.nome)
            missing.push("Nome do proprietario da carreta");
          if (!form.proprietario_pf_carreta.cpf) missing.push("CPF proprietario carreta");
          else if (validateCpf(form.proprietario_pf_carreta.cpf).reason)
            missing.push("CPF proprietario carreta invalido");
          if (
            form.proprietario_pf_carreta.tem_cnh &&
            !form.cnh_proprietario_pf_carreta.registro
          )
            missing.push("Registro CNH proprietario carreta");
          if (!form.arquivos.cnh_proprietario_carreta)
            missing.push(
              form.proprietario_pf_carreta.tem_cnh
                ? "Anexar CNH proprietario carreta"
                : "Anexar RG proprietario carreta",
            );
        }
      }
    }

    return missing;
  };

  const goNext = () => {
    if (isLast) return;
    if (!FREE_NAV && !currentTabComplete) {
      const missing = listMissingFieldsForTab(activeTab);
      if (import.meta.env.DEV) console.warn(`[goNext] Aba "${activeTab}" - faltam ${missing.length}:`, missing);
      toast({
        title: `Faltam ${missing.length} item${missing.length === 1 ? "" : "s"} para avancar`,
        description:
          missing.slice(0, 3).join(" • ") +
          (missing.length > 3 ? ` (+${missing.length - 3} mais)` : ""),
        variant: "destructive",
      });
      return;
    }
    setActiveTab(TABS[currentIndex + 1].id);
  };

  const tryChangeTab = (id: string) => {
    const targetIdx = TABS.findIndex((t) => t.id === id);
    if (targetIdx < 0) return;
    if (FREE_NAV) {
      setActiveTab(id as TabId);
      return;
    }
    if (targetIdx <= currentIndex) {
      // voltar e sempre permitido
      setActiveTab(id as TabId);
      return;
    }
    if (!isTabUnlocked(targetIdx)) {
      toast({
        title: "Aba bloqueada",
        description: "Conclua as etapas anteriores para liberar esta aba.",
        variant: "destructive",
      });
      return;
    }
    setActiveTab(id as TabId);
  };

  // Coleta todos os erros de validacao das areas sensiveis. Retorna lista
  // de strings descritivas para exibir num toast/console quando o submit falhar.
  const collectValidationErrors = (): string[] => {
    const errs: string[] = [];
    const push = (label: string, reason?: string) => {
      if (reason) errs.push(`${label}: ${reason}`);
    };

    push("Motorista CPF", validateCpf(form.motorista.cpf).reason);
    form.motorista.telefones.forEach((t, i) =>
      push(`Motorista telefone #${i + 1}`, validateTelefone(t).reason),
    );
    push("CNH motorista (registro)", validateCnhRegistro(form.cnh.registro).reason);
    push("Endereco motorista CEP", validateCep(form.endereco_motorista.cep).reason);

    push("Cavalo placa", validatePlaca(form.cavalo.placa).reason);
    push("Cavalo renavam", validateRenavam(form.cavalo.renavam).reason);
    push("Cavalo chassi", validateChassi(form.cavalo.chassi).reason);

    if (form.carreta_proprietario_diferente || form.carreta.placa) {
      push("Carreta placa", validatePlaca(form.carreta.placa).reason);
      push("Carreta renavam", validateRenavam(form.carreta.renavam).reason);
      push("Carreta chassi", validateChassi(form.carreta.chassi).reason);
    }

    if (!form.motorista.tambem_proprietario) {
      if (propTipo === "PJ") {
        push("Proprietario CNPJ", validateCnpj(form.proprietario_pj.cnpj).reason);
        push("Proprietario CEP", validateCep(form.proprietario_pj.cep).reason);
        form.proprietario_pj.telefones.forEach((t, i) =>
          push(`Proprietario telefone #${i + 1}`, validateTelefone(t).reason),
        );
      } else if (propTipo === "PF") {
        push("Proprietario CPF", validateCpf(form.proprietario_pf.cpf).reason);
        push("Proprietario CEP", validateCep(form.proprietario_pf.cep).reason);
        push("Proprietario PIS", validatePis(form.proprietario_pf.cartao_pis).reason);
        if (form.proprietario_pf.tem_cnh) {
          push(
            "CNH proprietario (registro)",
            validateCnhRegistro(form.cnh_proprietario_pf.registro).reason,
          );
        }
        form.proprietario_pf.telefones.forEach((t, i) =>
          push(`Proprietario telefone #${i + 1}`, validateTelefone(t).reason),
        );
      }
    }

    if (form.carreta_proprietario_diferente) {
      if (propCarretaTipo === "PJ") {
        push("Proprietario carreta CNPJ", validateCnpj(form.proprietario_pj_carreta.cnpj).reason);
        push("Proprietario carreta CEP", validateCep(form.proprietario_pj_carreta.cep).reason);
      } else if (propCarretaTipo === "PF") {
        push("Proprietario carreta CPF", validateCpf(form.proprietario_pf_carreta.cpf).reason);
        push("Proprietario carreta CEP", validateCep(form.proprietario_pf_carreta.cep).reason);
        push("Proprietario carreta PIS", validatePis(form.proprietario_pf_carreta.cartao_pis).reason);
        if (form.proprietario_pf_carreta.tem_cnh) {
          push(
            "CNH proprietario carreta (registro)",
            validateCnhRegistro(form.cnh_proprietario_pf_carreta.registro).reason,
          );
        }
      }
    }

    return errs;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isLast) {
      goNext();
      return;
    }

    const validationErrors = collectValidationErrors();
    if (validationErrors.length > 0) {
      if (import.meta.env.DEV) console.error("[CadastroDocumentos] Erros de validacao:", validationErrors);
      toast({
        title: `${validationErrors.length} campo${validationErrors.length === 1 ? "" : "s"} invalido${validationErrors.length === 1 ? "" : "s"}`,
        description: validationErrors.slice(0, 3).join(" • ") +
          (validationErrors.length > 3 ? ` (+${validationErrors.length - 3})` : ""),
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const dados: Record<string, unknown> = {
        motorista: { ...form.motorista, ...form.endereco_motorista, cnh: form.cnh },
        cavalo: form.cavalo,
        carreta: form.tipo_composicao !== "sem_carreta" ? form.carreta : null,
        carretas_extras: form.carretas_extras,
        operacional: form.operacional,
        proprietario: form.motorista.tambem_proprietario
          ? null
          : propTipo === "PJ"
            ? { tipo: "PJ", ...form.proprietario_pj }
            : { tipo: "PF", ...form.proprietario_pf, cnh: form.cnh_proprietario_pf },
        proprietario_carreta: form.carreta_proprietario_diferente
          ? propCarretaTipo === "PJ"
            ? { tipo: "PJ", ...form.proprietario_pj_carreta }
            : { tipo: "PF", ...form.proprietario_pf_carreta, cnh: form.cnh_proprietario_pf_carreta }
          : null,
        tipo_composicao: form.tipo_composicao,
      };

      await finalizarCadastro(form.id_cadastro, dados);
      setEnviado(true);
    } catch (error) {
      toast({
        title: "Erro ao enviar cadastro",
        description: error instanceof Error ? error.message : "Tente novamente em instantes.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const motoristaIsProprietario = form.motorista.tambem_proprietario;
  const carretaDiferente = form.carreta_proprietario_diferente;

  // Conta quantos campos do objeto estao preenchidos (string nao-vazia).
  // Usado para mostrar "X / N campos" no badge das secoes colapsaveis.
  const countFilled = (obj: Record<string, unknown>, keys: string[]): string => {
    const filled = keys.filter((k) => {
      const v = (obj as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.some((s) => String(s).trim().length > 0);
      return v != null && String(v).trim().length > 0;
    }).length;
    return `${filled}/${keys.length}`;
  };

  // ─── Helpers de conversao para os campos do form ───
  const toIsoDate = normalizeDateInputValue;
  const onlyYear = (s: string): string => {
    const m = s?.match?.(/(\d{4})/);
    return m ? m[1] : "";
  };
  const showError = (title: string, error: unknown) => {
    let description: string;
    if (error instanceof Error) {
      description = error.message;
    } else if (typeof error === "string") {
      description = error;
    } else if (error && typeof error === "object") {
      try {
        description = JSON.stringify(error);
      } catch {
        description = "Erro desconhecido.";
      }
    } else {
      description = "Tente novamente.";
    }
    if (import.meta.env.DEV) console.error(`[CadastroDocumentos] ${title}:`, error);
    toast({ title, description, variant: "destructive" });
  };

  // ─── Handler: CNH motorista ───
  const handleCnhMotoristaFile = async (file: File) => {
    try {
      const { pessoal, cnh, idCadastroPasta } = await ocrCnh(file, form.id_cadastro);
      setForm((f) => ({
        ...f,
        // Backend renomeou a pasta em anexos_tmp para o nome do motorista
        // — adotamos o novo id pra todos os uploads subsequentes caírem lá.
        id_cadastro: idCadastroPasta || f.id_cadastro,
        motorista: {
          ...f.motorista,
          nome: pessoal.nome || f.motorista.nome,
          cpf: pessoal.cpf ? formatCpf(pessoal.cpf) : f.motorista.cpf,
          data_nascimento: toIsoDate(pessoal.data_nascimento) || f.motorista.data_nascimento,
          nome_pai: pessoal.nome_pai || f.motorista.nome_pai,
          nome_mae: pessoal.nome_mae || f.motorista.nome_mae,
          naturalidade: pessoal.naturalidade || f.motorista.naturalidade,
          rg: pessoal.rg || f.motorista.rg,
          rg_orgao: pessoal.rg_orgao || f.motorista.rg_orgao,
          rg_uf: pessoal.rg_uf || f.motorista.rg_uf,
        },
        cnh: {
          ...f.cnh,
          registro: cnh.registro || f.cnh.registro,
          categoria: cnh.categoria || f.cnh.categoria,
          codigo_seguranca: cnh.codigo_seguranca || f.cnh.codigo_seguranca,
          numero_espelho: cnh.numero_espelho || f.cnh.numero_espelho,
          uf_emissor: cnh.uf_emissor || f.cnh.uf_emissor,
          validade: toIsoDate(cnh.validade) || f.cnh.validade,
          primeira_emissao: toIsoDate(cnh.primeira_emissao) || f.cnh.primeira_emissao,
        },
      }));
      toast({ title: "CNH extraida", description: "Campos do motorista e da CNH preenchidos." });
    } catch (e) {
      showError("Falha ao extrair CNH", e);
    }
  };

  // ─── Handler: Comprovante de residencia (motorista) ───
  // Fluxo: OCR extrai dados do comprovante -> se houver CEP, dispara
  // /api/consulta/cep automaticamente. CEP DB e autoritativo (mais preciso que OCR)
  // para uf/cidade/bairro/logradouro; o numero permanece o que o OCR achou.
  const handleComprovanteMotoristaFile = async (file: File) => {
    try {
      const ext = await ocrComprovante(file, concessionaria, form.id_cadastro);
      const cepDigits = onlyDigits(ext.cep);

      // 1) Auto-consulta o CEP extraido (Infosimples + fallback ViaCEP)
      let cepData: Awaited<ReturnType<typeof consultaCep>> | null = null;
      if (cepDigits.length === 8) {
        try {
          cepData = await consultaCep(ext.cep);
        } catch {
          // Sem dados de CEP — segue com o que o OCR conseguiu.
        }
      }

      // 2) Merge: CEP DB > OCR > valor atual.
      setForm((f) => ({
        ...f,
        endereco_motorista: {
          cep: ext.cep ? formatCep(ext.cep) : f.endereco_motorista.cep,
          uf: cepData?.uf || ext.uf || f.endereco_motorista.uf,
          cidade: cepData?.cidade || ext.cidade || f.endereco_motorista.cidade,
          bairro: cepData?.bairro || ext.bairro || f.endereco_motorista.bairro,
          logradouro:
            cepData?.logradouro || ext.logradouro || f.endereco_motorista.logradouro,
          numero: ext.numero || f.endereco_motorista.numero,
        },
      }));

      if (cepData) {
        toast({
          title: "Endereco preenchido",
          description: "Comprovante extraido + CEP consultado automaticamente.",
        });
      } else if (cepDigits.length === 8) {
        toast({
          title: "Comprovante extraido",
          description: "Nao foi possivel consultar o CEP. Confira o endereco.",
        });
      } else {
        toast({
          title: "Comprovante extraido",
          description: "CEP nao identificado no documento. Preencha manualmente.",
        });
      }
    } catch (e) {
      showError("Falha ao extrair endereco", e);
    }
  };

  // ─── Handler: Comprovante de residencia (proprietario do cavalo) ───
  // Mesmo fluxo do motorista: OCR -> consulta CEP -> preenche endereco no
  // bloco PJ ou PF conforme o tipo selecionado pelo operador.
  const handleComprovanteProprietarioFile = async (file: File) => {
    try {
      if (propTipo !== "PJ" && propTipo !== "PF") {
        toast({
          title: "Selecione o tipo do proprietario",
          description: "Escolha PJ ou PF antes de anexar o comprovante.",
          variant: "destructive",
        });
        return;
      }

      const ext = await ocrComprovante(file, concessionaria, `${form.id_cadastro}:proprietario`);
      const cepDigits = onlyDigits(ext.cep);

      let cepData: Awaited<ReturnType<typeof consultaCep>> | null = null;
      if (cepDigits.length === 8) {
        try {
          cepData = await consultaCep(ext.cep);
        } catch {
          // segue com o que veio do OCR
        }
      }

      const targetKey: "proprietario_pj" | "proprietario_pf" =
        propTipo === "PJ" ? "proprietario_pj" : "proprietario_pf";

      setForm((f) => ({
        ...f,
        [targetKey]: {
          ...f[targetKey],
          cep: ext.cep ? formatCep(ext.cep) : f[targetKey].cep,
          uf: cepData?.uf || ext.uf || f[targetKey].uf,
          cidade: cepData?.cidade || ext.cidade || f[targetKey].cidade,
          bairro: cepData?.bairro || ext.bairro || f[targetKey].bairro,
          logradouro:
            cepData?.logradouro || ext.logradouro || f[targetKey].logradouro,
          numero: ext.numero || f[targetKey].numero,
        },
      }));

      if (cepData) {
        toast({
          title: "Endereco do proprietario preenchido",
          description: "Comprovante extraido + CEP consultado automaticamente.",
        });
      } else if (cepDigits.length === 8) {
        toast({
          title: "Comprovante extraido",
          description: "Nao foi possivel consultar o CEP. Confira o endereco.",
        });
      } else {
        toast({
          title: "Comprovante extraido",
          description: "CEP nao identificado no documento. Preencha manualmente.",
        });
      }
    } catch (e) {
      showError("Falha ao extrair endereco do proprietario", e);
    }
  };

  // ─── Verificar situacao do veiculo online (DENATRAN/SINESP) ───
  const verificarVeiculoOnline = async (target: "cavalo" | "carreta") => {
    const veiculo = form[target];
    if (!veiculo.placa || veiculo.placa.length < 7) {
      toast({
        title: "Placa nao preenchida",
        description: "Anexe o CRLV ou digite a placa antes de verificar.",
        variant: "destructive",
      });
      return;
    }
    setVeiculoLoading((s) => ({ ...s, [target]: true }));
    try {
      const result = await consultaVeiculoSituacao({
        placa: veiculo.placa,
        renavam: veiculo.renavam,
        uf: veiculo.uf_emplacamento,
      });
      setVeiculoResults((s) => ({ ...s, [target]: result }));
      if (!result.found) {
        toast({
          title: "Veiculo nao localizado",
          description: result.rawMessage || "Sem dados na base consultada.",
          variant: "destructive",
        });
      } else if (result.ok) {
        toast({
          title: "Veiculo regular",
          description:
            result.licenciamento_situacao || result.situacao || "Em circulacao.",
        });
      } else {
        toast({
          title: "Atencao no veiculo",
          description:
            result.licenciamento_situacao ||
            result.situacao ||
            "Verifique restricoes/debitos.",
          variant: "destructive",
        });
      }
    } catch (e) {
      setVeiculoResults((s) => ({ ...s, [target]: undefined }));
      showError("Falha ao consultar situacao do veiculo", e);
    } finally {
      setVeiculoLoading((s) => ({ ...s, [target]: false }));
    }
  };

  // ─── Validacao ANTT do veiculo ───
  // Estrategia: prefere RNTRC (antt/transportador) > CNPJ proprietario > placa.
  // O parametro `hint` permite chamadas pos-OCR passarem os valores recem
  // extraidos sem depender da propagacao do React state (que ainda nao
  // aconteceu quando handleCrlvFile chama validateAntt).
  const validateAntt = async (
    target: "cavalo" | "carreta",
    hint?: { rntrc?: string; cnpj?: string; cpf?: string; placa?: string },
  ) => {
    const veiculo = form[target];
    const isCavalo = target === "cavalo";
    const cnpjProp = isCavalo
      ? form.proprietario_pj.cnpj
      : form.proprietario_pj_carreta.cnpj;
    const cpfProp = isCavalo
      ? form.proprietario_pf.cpf
      : form.proprietario_pf_carreta.cpf;

    const rntrc = (hint?.rntrc ?? veiculo.antt ?? "").trim();
    const cnpj = (hint?.cnpj ?? cnpjProp ?? "").trim();
    const cpf = (hint?.cpf ?? cpfProp ?? "").trim();
    const placa = (hint?.placa ?? veiculo.placa ?? "").trim();

    if (!rntrc && !cnpj && !cpf && !placa) {
      toast({
        title: "Sem dados para consulta",
        description: "Anexe o CRLV ou preencha placa/RNTRC/CPF/CNPJ antes de validar.",
        variant: "destructive",
      });
      return;
    }

    setAnttLoading((s) => ({ ...s, [target]: true }));
    try {
      const result = await consultaAnttVeiculo({ rntrc, cnpj, cpf, placa });
      setAnttResults((s) => ({ ...s, [target]: result }));

      // Auto-preenche ANTT/RNTRC no veiculo se a consulta achou
      if (result.rntrc) {
        setForm((f) =>
          f[target].antt
            ? f
            : { ...f, [target]: { ...f[target], antt: result.rntrc } },
        );
      }
      if (!result.found) {
        toast({
          title: "ANTT nao encontrada",
          description: result.rawMessage || "Sem registro ativo na ANTT.",
          variant: "destructive",
        });
      } else if (result.ok) {
        toast({
          title: "ANTT regular",
          description: result.situacao || `RNTRC ${result.rntrc} ativa.`,
        });
      } else {
        toast({
          title: "ANTT irregular",
          description: result.situacao || "Verifique a situacao do RNTRC.",
          variant: "destructive",
        });
      }
    } catch (e) {
      setAnttResults((s) => ({ ...s, [target]: undefined }));
      showError("Falha ao validar ANTT", e);
    } finally {
      setAnttLoading((s) => ({ ...s, [target]: false }));
    }
  };

  // ─── Handler comum: CRLV (cavalo ou carreta) ───
  // Fluxo:
  //   1) OCR do CRLV preenche os dados do veiculo
  //   2) Se CRLV identificou um CNPJ no proprietario, dispara consultaCnpj
  //      automaticamente e preenche o bloco PJ correspondente (cavalo ou
  //      carreta) — INDEPENDENTE de toggles. Se CPF, ja preenche cpf+nome no
  //      bloco PF (CNH do proprietario complementa via outro upload).
  const handleCrlvFile = async (file: File, target: "cavalo" | "carreta") => {
    try {
      const idCrlv = target === "carreta" ? `${form.id_cadastro}:carreta` : form.id_cadastro;
      const { veiculo, proprietario } = await ocrCrlv(file, idCrlv);
      if (import.meta.env.DEV) console.debug(`[handleCrlvFile/${target}] proprietario:`, proprietario);

      // Guarda os valores originais do OCR para cross-check vs. o que o
      // operador digita depois (caso edite manualmente sem perceber).
      setCrlvSnapshot((s) => ({
        ...s,
        [target]: {
          placa: formatPlaca(veiculo.placa),
          chassi: veiculo.chassi.toUpperCase().slice(0, 17),
          renavam: veiculo.renavam.replace(/\D/g, "").slice(0, 11),
        },
      }));

      setForm((f) => ({
        ...f,
        [target]: {
          ...f[target],
          placa: formatPlaca(veiculo.placa) || f[target].placa,
          tipo: veiculo.tipo || f[target].tipo,
          carroceria: veiculo.carroceria || f[target].carroceria,
          proprietario: veiculo.proprietario || f[target].proprietario,
          marca: veiculo.marca || f[target].marca,
          modelo: veiculo.modelo || f[target].modelo,
          ano_fabricacao: onlyYear(veiculo.ano_fabricacao) || f[target].ano_fabricacao,
          ano_modelo: onlyYear(veiculo.ano_modelo) || f[target].ano_modelo,
          cor: veiculo.cor || f[target].cor,
          uf_emplacamento: veiculo.uf_emplacamento || f[target].uf_emplacamento,
          cidade_emplacamento: veiculo.cidade_emplacamento || f[target].cidade_emplacamento,
          renavam: veiculo.renavam.replace(/\D/g, "").slice(0, 11) || f[target].renavam,
          chassi: veiculo.chassi.toUpperCase().slice(0, 17) || f[target].chassi,
          eixos: veiculo.eixos.replace(/\D/g, "").slice(0, 2) || f[target].eixos,
          antt: veiculo.antt || f[target].antt,
          ultimo_licenciamento: toIsoDate(veiculo.ultimo_licenciamento) || f[target].ultimo_licenciamento,
        },
      }));
      toast({ title: "CRLV extraido", description: "Dados do veiculo preenchidos." });

      // Aviso (nao bloqueia): se o OCR nao identificou CPF/CNPJ do proprietario,
      // a aba Proprietario fica em branco — mas a consulta ANTT por placa
      // continua rodando logo abaixo (ela nao precisa de documento).
      if (!proprietario.documento) {
        toast({
          title: "Proprietario nao identificado",
          description: "CPF/CNPJ nao localizado no CRLV. Preencha manualmente na aba Proprietario.",
        });
      }

      // Helpers de mutacao por target
      const isCavalo = target === "cavalo";
      const setPropTipoFor = isCavalo ? setPropTipo : setPropCarretaTipo;
      const propPjKey: "proprietario_pj" | "proprietario_pj_carreta" = isCavalo
        ? "proprietario_pj"
        : "proprietario_pj_carreta";
      const propPfKey: "proprietario_pf" | "proprietario_pf_carreta" = isCavalo
        ? "proprietario_pf"
        : "proprietario_pf_carreta";

      // Para a carreta, garante que o checkbox "proprietario diferente"
      // esteja ligado — caso contrario, a aba Proprietario nao mostra o bloco
      // da carreta e o usuario nao verá os dados preenchidos.
      if (!isCavalo) {
        setForm((f) => ({ ...f, carreta_proprietario_diferente: true }));
      }

      if (proprietario.tipo === "PJ") {
        setPropTipoFor("PJ");
        const cnpjFmt = formatCnpj(proprietario.documento);
        setForm((f) => ({
          ...(isCavalo && f.motorista.tambem_proprietario
            ? {
                ...f,
                motorista: {
                  ...f.motorista,
                  tambem_proprietario: false,
                },
              }
            : f),
          [propPjKey]: {
            ...f[propPjKey],
            cnpj: cnpjFmt,
            nome: proprietario.nome || f[propPjKey].nome,
          },
        }));
        toast({
          title: "CNPJ identificado no CRLV",
          description: `${cnpjFmt} - consultando Receita Federal...`,
        });

        try {
          const { campos, result } = await fetchCnpjData(proprietario.documento);
          setForm((f) => ({
            ...f,
            [propPjKey]: { ...f[propPjKey], ...campos },
          }));
          setCnpjResults((s) => ({ ...s, [target]: result }));
          toast({
            title: "Proprietario preenchido",
            description: result.situacao
              ? `${result.nome} - Situacao: ${result.situacao}`
              : `Dados do ${target} (PJ) populados via consulta CNPJ.`,
          });
        } catch (e) {
          showError("Falha ao consultar CNPJ", e);
        }
      } else if (proprietario.tipo === "PF") {
        setPropTipoFor("PF");
        const cpfFmt = formatCpf(proprietario.documento);
        setForm((f) => ({
          ...f,
          [propPfKey]: {
            ...f[propPfKey],
            cpf: cpfFmt,
            nome: proprietario.nome || f[propPfKey].nome,
          },
        }));
        toast({
          title: "CPF identificado no CRLV",
          description: `${cpfFmt} - anexe a CNH do proprietario para completar.`,
        });
      }

      // Auto-valida a ANTT do veiculo passando os dados recem extraidos
      // pelo OCR como hint — sem isso, validateAntt leria o form ainda nao
      // propagado pelo React (state batching).
      const placaLimpa = formatPlaca(veiculo.placa);
      if (placaLimpa.length === 7) {
        const cnpjHint =
          proprietario.tipo === "PJ" ? proprietario.documento : "";
        const cpfHint =
          proprietario.tipo === "PF" ? proprietario.documento : "";
        validateAntt(target, {
          rntrc: veiculo.antt,
          cnpj: cnpjHint,
          cpf: cpfHint,
          placa: placaLimpa,
        }).catch(() => {
          // erros ja sao tratados em validateAntt (toast + state cleanup)
        });
      }
    } catch (e) {
      showError("Falha ao extrair CRLV", e);
    }
  };

  // ─── Handler: Cartao CNPJ (cavalo) ───
  const handleCartaoCnpjFile = async (file: File) => {
    try {
      const ext = await ocrCartaoCnpj(file, form.id_cadastro);
      setForm((f) => ({
        ...f,
        proprietario_pj: {
          ...f.proprietario_pj,
          nome: ext.razao_social || f.proprietario_pj.nome,
          cnpj: ext.cnpj ? formatCnpj(ext.cnpj) : f.proprietario_pj.cnpj,
          cep: ext.cep ? formatCep(ext.cep) : f.proprietario_pj.cep,
          uf: ext.uf || f.proprietario_pj.uf,
          cidade: ext.cidade || f.proprietario_pj.cidade,
          bairro: ext.bairro || f.proprietario_pj.bairro,
          logradouro: ext.logradouro || f.proprietario_pj.logradouro,
          numero: ext.numero || f.proprietario_pj.numero,
        },
      }));
      toast({ title: "Cartao CNPJ extraido", description: "Dados da empresa preenchidos." });
    } catch (e) {
      showError("Falha ao extrair Cartao CNPJ", e);
    }
  };

  // ─── Handler: CNH proprietario PF (cavalo) ───
  const handleCnhProprietarioFile = async (file: File) => {
    try {
      const { pessoal, cnh } = await ocrCnh(file, `${form.id_cadastro}:proprietario`);
      setForm((f) => ({
        ...f,
        proprietario_pf: {
          ...f.proprietario_pf,
          nome: pessoal.nome || f.proprietario_pf.nome,
          cpf: pessoal.cpf ? formatCpf(pessoal.cpf) : f.proprietario_pf.cpf,
          data_nascimento: toIsoDate(pessoal.data_nascimento) || f.proprietario_pf.data_nascimento,
          nome_pai: pessoal.nome_pai || f.proprietario_pf.nome_pai,
          nome_mae: pessoal.nome_mae || f.proprietario_pf.nome_mae,
          naturalidade: pessoal.naturalidade || f.proprietario_pf.naturalidade,
          rg: pessoal.rg || f.proprietario_pf.rg,
          rg_orgao: pessoal.rg_orgao || f.proprietario_pf.rg_orgao,
          rg_uf: pessoal.rg_uf || f.proprietario_pf.rg_uf,
        },
        cnh_proprietario_pf: {
          ...f.cnh_proprietario_pf,
          registro: cnh.registro || f.cnh_proprietario_pf.registro,
          categoria: cnh.categoria || f.cnh_proprietario_pf.categoria,
          codigo_seguranca: cnh.codigo_seguranca || f.cnh_proprietario_pf.codigo_seguranca,
          numero_espelho: cnh.numero_espelho || f.cnh_proprietario_pf.numero_espelho,
          uf_emissor: cnh.uf_emissor || f.cnh_proprietario_pf.uf_emissor,
          validade: toIsoDate(cnh.validade) || f.cnh_proprietario_pf.validade,
          primeira_emissao: toIsoDate(cnh.primeira_emissao) || f.cnh_proprietario_pf.primeira_emissao,
        },
      }));
      toast({ title: "CNH proprietario extraida", description: "Dados pessoais e da CNH preenchidos." });
    } catch (e) {
      showError("Falha ao extrair CNH do proprietario", e);
    }
  };

  // ─── Handler: Cartao CNPJ (carreta) ───
  const handleCartaoCnpjCarretaFile = async (file: File) => {
    try {
      const ext = await ocrCartaoCnpj(file, `${form.id_cadastro}:carreta`);
      setForm((f) => ({
        ...f,
        proprietario_pj_carreta: {
          ...f.proprietario_pj_carreta,
          nome: ext.razao_social || f.proprietario_pj_carreta.nome,
          cnpj: ext.cnpj ? formatCnpj(ext.cnpj) : f.proprietario_pj_carreta.cnpj,
          cep: ext.cep ? formatCep(ext.cep) : f.proprietario_pj_carreta.cep,
          uf: ext.uf || f.proprietario_pj_carreta.uf,
          cidade: ext.cidade || f.proprietario_pj_carreta.cidade,
          bairro: ext.bairro || f.proprietario_pj_carreta.bairro,
          logradouro: ext.logradouro || f.proprietario_pj_carreta.logradouro,
          numero: ext.numero || f.proprietario_pj_carreta.numero,
        },
      }));
      toast({ title: "Cartao CNPJ extraido", description: "Dados da empresa (carreta) preenchidos." });
    } catch (e) {
      showError("Falha ao extrair Cartao CNPJ", e);
    }
  };

  // ─── Handler: CNH proprietario PF (carreta) ───
  const handleCnhProprietarioCarretaFile = async (file: File) => {
    try {
      const { pessoal, cnh } = await ocrCnh(file);
      setForm((f) => ({
        ...f,
        proprietario_pf_carreta: {
          ...f.proprietario_pf_carreta,
          nome: pessoal.nome || f.proprietario_pf_carreta.nome,
          cpf: pessoal.cpf ? formatCpf(pessoal.cpf) : f.proprietario_pf_carreta.cpf,
          data_nascimento: toIsoDate(pessoal.data_nascimento) || f.proprietario_pf_carreta.data_nascimento,
          nome_pai: pessoal.nome_pai || f.proprietario_pf_carreta.nome_pai,
          nome_mae: pessoal.nome_mae || f.proprietario_pf_carreta.nome_mae,
          naturalidade: pessoal.naturalidade || f.proprietario_pf_carreta.naturalidade,
          rg: pessoal.rg || f.proprietario_pf_carreta.rg,
          rg_orgao: pessoal.rg_orgao || f.proprietario_pf_carreta.rg_orgao,
          rg_uf: pessoal.rg_uf || f.proprietario_pf_carreta.rg_uf,
        },
        cnh_proprietario_pf_carreta: {
          ...f.cnh_proprietario_pf_carreta,
          registro: cnh.registro || f.cnh_proprietario_pf_carreta.registro,
          categoria: cnh.categoria || f.cnh_proprietario_pf_carreta.categoria,
          codigo_seguranca: cnh.codigo_seguranca || f.cnh_proprietario_pf_carreta.codigo_seguranca,
          numero_espelho: cnh.numero_espelho || f.cnh_proprietario_pf_carreta.numero_espelho,
          uf_emissor: cnh.uf_emissor || f.cnh_proprietario_pf_carreta.uf_emissor,
          validade: toIsoDate(cnh.validade) || f.cnh_proprietario_pf_carreta.validade,
          primeira_emissao: toIsoDate(cnh.primeira_emissao) || f.cnh_proprietario_pf_carreta.primeira_emissao,
        },
      }));
      toast({ title: "CNH proprietario extraida", description: "Dados pessoais e da CNH (carreta) preenchidos." });
    } catch (e) {
      showError("Falha ao extrair CNH do proprietario", e);
    }
  };

  if (enviado) {
    return (
      <div className="admin-theme admin-page-shell relative min-h-[100dvh] overflow-x-hidden overflow-y-auto bg-background">
        <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[1180px] items-center justify-center px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
          <section className="flex w-full justify-center">
            <div className="admin-auth-panel relative w-full max-w-[560px] !rounded-xl p-8 sm:p-10 text-center">
              <div className="flex flex-col items-center gap-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-green-500/30 bg-green-500/10">
                  <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-foreground">Cadastro enviado com sucesso!</h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Nossa equipe analisara seus documentos em ate <strong>24 horas</strong>.
                    Entraremos em contato pelo telefone informado.
                  </p>
                </div>
                <div className="mt-2 w-full rounded-xl border border-border bg-muted/40 px-5 py-4 text-left">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Motorista</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{form.motorista.nome || "—"}</p>
                  {form.cavalo.placa && (
                    <>
                      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cavalo</p>
                      <p className="mt-1 text-sm font-semibold text-foreground">{form.cavalo.placa}</p>
                    </>
                  )}
                </div>
                <p className="text-xs text-muted-foreground/70">Protocolo: {form.id_cadastro}</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-theme admin-page-shell relative min-h-[100dvh] overflow-x-hidden overflow-y-auto bg-background">
      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[1180px] items-start justify-center px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <section className="flex w-full justify-center">
          <div className="admin-auth-panel relative w-full max-w-[920px] !rounded-xl p-5 sm:p-7 lg:p-9">
            {/* Header */}
            <div className="relative">
              <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                <div className="admin-card-surface inline-flex rounded-xl border px-3.5 py-2.5 shadow-[0_16px_36px_-28px_rgba(2,36,131,0.26)] backdrop-blur-xl sm:px-4">
                  <Logo />
                </div>
                <div className="inline-flex items-center gap-2 rounded-xl border border-primary/12 bg-primary/[0.06] px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.26em] text-primary/70">
                  Cadastro motorista PJ
                </div>
              </div>
              <div className="mt-5 max-w-[720px] sm:mt-6">
                <h1 className="text-[clamp(1.7rem,4vw,2.4rem)] font-bold leading-[1.05] tracking-tight text-foreground">
                  Cadastro de motorista e veiculo
                </h1>
                <p className="mt-2.5 text-sm leading-6 text-muted-foreground sm:text-[0.95rem]">
                  Preencha os dados do motorista, dos veiculos (cavalo e carreta) e dos
                  proprietarios. Anexe os documentos — o sistema valida e preenche os campos
                  automaticamente.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="relative mt-7 sm:mt-8">
              <Tabs value={activeTab} onValueChange={tryChangeTab} className="w-full">
                {/* Stepper horizontal */}
                <div className="overflow-x-auto pb-2">
                  <TabsList className="flex h-auto w-full min-w-max items-start gap-0 bg-transparent p-0">
                    {TABS.map((tab, idx) => {
                      const Icon = tab.icon;
                      const complete = tab.isComplete(form, propTipo, propCarretaTipo);
                      const isActive = activeTab === tab.id;
                      const unlocked = FREE_NAV || isTabUnlocked(idx);
                      const showLock = !unlocked && !isActive;
                      const isLastTab = idx === TABS.length - 1;

                      return (
                        <div
                          key={tab.id}
                          className="flex flex-1 flex-col items-center"
                        >
                          {/* Linha + circulo */}
                          <div className="relative flex w-full items-center justify-center">
                            {/* Linha conectora a esquerda */}
                            {idx > 0 && (
                              <div
                                className={`absolute left-0 right-1/2 top-1/2 h-[2px] -translate-y-1/2 ${
                                  TABS[idx - 1].isComplete(form, propTipo, propCarretaTipo)
                                    ? "bg-primary"
                                    : "bg-border"
                                }`}
                              />
                            )}
                            {/* Linha conectora a direita */}
                            {!isLastTab && (
                              <div
                                className={`absolute left-1/2 right-0 top-1/2 h-[2px] -translate-y-1/2 ${
                                  complete ? "bg-primary" : "bg-border"
                                }`}
                              />
                            )}

                            <TabsTrigger
                              value={tab.id}
                              disabled={showLock}
                              aria-disabled={showLock}
                              title={
                                showLock
                                  ? "Conclua as etapas anteriores para liberar"
                                  : tab.label
                              }
                              className={`relative z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 text-sm font-semibold transition-all data-[state=active]:bg-primary data-[state=active]:text-white ${
                                isActive
                                  ? "border-primary bg-primary text-white shadow-[0_8px_24px_-12px_rgba(2,36,131,0.45)] ring-4 ring-primary/15"
                                  : complete
                                    ? "border-primary bg-primary text-white"
                                    : showLock
                                      ? "cursor-not-allowed border-border bg-card text-muted-foreground/50"
                                      : "border-border bg-card text-foreground/70 hover:border-primary/40 hover:text-foreground"
                              }`}
                            >
                              {showLock ? (
                                <Lock className="h-4 w-4" />
                              ) : complete && !isActive ? (
                                <CheckCircle2 className="h-5 w-5" />
                              ) : (
                                <span>{idx + 1}</span>
                              )}
                            </TabsTrigger>
                          </div>

                          {/* Label embaixo */}
                          <div className="mt-2 flex flex-col items-center gap-0.5 px-1 text-center">
                            <div className="flex items-center gap-1.5">
                              <Icon
                                className={`h-3 w-3 ${
                                  isActive
                                    ? "text-primary"
                                    : complete
                                      ? "text-primary/70"
                                      : "text-muted-foreground"
                                }`}
                              />
                              <span
                                className={`text-[0.7rem] font-semibold uppercase tracking-wide ${
                                  isActive
                                    ? "text-foreground"
                                    : complete
                                      ? "text-foreground/85"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {tab.label}
                              </span>
                            </div>
                            <span className="text-[0.62rem] font-medium text-muted-foreground/70">
                              Etapa {idx + 1}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </TabsList>
                </div>

                {/* Motorista */}
                <TabsContent value="motorista" className="mt-6 space-y-5">
                  <Section
                    title="Dados pessoais e RG"
                    icon={IdCard}
                    description="Anexe a CNH para extrair os dados automaticamente"
                    collapsible
                    defaultOpen={false}
                    badge={countFilled(form.motorista as unknown as Record<string, unknown>, [
                      "nome",
                      "cpf",
                      "data_nascimento",
                      "nome_pai",
                      "nome_mae",
                      "naturalidade",
                      "rg",
                      "rg_orgao",
                      "rg_uf",
                    ])}
                  >
                    <div className="sm:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <FileUploadField
                        label="Anexar imagem da CNH"
                        value={form.arquivos.cnh}
                        onChange={(v) =>
                          setForm({ ...form, arquivos: { ...form.arquivos, cnh: v } })
                        }
                        onFile={handleCnhMotoristaFile}
                        required
                      />
                      <FileUploadField
                        label="Selfie segurando a CNH"
                        value={form.arquivos.selfie_cnh}
                        onChange={(v) =>
                          setForm({ ...form, arquivos: { ...form.arquivos, selfie_cnh: v } })
                        }
                        accept="image/*"
                      />
                    </div>
                    <PessoaFields
                      value={form.motorista}
                      onChange={(p) =>
                        setForm({ ...form, motorista: { ...form.motorista, ...p } })
                      }
                      required
                    />
                    <TelefonesField
                      values={form.motorista.telefones}
                      onChange={(v) =>
                        setForm({ ...form, motorista: { ...form.motorista, telefones: v } })
                      }
                    />
                    <div className="sm:col-span-2">
                      <label className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3 text-sm">
                        <input
                          type="checkbox"
                          checked={form.motorista.tambem_proprietario}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              motorista: {
                                ...form.motorista,
                                tambem_proprietario: e.target.checked,
                              },
                            })
                          }
                          className="mt-0.5 h-4 w-4 rounded border-primary/30 text-primary focus:ring-primary"
                        />
                        <span className="text-foreground/85">
                          O motorista <strong>tambem e o proprietario</strong> do cavalo
                          <span className="block text-xs text-muted-foreground">
                            Marque para reaproveitar os dados do motorista como proprietario.
                          </span>
                        </span>
                      </label>
                    </div>
                  </Section>

                  <Section
                    title="Dados da CNH"
                    icon={IdCard}
                    description="Registro, categoria, validade e código de segurança da CNH"
                    collapsible
                    defaultOpen={false}
                    badge={countFilled(form.cnh as unknown as Record<string, unknown>, [
                      "registro",
                      "categoria",
                      "codigo_seguranca",
                      "numero_espelho",
                      "uf_emissor",
                      "validade",
                      "primeira_emissao",
                    ])}
                  >
                    <CnhFields
                      value={form.cnh}
                      onChange={(v) => setForm({ ...form, cnh: v })}
                      required
                    />
                    <CnhStatusCard
                      validade={form.cnh.validade}
                      categoria={form.cnh.categoria}
                      registro={form.cnh.registro}
                    />
                  </Section>

                  {/* Endereco do motorista (com upload de comprovante inline) */}
                  <Section
                    title="Endereco do motorista"
                    icon={MapPin}
                    description="Anexe o comprovante para extrair os dados automaticamente"
                    collapsible
                    defaultOpen={false}
                    badge={countFilled(
                      form.endereco_motorista as unknown as Record<string, unknown>,
                      ["cep", "uf", "cidade", "bairro", "logradouro", "numero"],
                    )}
                  >
                    <div className="sm:col-span-2">
                      <FileUploadField
                        label="Comprovante de residencia (motorista)"
                        value={form.arquivos.comprovante_motorista}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            arquivos: { ...form.arquivos, comprovante_motorista: v },
                          })
                        }
                        onFile={handleComprovanteMotoristaFile}
                        required
                      />
                    </div>
                    <EnderecoFields
                      value={form.endereco_motorista}
                      onChange={(v) => setForm({ ...form, endereco_motorista: v })}
                      required
                    />
                  </Section>
                </TabsContent>

                {/* Cavalo */}
                <TabsContent value="cavalo" className="mt-6 space-y-5">
                  <Section
                    title="Cavalo (veiculo trator)"
                    icon={Truck}
                    description="Anexe o CRLV para extrair os dados automaticamente"
                    collapsible
                    defaultOpen={false}
                    badge={countFilled(form.cavalo as unknown as Record<string, unknown>, [
                      "placa",
                      "tipo",
                      "marca",
                      "modelo",
                      "ano_fabricacao",
                      "ano_modelo",
                      "cor",
                      "renavam",
                      "chassi",
                      "antt",
                      "ultimo_licenciamento",
                    ])}
                  >
                    <div className="sm:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <FileUploadField
                        label="CRLV do cavalo"
                        value={form.arquivos.crlv_cavalo}
                        onChange={(v) =>
                          setForm({ ...form, arquivos: { ...form.arquivos, crlv_cavalo: v } })
                        }
                        onFile={(file) => handleCrlvFile(file, "cavalo")}
                        required
                      />
                      <FileUploadField
                        label="ANTT / RNTRC (PDF) - opcional"
                        value={form.arquivos.antt_cavalo}
                        onChange={(v) =>
                          setForm({ ...form, arquivos: { ...form.arquivos, antt_cavalo: v } })
                        }
                      />
                    </div>
                    <VeiculoFields
                      value={form.cavalo}
                      onChange={(v) => setForm({ ...form, cavalo: v })}
                      required
                      crlvSnapshot={crlvSnapshot.cavalo}
                    />
                    <CrlvStatusCard
                      ultimoLicenciamento={form.cavalo.ultimo_licenciamento}
                      placa={form.cavalo.placa}
                      onlineResult={veiculoResults.cavalo}
                      onlineLoading={!!veiculoLoading.cavalo}
                      onVerifyOnline={() => verificarVeiculoOnline("cavalo")}
                    />
                    <AnttStatusCard
                      result={anttResults.cavalo}
                      loading={!!anttLoading.cavalo}
                      onValidate={() => validateAntt("cavalo")}
                      placa={form.cavalo.placa}
                    />
                  </Section>
                </TabsContent>

                {/* Carreta */}
                <TabsContent value="carreta" className="mt-6 space-y-5">
                  {/* Tipo de composicao: define quantas carretas o cadastro tem */}
                  <div className="rounded-xl border border-primary/15 bg-primary/[0.04] p-4">
                    <p className={`${labelClasses} mb-2`}>Tipo de composicao</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {(
                        [
                          { value: "sem_carreta", label: "Sem carreta", desc: "So cavalo" },
                          { value: "1_carreta", label: "1 carreta", desc: "Cavalo + carreta" },
                          { value: "bitrem", label: "Bitrem", desc: "Cavalo + 2 carretas" },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => {
                            setForm((f) => {
                              const next = { ...f, tipo_composicao: opt.value };
                              // Bitrem exige pelo menos 1 carreta extra.
                              if (opt.value === "bitrem" && f.carretas_extras.length === 0) {
                                next.carretas_extras = [
                                  { veiculo: { ...emptyVeiculo }, arquivo_crlv: "" },
                                ];
                              }
                              return next;
                            });
                          }}
                          className={`rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-all ${
                            form.tipo_composicao === opt.value
                              ? "admin-primary-button border-transparent text-white"
                              : "admin-input-surface text-foreground/80 hover:border-primary/30"
                          }`}
                        >
                          <span className="block">{opt.label}</span>
                          <span className={`block text-[0.65rem] font-normal ${
                            form.tipo_composicao === opt.value ? "text-white/75" : "text-muted-foreground"
                          }`}>
                            {opt.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Aviso quando "sem carreta" */}
                  {form.tipo_composicao === "sem_carreta" && (
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-4 text-sm text-emerald-700 dark:text-emerald-400">
                      <strong>Cadastro sem carreta.</strong>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Voce indicou que o cadastro tem apenas o cavalo. Pode prosseguir para a
                        proxima aba.
                      </p>
                    </div>
                  )}

                  {form.tipo_composicao !== "sem_carreta" && (
                  <div className="rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3">
                    <label className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={form.carreta_proprietario_diferente}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            carreta_proprietario_diferente: e.target.checked,
                          })
                        }
                        className="mt-0.5 h-4 w-4 rounded border-primary/30 text-primary focus:ring-primary"
                      />
                      <span className="text-foreground/85">
                        A carreta tem <strong>proprietario diferente</strong> do cavalo
                        <span className="block text-xs text-muted-foreground">
                          Se desmarcado, assumimos que o proprietario do cavalo tambem e o da carreta.
                        </span>
                      </span>
                    </label>
                  </div>
                  )}

                  {form.tipo_composicao !== "sem_carreta" && (
                  <Section
                    title={form.tipo_composicao === "bitrem" ? "Carreta principal" : "Carreta (semi-reboque)"}
                    icon={Truck}
                    description="Anexe o CRLV para extrair os dados automaticamente"
                    collapsible
                    defaultOpen={false}
                    badge={countFilled(form.carreta as unknown as Record<string, unknown>, [
                      "placa",
                      "tipo",
                      "marca",
                      "modelo",
                      "ano_fabricacao",
                      "ano_modelo",
                      "cor",
                      "renavam",
                      "chassi",
                      "antt",
                      "ultimo_licenciamento",
                    ])}
                  >
                    <div className="sm:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <FileUploadField
                        label="CRLV da carreta"
                        value={form.arquivos.crlv_carreta}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            arquivos: { ...form.arquivos, crlv_carreta: v },
                          })
                        }
                        onFile={(file) => handleCrlvFile(file, "carreta")}
                      />
                      <FileUploadField
                        label="ANTT / RNTRC (PDF) - opcional"
                        value={form.arquivos.antt_carreta}
                        onChange={(v) =>
                          setForm({ ...form, arquivos: { ...form.arquivos, antt_carreta: v } })
                        }
                      />
                    </div>
                    <VeiculoFields
                      value={form.carreta}
                      onChange={(v) => setForm({ ...form, carreta: v })}
                      crlvSnapshot={crlvSnapshot.carreta}
                    />
                    <CrlvStatusCard
                      ultimoLicenciamento={form.carreta.ultimo_licenciamento}
                      placa={form.carreta.placa}
                      onlineResult={veiculoResults.carreta}
                      onlineLoading={!!veiculoLoading.carreta}
                      onVerifyOnline={() => verificarVeiculoOnline("carreta")}
                    />
                    <AnttStatusCard
                      result={anttResults.carreta}
                      loading={!!anttLoading.carreta}
                      onValidate={() => validateAntt("carreta")}
                      placa={form.carreta.placa}
                    />
                  </Section>
                  )}

                  {/* Carretas extras (so visiveis se nao for sem_carreta) */}
                  {form.tipo_composicao !== "sem_carreta" && form.carretas_extras.map((extra, idx) => (
                    <Section
                      key={idx}
                      title={`Carreta adicional #${idx + 2}`}
                      icon={Truck}
                      description={`Placa ${extra.veiculo.placa || "—"}`}
                      collapsible
                      defaultOpen={false}
                      badge={countFilled(extra.veiculo as unknown as Record<string, unknown>, [
                        "placa",
                        "tipo",
                        "marca",
                        "modelo",
                        "ano_fabricacao",
                        "ano_modelo",
                        "cor",
                        "renavam",
                        "chassi",
                        "antt",
                        "ultimo_licenciamento",
                      ])}
                    >
                      <div className="sm:col-span-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            setForm((f) => ({
                              ...f,
                              carretas_extras: f.carretas_extras.filter((_, i) => i !== idx),
                            }));
                          }}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-destructive/30 bg-destructive/[0.04] px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10"
                        >
                          <X className="h-3.5 w-3.5" />
                          Remover esta carreta
                        </button>
                      </div>
                      <div className="sm:col-span-2">
                        <FileUploadField
                          label={`CRLV da carreta #${idx + 2}`}
                          value={extra.arquivo_crlv}
                          onChange={(v) =>
                            setForm((f) => ({
                              ...f,
                              carretas_extras: f.carretas_extras.map((c, i) =>
                                i === idx ? { ...c, arquivo_crlv: v } : c,
                              ),
                            }))
                          }
                          onFile={async (file) => {
                            try {
                              const { veiculo } = await ocrCrlv(file, `${form.id_cadastro}:carreta`);
                              setForm((f) => ({
                                ...f,
                                carretas_extras: f.carretas_extras.map((c, i) =>
                                  i === idx
                                    ? {
                                        ...c,
                                        veiculo: {
                                          ...c.veiculo,
                                          placa: formatPlaca(veiculo.placa) || c.veiculo.placa,
                                          tipo: veiculo.tipo || c.veiculo.tipo,
                                          carroceria: veiculo.carroceria || c.veiculo.carroceria,
                                          proprietario:
                                            veiculo.proprietario || c.veiculo.proprietario,
                                          marca: veiculo.marca || c.veiculo.marca,
                                          modelo: veiculo.modelo || c.veiculo.modelo,
                                          ano_fabricacao:
                                            onlyYear(veiculo.ano_fabricacao) ||
                                            c.veiculo.ano_fabricacao,
                                          ano_modelo:
                                            onlyYear(veiculo.ano_modelo) || c.veiculo.ano_modelo,
                                          cor: veiculo.cor || c.veiculo.cor,
                                          uf_emplacamento:
                                            veiculo.uf_emplacamento || c.veiculo.uf_emplacamento,
                                          cidade_emplacamento:
                                            veiculo.cidade_emplacamento ||
                                            c.veiculo.cidade_emplacamento,
                                          renavam:
                                            veiculo.renavam.replace(/\D/g, "").slice(0, 11) ||
                                            c.veiculo.renavam,
                                          chassi:
                                            veiculo.chassi.toUpperCase().slice(0, 17) ||
                                            c.veiculo.chassi,
                                          eixos:
                                            veiculo.eixos.replace(/\D/g, "").slice(0, 2) ||
                                            c.veiculo.eixos,
                                          antt: veiculo.antt || c.veiculo.antt,
                                          ultimo_licenciamento:
                                            toIsoDate(veiculo.ultimo_licenciamento) ||
                                            c.veiculo.ultimo_licenciamento,
                                        },
                                      }
                                    : c,
                                ),
                              }));
                              toast({
                                title: `CRLV carreta #${idx + 2} extraido`,
                                description: "Dados do veiculo preenchidos.",
                              });
                            } catch (e) {
                              showError("Falha ao extrair CRLV", e);
                            }
                          }}
                        />
                      </div>
                      <VeiculoFields
                        value={extra.veiculo}
                        onChange={(v) =>
                          setForm((f) => ({
                            ...f,
                            carretas_extras: f.carretas_extras.map((c, i) =>
                              i === idx ? { ...c, veiculo: v } : c,
                            ),
                          }))
                        }
                      />
                      <CrlvStatusCard
                        ultimoLicenciamento={extra.veiculo.ultimo_licenciamento}
                        placa={extra.veiculo.placa}
                      />
                    </Section>
                  ))}

                  {/* Botao adicionar mais carretas (so se houver carreta) */}
                  {form.tipo_composicao !== "sem_carreta" && (
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => {
                          setForm((f) => ({
                            ...f,
                            carretas_extras: [
                              ...f.carretas_extras,
                              { veiculo: { ...emptyVeiculo }, arquivo_crlv: "" },
                            ],
                          }));
                        }}
                        className="admin-input-surface inline-flex items-center gap-2 rounded-xl border border-dashed px-5 py-3 text-sm font-semibold text-foreground/80 transition-all hover:border-primary/40 hover:text-foreground"
                      >
                        <Plus className="h-4 w-4" />
                        Adicionar outra carreta
                      </button>
                    </div>
                  )}
                </TabsContent>

                {/* Operacional — tag pedagio, Pancary, rastreador */}
                <TabsContent value="operacional" className="mt-6 space-y-5">
                  <Section
                    title="Tag de pedagio e Pancary"
                    icon={Hash}
                    description="Recursos eletronicos de pedagio e antifurto"
                    collapsible
                    defaultOpen={false}
                    badge={countFilled(
                      {
                        tag: form.operacional.tag_pedagio,
                        pancary: form.operacional.possui_pancary ? "1" : "",
                      },
                      ["tag", "pancary"],
                    )}
                  >
                    <Field label="Tag de pedagio" icon={Hash}>
                      <SelectInput
                        value={form.operacional.tag_pedagio}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            operacional: { ...form.operacional, tag_pedagio: v },
                          })
                        }
                        options={TAGS_PEDAGIO}
                        icon={Hash}
                        placeholder="Selecione"
                      />
                    </Field>
                    <Field label="Pancary">
                      <label className="flex items-center gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3 text-sm">
                        <input
                          type="checkbox"
                          checked={form.operacional.possui_pancary}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              operacional: {
                                ...form.operacional,
                                possui_pancary: e.target.checked,
                              },
                            })
                          }
                          className="h-4 w-4 rounded border-primary/30 text-primary focus:ring-primary"
                        />
                        <span className="text-foreground/85">Possui Pancary</span>
                      </label>
                    </Field>
                  </Section>

                  <Section
                    title="Rastreador"
                    icon={Hash}
                    description="Equipamento de rastreamento veicular"
                    collapsible
                    defaultOpen={false}
                    badge={countFilled(
                      form.operacional.rastreador as unknown as Record<string, unknown>,
                      ["marca", "numero", "arquivo"],
                    )}
                  >
                    <Field label="Marca do rastreador">
                      <TextInput
                        value={form.operacional.rastreador.marca}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            operacional: {
                              ...form.operacional,
                              rastreador: { ...form.operacional.rastreador, marca: v },
                            },
                          })
                        }
                        placeholder="Ex.: Sascar, Onixsat, Autotrac"
                      />
                    </Field>
                    <Field label="Numero / serie do rastreador" icon={Hash}>
                      <TextInput
                        value={form.operacional.rastreador.numero}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            operacional: {
                              ...form.operacional,
                              rastreador: { ...form.operacional.rastreador, numero: v },
                            },
                          })
                        }
                        placeholder="Numero do equipamento"
                        icon={Hash}
                      />
                    </Field>
                    <div className="sm:col-span-2">
                      <FileUploadField
                        label="Contrato / foto do rastreador (opcional)"
                        value={form.operacional.rastreador.arquivo}
                        onChange={(v) =>
                          setForm({
                            ...form,
                            operacional: {
                              ...form.operacional,
                              rastreador: { ...form.operacional.rastreador, arquivo: v },
                            },
                          })
                        }
                      />
                    </div>
                  </Section>
                </TabsContent>

                {/* Proprietario */}
                <TabsContent value="proprietario" className="mt-6 space-y-5">
                  {/* Banner explicando o fluxo de auto-preenchimento */}
                  {(!motoristaIsProprietario || carretaDiferente) && (
                    <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-5 sm:p-6">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                          <Sparkles className="h-4 w-4" />
                        </div>
                        <div className="space-y-2 text-sm leading-6">
                          <p className="font-semibold text-foreground">
                            Como os dados sao preenchidos automaticamente
                          </p>
                          <ol className="list-decimal space-y-1 pl-4 text-foreground/75">
                            <li>
                              O CRLV anexado nas abas <strong>Cavalo</strong> e{" "}
                              <strong>Carreta</strong> e processado por OCR. Dele extraimos os
                              dados do veiculo e o CPF/CNPJ do proprietario.
                            </li>
                            <li>
                              Se o proprietario for <strong>PJ</strong>, o CNPJ alimenta uma
                              consulta automatica que traz razao social, endereco e contatos
                              (efeito do <em>Cartao CNPJ</em>).
                            </li>
                            <li>
                              Se for <strong>PF</strong>, a CNH do proprietario serve de fonte:
                              ao anexar, o OCR preenche os dados pessoais e a CNH dele.
                            </li>
                            <li>
                              Voce so precisa <strong>conferir e ajustar</strong> antes de
                              enviar.
                            </li>
                          </ol>
                          <p className="text-xs leading-5 text-muted-foreground">
                            Se a consulta automatica nao preencher tudo, use o botao{" "}
                            <strong>Buscar</strong> ao lado do CNPJ para repetir a consulta
                            manualmente.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Quando o motorista e proprietario do cavalo: mostra os dados
                      dele encapsulados (read-only-friendly). O usuario pode revisar
                      sem reanexar/redigitar nada. */}
                  {motoristaIsProprietario && (
                    <Section
                      title="Proprietario do cavalo (= motorista)"
                      icon={Users}
                      description="Os dados ja foram preenchidos na aba Motorista. Confira aqui se quiser revisar."
                      collapsible
                      defaultOpen={false}
                      badge={countFilled(
                        form.motorista as unknown as Record<string, unknown>,
                        ["nome", "cpf", "data_nascimento", "rg", "telefones"],
                      )}
                    >
                      <SubSection title="Dados do motorista (proprietario)">
                        <PessoaFields
                          value={form.motorista}
                          onChange={(p) =>
                            setForm({ ...form, motorista: { ...form.motorista, ...p } })
                          }
                          required
                        />
                      </SubSection>
                      <SubSection title="CNH do motorista (proprietario)">
                        <CnhFields
                          value={form.cnh}
                          onChange={(v) => setForm({ ...form, cnh: v })}
                          required
                        />
                      </SubSection>
                      <SubSection title="Endereco do motorista (proprietario)">
                        <EnderecoFields
                          value={form.endereco_motorista}
                          onChange={(v) => setForm({ ...form, endereco_motorista: v })}
                          required
                        />
                      </SubSection>
                    </Section>
                  )}

                  {/* Proprietario do cavalo */}
                  {!motoristaIsProprietario && (
                    <Section
                      title="Proprietario do cavalo"
                      icon={Users}
                      description="Selecione PJ ou PF e anexe o documento - o sistema preenche automaticamente"
                      collapsible
                      defaultOpen={false}
                      badge={
                        propTipo === "PJ"
                          ? countFilled(
                              form.proprietario_pj as unknown as Record<string, unknown>,
                              ["nome", "cnpj", "cep", "uf", "cidade", "bairro", "logradouro", "numero", "telefones"],
                            )
                          : propTipo === "PF"
                            ? countFilled(
                                form.proprietario_pf as unknown as Record<string, unknown>,
                                ["nome", "cpf", "data_nascimento", "rg", "cep", "uf", "cidade", "telefones"],
                              )
                            : "—"
                      }
                    >
                      <div className="sm:col-span-2">
                        <label className={labelClasses}>Tipo de proprietario</label>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          {(["PJ", "PF"] as const).map((tipo) => (
                            <button
                              key={tipo}
                              type="button"
                              onClick={() => setPropTipo(tipo)}
                              className={`rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
                                propTipo === tipo
                                  ? "admin-primary-button border-transparent text-white"
                                  : "admin-input-surface text-foreground/80 hover:border-primary/30"
                              }`}
                            >
                              {tipo === "PJ" ? "Pessoa Juridica (PJ)" : "Pessoa Fisica (PF)"}
                            </button>
                          ))}
                        </div>
                      </div>

                      {propTipo === "PJ" && (
                        <>
                          <div className="sm:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <FileUploadField
                              label="Cartao CNPJ"
                              value={form.arquivos.cartao_cnpj}
                              onChange={(v) =>
                                setForm({
                                  ...form,
                                  arquivos: { ...form.arquivos, cartao_cnpj: v },
                                })
                              }
                              onFile={handleCartaoCnpjFile}
                              required
                            />
                            <FileUploadField
                              label="Comprovante residencia (proprietario)"
                              value={form.arquivos.comprovante_proprietario}
                              onChange={(v) =>
                                setForm({
                                  ...form,
                                  arquivos: { ...form.arquivos, comprovante_proprietario: v },
                                })
                              }
                              onFile={handleComprovanteProprietarioFile}
                            />
                          </div>
                          <SubSection title="Empresa proprietaria (PJ)">
                            <ProprietarioPJFields
                              value={form.proprietario_pj}
                              onChange={(v) => setForm({ ...form, proprietario_pj: v })}
                              onCnpjResult={(r) =>
                                setCnpjResults((s) => ({ ...s, cavalo: r }))
                              }
                            />
                            {cnpjResults.cavalo ? (
                              <CnpjStatusCard result={cnpjResults.cavalo} />
                            ) : null}
                          </SubSection>
                        </>
                      )}

                      {propTipo === "PF" && (
                        <>
                          <div className="sm:col-span-2">
                            <label className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3 text-sm">
                              <input
                                type="checkbox"
                                checked={form.proprietario_pf.tem_cnh}
                                onChange={(e) =>
                                  setForm({
                                    ...form,
                                    proprietario_pf: {
                                      ...form.proprietario_pf,
                                      tem_cnh: e.target.checked,
                                    },
                                  })
                                }
                                className="mt-0.5 h-4 w-4 rounded border-primary/30 text-primary focus:ring-primary"
                              />
                              <span className="text-foreground/85">
                                O proprietario <strong>possui CNH</strong>
                                <span className="block text-xs text-muted-foreground">
                                  Desmarque se o proprietario nao tem CNH (apenas RG/Carteira de
                                  Identidade). Os campos de CNH ficam ocultos e o anexo passa a
                                  ser o RG.
                                </span>
                              </span>
                            </label>
                          </div>
                          <div className="sm:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <FileUploadField
                              label={
                                form.proprietario_pf.tem_cnh
                                  ? "CNH do proprietario"
                                  : "RG do proprietario"
                              }
                              value={form.arquivos.cnh_proprietario}
                              onChange={(v) =>
                                setForm({
                                  ...form,
                                  arquivos: { ...form.arquivos, cnh_proprietario: v },
                                })
                              }
                              onFile={
                                form.proprietario_pf.tem_cnh
                                  ? handleCnhProprietarioFile
                                  : undefined
                              }
                              required
                            />
                            <FileUploadField
                              label="Comprovante residencia (proprietario)"
                              value={form.arquivos.comprovante_proprietario}
                              onChange={(v) =>
                                setForm({
                                  ...form,
                                  arquivos: { ...form.arquivos, comprovante_proprietario: v },
                                })
                              }
                              onFile={handleComprovanteProprietarioFile}
                            />
                          </div>
                          <SubSection title="Proprietario (PF)">
                            <ProprietarioPFFields
                              value={form.proprietario_pf}
                              onChange={(v) => setForm({ ...form, proprietario_pf: v })}
                            />
                          </SubSection>
                          {form.proprietario_pf.tem_cnh && (
                            <SubSection title="CNH do proprietario (PF)">
                              <CnhFields
                                value={form.cnh_proprietario_pf}
                                onChange={(v) => setForm({ ...form, cnh_proprietario_pf: v })}
                                required
                              />
                              <CnhStatusCard
                                validade={form.cnh_proprietario_pf.validade}
                                categoria={form.cnh_proprietario_pf.categoria}
                                registro={form.cnh_proprietario_pf.registro}
                              />
                            </SubSection>
                          )}
                        </>
                      )}
                    </Section>
                  )}

                  {/* Proprietario da ANTT do cavalo */}
                  <ProprietarioAnttSection
                    title="Proprietario da ANTT (cavalo)"
                    description="Transportador registrado no RNTRC. Pode ser diferente do dono do CRLV."
                    value={form.proprietario_antt_cavalo}
                    onChange={(v) => setForm({ ...form, proprietario_antt_cavalo: v })}
                  />

                  {/* Proprietario da carreta */}
                  {carretaDiferente && (
                    <Section
                      title="Proprietario da carreta"
                      icon={Users}
                      description="Selecione PJ ou PF e anexe o documento"
                      collapsible
                      defaultOpen={false}
                      badge={
                        propCarretaTipo === "PJ"
                          ? countFilled(
                              form.proprietario_pj_carreta as unknown as Record<string, unknown>,
                              ["nome", "cnpj", "cep", "uf", "cidade", "bairro", "logradouro", "numero", "telefones"],
                            )
                          : propCarretaTipo === "PF"
                            ? countFilled(
                                form.proprietario_pf_carreta as unknown as Record<string, unknown>,
                                ["nome", "cpf", "data_nascimento", "rg", "cep", "uf", "cidade", "telefones"],
                              )
                            : "—"
                      }
                    >
                      <div className="sm:col-span-2">
                        <label className={labelClasses}>Tipo de proprietario</label>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          {(["PJ", "PF"] as const).map((tipo) => (
                            <button
                              key={tipo}
                              type="button"
                              onClick={() => setPropCarretaTipo(tipo)}
                              className={`rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
                                propCarretaTipo === tipo
                                  ? "admin-primary-button border-transparent text-white"
                                  : "admin-input-surface text-foreground/80 hover:border-primary/30"
                              }`}
                            >
                              {tipo === "PJ" ? "Pessoa Juridica (PJ)" : "Pessoa Fisica (PF)"}
                            </button>
                          ))}
                        </div>
                      </div>

                      {propCarretaTipo === "PJ" && (
                        <>
                          <AutoExtractHint />
                          <div className="sm:col-span-2">
                            <FileUploadField
                              label="Cartao CNPJ (carreta)"
                              value={form.arquivos.cartao_cnpj_carreta}
                              onChange={(v) =>
                                setForm({
                                  ...form,
                                  arquivos: { ...form.arquivos, cartao_cnpj_carreta: v },
                                })
                              }
                              onFile={handleCartaoCnpjCarretaFile}
                              required
                            />
                          </div>
                          <SubSection title="Empresa proprietaria da carreta (PJ)">
                            <ProprietarioPJFields
                              value={form.proprietario_pj_carreta}
                              onChange={(v) =>
                                setForm({ ...form, proprietario_pj_carreta: v })
                              }
                              onCnpjResult={(r) =>
                                setCnpjResults((s) => ({ ...s, carreta: r }))
                              }
                            />
                            {cnpjResults.carreta ? (
                              <CnpjStatusCard result={cnpjResults.carreta} />
                            ) : null}
                          </SubSection>
                        </>
                      )}

                      {propCarretaTipo === "PF" && (
                        <>
                          <div className="sm:col-span-2">
                            <label className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] px-4 py-3 text-sm">
                              <input
                                type="checkbox"
                                checked={form.proprietario_pf_carreta.tem_cnh}
                                onChange={(e) =>
                                  setForm({
                                    ...form,
                                    proprietario_pf_carreta: {
                                      ...form.proprietario_pf_carreta,
                                      tem_cnh: e.target.checked,
                                    },
                                  })
                                }
                                className="mt-0.5 h-4 w-4 rounded border-primary/30 text-primary focus:ring-primary"
                              />
                              <span className="text-foreground/85">
                                O proprietario da carreta <strong>possui CNH</strong>
                                <span className="block text-xs text-muted-foreground">
                                  Desmarque se o proprietario nao tem CNH (apenas RG).
                                </span>
                              </span>
                            </label>
                          </div>
                          <AutoExtractHint />
                          <div className="sm:col-span-2">
                            <FileUploadField
                              label={
                                form.proprietario_pf_carreta.tem_cnh
                                  ? "CNH do proprietario (carreta)"
                                  : "RG do proprietario (carreta)"
                              }
                              value={form.arquivos.cnh_proprietario_carreta}
                              onChange={(v) =>
                                setForm({
                                  ...form,
                                  arquivos: { ...form.arquivos, cnh_proprietario_carreta: v },
                                })
                              }
                              onFile={
                                form.proprietario_pf_carreta.tem_cnh
                                  ? handleCnhProprietarioCarretaFile
                                  : undefined
                              }
                              required
                            />
                          </div>
                          <SubSection title="Proprietario da carreta (PF)">
                            <ProprietarioPFFields
                              value={form.proprietario_pf_carreta}
                              onChange={(v) =>
                                setForm({ ...form, proprietario_pf_carreta: v })
                              }
                            />
                          </SubSection>
                          {form.proprietario_pf_carreta.tem_cnh && (
                            <SubSection title="CNH do proprietario da carreta (PF)">
                              <CnhFields
                                value={form.cnh_proprietario_pf_carreta}
                                onChange={(v) =>
                                  setForm({ ...form, cnh_proprietario_pf_carreta: v })
                                }
                                required
                              />
                              <CnhStatusCard
                                validade={form.cnh_proprietario_pf_carreta.validade}
                                categoria={form.cnh_proprietario_pf_carreta.categoria}
                                registro={form.cnh_proprietario_pf_carreta.registro}
                              />
                            </SubSection>
                          )}
                        </>
                      )}
                    </Section>
                  )}

                  {/* Proprietario da ANTT da carreta — so faz sentido se a
                      carreta tem proprietario diferente do cavalo, ou se o
                      tipo de composicao inclui carreta */}
                  {form.tipo_composicao !== "sem_carreta" && (
                    <ProprietarioAnttSection
                      title="Proprietario da ANTT (carreta)"
                      description="Transportador da carreta registrado no RNTRC."
                      value={form.proprietario_antt_carreta}
                      onChange={(v) =>
                        setForm({ ...form, proprietario_antt_carreta: v })
                      }
                    />
                  )}
                </TabsContent>
              </Tabs>

              {/* Navegação inferior */}
              <div className="mt-8 rounded-xl border border-border/60 bg-gradient-to-br from-primary/[0.03] via-card to-card p-4 shadow-[0_2px_12px_-8px_rgba(15,23,42,0.08)] sm:p-5">
                <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    onClick={goPrev}
                    disabled={isFirst}
                    className="admin-input-surface inline-flex items-center justify-center gap-2 rounded-xl border px-5 py-3 text-sm font-semibold text-foreground/80 transition-all hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Anterior
                  </button>

                  <div className="flex flex-col items-center gap-0.5 text-center">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                      Etapa atual
                    </span>
                    <span className="text-sm font-bold text-foreground">
                      {currentIndex + 1} <span className="text-muted-foreground/70">de</span> {TABS.length}
                    </span>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || (!FREE_NAV && !isLast && !currentTabComplete)}
                    title={
                      !FREE_NAV && !isLast && !currentTabComplete
                        ? "Complete os campos obrigatorios desta aba para avancar"
                        : undefined
                    }
                    className="admin-primary-button inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-[0_8px_24px_-12px_rgba(2,36,131,0.45)] transition-all disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none sm:w-auto"
                  >
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isLast ? (
                      <>
                        <Send className="h-4 w-4" />
                        Enviar cadastro
                      </>
                    ) : (
                      <>
                        Proximo
                        <ChevronRight className="h-4 w-4" />
                      </>
                    )}
                  </button>
                </div>
              </div>

              <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">
                Ao enviar, voce confirma que os dados informados sao verdadeiros e autoriza a
                Lamonica a valida-los junto aos orgaos competentes.
              </p>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
};

export default CadastroDocumentos;
