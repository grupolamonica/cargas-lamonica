import { type ReactNode } from "react";
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  CircleAlert,
  ClipboardList,
  Copy,
  FileText,
  MapPin,
  Package,
  Phone,
  ShieldCheck,
  TimerReset,
  Truck,
  UserRound,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getCargaById, getCargaPath, getCargaShareUrl } from "@/data/cargas";
import { formatEstimatedTime } from "@/lib/estimated-time";

interface DetailCardProps {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  children: ReactNode;
}

const formatOperationalDate = (value: string) =>
  format(parseISO(value), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });

const DetailCard = ({ icon, eyebrow, title, children }: DetailCardProps) => (
  <section className="rounded-3xl border border-border/50 bg-card p-5 sm:p-6 premium-shadow">
    <div className="mb-4 flex items-start gap-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        {icon}
      </div>
      <div>
        <p className="text-[11px] font-extrabold uppercase tracking-[0.25em] text-muted-foreground">
          {eyebrow}
        </p>
        <h2 className="mt-1 text-xl font-extrabold tracking-tight text-card-foreground">
          {title}
        </h2>
      </div>
    </div>
    {children}
  </section>
);

const LoadDetails = () => {
  const { id } = useParams();
  const carga = id ? getCargaById(id) : undefined;

  const copyShareLink = async () => {
    if (!carga) {
      return;
    }

    const shareUrl =
      typeof window === "undefined"
        ? getCargaPath(carga.id)
        : getCargaShareUrl(window.location.origin, carga.id);

    try {
      if (!navigator.clipboard) {
        throw new Error("clipboard-unavailable");
      }

      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link da carga copiado com sucesso.");
    } catch {
      toast.error("Não foi possível copiar o link.");
    }
  };

  if (!carga) {
    return (
      <div className="min-h-screen bg-background px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Button asChild variant="ghost" className="w-fit rounded-2xl">
            <Link to="/">
              <ArrowLeft className="h-4 w-4" />
              Voltar para cargas
            </Link>
          </Button>

          <section className="rounded-[28px] border border-border/50 bg-card p-8 text-center premium-shadow">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
              <CircleAlert className="h-7 w-7" />
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-card-foreground">
              Carga não encontrada
            </h1>
            <p className="mt-3 text-base text-muted-foreground">
              Esse link não corresponde a uma carga disponível no painel atual.
            </p>
          </section>
        </div>
      </div>
    );
  }

  const tempoEstimado = formatEstimatedTime(carga.dataCarregamento, carga.dataDescarga);

  return (
    <div className="min-h-screen bg-background">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary/90 to-primary/75" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,hsl(var(--accent)/0.22),transparent_55%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,hsl(var(--primary)/0.35),transparent_50%)]" />

        <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-8 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Button asChild variant="ghost" className="w-fit rounded-2xl bg-white/10 text-white hover:bg-white/15 hover:text-white">
              <Link to="/">
                <ArrowLeft className="h-4 w-4" />
                Voltar para cargas
              </Link>
            </Button>

            <div className="flex flex-wrap gap-3">
              <Button
                asChild
                variant="outline"
                className="rounded-2xl border-white/20 bg-white/10 text-white hover:bg-white/15 hover:text-white"
              >
                <Link to="/operador">Painel do operador</Link>
              </Button>
              <Button
                variant="outline"
                className="rounded-2xl border-white/20 bg-white/10 text-white hover:bg-white/15 hover:text-white"
                onClick={copyShareLink}
              >
                <Copy className="h-4 w-4" />
                Copiar link direto
              </Button>
            </div>
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
            <section className="rounded-[32px] border border-white/10 bg-white/[0.08] p-6 backdrop-blur-xl sm:p-8">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.2em] text-white/80">
                  Carga #{carga.id}
                </span>
                <span className="inline-flex items-center rounded-full border border-emerald-300/25 bg-emerald-400/15 px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.2em] text-emerald-100">
                  {carga.status}
                </span>
              </div>

              <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-white sm:text-5xl">
                {carga.origemCidade}, {carga.origemEstado} para {carga.destinoCidade}, {carga.destinoEstado}
              </h1>

              <p className="mt-4 max-w-3xl text-base leading-7 text-white/72 sm:text-lg">
                Link individual da operação para enviar ao motorista e abrir somente os detalhes completos
                dessa carga e do cliente embarcador.
              </p>

              <div className="mt-8 grid gap-3 sm:grid-cols-4">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/60">Pagamento</p>
                  <p className="mt-2 text-2xl font-extrabold text-white">{carga.pagamento}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/60">Tempo estimado</p>
                  <p className="mt-2 text-2xl font-extrabold text-white">{tempoEstimado}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/60">Veículo</p>
                  <p className="mt-2 text-2xl font-extrabold text-white">{carga.tipoVeiculo}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/60">Distância</p>
                  <p className="mt-2 text-2xl font-extrabold text-white">{carga.distancia}</p>
                </div>
              </div>
            </section>

            <section className="rounded-[32px] border border-white/10 bg-black/10 p-6 backdrop-blur-xl sm:p-8">
              <p className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-white/60">
                Cliente vinculado
              </p>
              <h2 className="mt-4 text-2xl font-extrabold tracking-tight text-white">
                {carga.cliente.nome}
              </h2>
              <div className="mt-5 space-y-4 text-white/78">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">Contato</p>
                  <p className="mt-1 text-base font-semibold">{carga.cliente.contato}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">Telefone</p>
                  <p className="mt-1 text-base font-semibold">{carga.cliente.telefone}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">E-mail</p>
                  <p className="mt-1 text-base font-semibold break-all">{carga.cliente.email}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">Atendimento</p>
                  <p className="mt-1 text-base font-semibold">{carga.cliente.horarioAtendimento}</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <DetailCard icon={<CalendarClock className="h-5 w-5" />} eyebrow="Operação" title="Linha do tempo da carga">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                  Carregamento
                </p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">
                  {formatOperationalDate(carga.dataCarregamento)}
                </p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {carga.origemEndereco}
                </p>
                <p className="mt-2 text-sm font-medium text-card-foreground">
                  {carga.origemReferencia}
                </p>
              </div>

              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                  Descarga
                </p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">
                  {formatOperationalDate(carga.dataDescarga)}
                </p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {carga.destinoEndereco}
                </p>
                <p className="mt-2 text-sm font-medium text-card-foreground">
                  {carga.destinoReferencia}
                </p>
              </div>
            </div>
          </DetailCard>

          <DetailCard icon={<Package className="h-5 w-5" />} eyebrow="Carga" title="Informações completas">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Produto</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">{carga.produto}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Tipo de carga</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">{carga.tipoCarga}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Peso</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">{carga.peso}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Volume</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">{carga.volume}</p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-border/40 bg-muted/30 p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
                Prazo e janela operacional
              </p>
              <p className="mt-2 text-base font-semibold text-card-foreground">{carga.prazoAgendamento}</p>
            </div>
          </DetailCard>

          <DetailCard icon={<Building2 className="h-5 w-5" />} eyebrow="Cliente" title="Dados completos do embarcador">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Empresa</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">{carga.cliente.nome}</p>
                <p className="mt-2 text-sm text-muted-foreground">{carga.cliente.segmento}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">CNPJ</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">{carga.cliente.cnpj}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Contato responsável</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">{carga.cliente.contato}</p>
                <p className="mt-2 text-sm text-muted-foreground">{carga.cliente.telefone}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Endereço</p>
                <p className="mt-2 text-base font-semibold text-card-foreground">{carga.cliente.endereco}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {carga.cliente.cidade}, {carga.cliente.estado}
                </p>
              </div>
            </div>
          </DetailCard>
        </div>

        <div className="space-y-6">
          <DetailCard icon={<MapPin className="h-5 w-5" />} eyebrow="Rota" title="Endereços da operação">
            <div className="space-y-4">
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Origem</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">
                  {carga.origemCidade}, {carga.origemEstado}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{carga.origemEndereco}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Destino</p>
                <p className="mt-2 text-lg font-extrabold text-card-foreground">
                  {carga.destinoCidade}, {carga.destinoEstado}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{carga.destinoEndereco}</p>
              </div>
            </div>
          </DetailCard>

          <DetailCard icon={<ShieldCheck className="h-5 w-5" />} eyebrow="Requisitos" title="Documentos e exigências">
            <div className="space-y-4">
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-card-foreground">
                    Documentos
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {carga.documentos.map((documento) => (
                    <span
                      key={documento}
                      className="rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-semibold text-muted-foreground"
                    >
                      {documento}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-primary" />
                  <p className="text-sm font-extrabold uppercase tracking-[0.18em] text-card-foreground">
                    Exigências
                  </p>
                </div>
                <div className="space-y-2">
                  {carga.exigencias.map((exigencia) => (
                    <p key={exigencia} className="text-sm leading-6 text-muted-foreground">
                      • {exigencia}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </DetailCard>

          <DetailCard icon={<TimerReset className="h-5 w-5" />} eyebrow="Observações" title="Orientações para o motorista">
            <div className="space-y-3">
              {carga.observacoes.map((observacao) => (
                <div key={observacao} className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                  <p className="text-sm leading-6 text-muted-foreground">{observacao}</p>
                </div>
              ))}
            </div>
          </DetailCard>

          <DetailCard icon={<UserRound className="h-5 w-5" />} eyebrow="Contato rápido" title="Cliente e operação">
            <div className="space-y-4">
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-primary" />
                  <p className="text-sm font-extrabold text-card-foreground">{carga.cliente.telefone}</p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{carga.cliente.email}</p>
              </div>
              <div className="rounded-2xl border border-border/40 bg-muted/30 p-4">
                <div className="flex items-center gap-2">
                  <Truck className="h-4 w-4 text-primary" />
                  <p className="text-sm font-extrabold text-card-foreground">{carga.tipoVeiculo}</p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Última atualização da oferta: {carga.dateTime}
                </p>
              </div>
            </div>
          </DetailCard>
        </div>
      </div>
    </div>
  );
};

export default LoadDetails;
