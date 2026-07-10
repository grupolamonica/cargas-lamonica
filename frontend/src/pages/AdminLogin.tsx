import { useState } from "react";
import { ArrowRight, Eye, EyeOff, Loader2, Lock, LogIn, Mail } from "lucide-react";

import Logo from "@/components/Logo";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { getUserRole } from "@/lib/operatorAccess";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Algo deu errado. Tente novamente.";
}

// Operadores internos usam @grupolamonica.com.br. Permite logar só com o usuário
// (ex.: "evelin.silva") completando o domínio automaticamente. E-mail completo
// (de qualquer domínio) continua funcionando — só completa quando não há "@".
const DEFAULT_OPERATOR_EMAIL_DOMAIN = "grupolamonica.com.br";

function normalizeLoginIdentifier(raw: string) {
  const value = raw.trim().toLowerCase();
  if (!value || value.includes("@")) {
    return value;
  }
  return `${value}@${DEFAULT_OPERATOR_EMAIL_DOMAIN}`;
}

const AdminLogin = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);

    try {
      const loginEmail = normalizeLoginIdentifier(email);
      const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password });

      if (error) {
        throw error;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();
      const role = getUserRole(user);

      if (role !== "operator") {
        await supabase.auth.signOut();
        throw new Error("Esta conta não tem perfil de operador para acessar o painel.");
      }

      window.location.assign("/painel");
    } catch (error) {
      toast({
        title: "Erro",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-theme admin-page-shell relative min-h-[100dvh] overflow-x-hidden overflow-y-auto bg-background">
      <div className="relative mx-auto flex min-h-[100dvh] w-full max-w-[1180px] items-center justify-center px-4 py-4 sm:px-6 sm:py-6 lg:px-8 [@media(max-height:860px)]:items-start">
        <section className="flex w-full items-center justify-center py-2 sm:py-4">
          <div className="admin-auth-panel relative w-full max-w-[540px] p-4 sm:p-5 lg:p-6 [@media(max-height:900px)]:p-5 [@media(max-height:820px)]:rounded-[30px] [@media(max-height:820px)]:p-4">
            <div className="relative">
              <div className="admin-card-surface inline-flex rounded-[20px] border px-3.5 py-2.5 shadow-[0_16px_36px_-28px_rgba(2,36,131,0.26)] backdrop-blur-xl sm:px-4">
                <Logo />
              </div>

              <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/6 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.26em] text-primary/70 sm:mt-5">
                Painel do operador
              </div>

              <div className="mt-3.5 max-w-[430px] sm:mt-4">
                <h1 className="text-[clamp(2rem,5vw,3.2rem)] font-semibold leading-[0.93] tracking-tight text-foreground">
                  Entrar no cockpit operacional
                </h1>
                <p className="mt-2.5 text-sm leading-6 text-muted-foreground sm:text-[0.96rem]">
                  Use suas credenciais para abrir o shell de operadores da Lamonica com foco total na operacao.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="relative mt-5 space-y-3.5 sm:mt-6 sm:space-y-4">
              <div className="space-y-1.5">
                <label className="text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">Usuário ou e-mail</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="evelin.silva"
                    required
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="admin-input-surface w-full rounded-2xl border py-3 pl-11 pr-4 text-sm outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">Senha</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Digite sua senha"
                    required
                    minLength={6}
                    className="admin-input-surface w-full rounded-2xl border py-3 pl-11 pr-12 text-sm outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="admin-primary-button flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <LogIn className="h-4 w-4" />
                    Entrar no painel
                  </>
                )}
              </button>

              <div className="rounded-[22px] border border-primary/10 bg-primary/[0.04] px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <ArrowRight className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">Fluxo de acesso interno</p>
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                      Ao autenticar, voce entra direto no ambiente de operacao da Lamonica. Novos operadores sao provisionados apenas por fluxo interno controlado.
                    </p>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
};

export default AdminLogin;
