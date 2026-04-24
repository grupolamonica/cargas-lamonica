import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-[hsl(220_20%_97%)] px-6 text-center">
          <div className="rounded-3xl border border-[hsl(221_18%_89%)] bg-white px-8 py-8 shadow-[0_18px_40px_-26px_rgba(15,23,42,0.18)] max-w-sm w-full">
            <p className="text-2xl font-bold text-[hsl(215_25%_12%)]">Algo deu errado</p>
            <p className="mt-2 text-sm text-[hsl(215_20%_45%)]">
              Ocorreu um erro inesperado. Recarregue a página para continuar.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 rounded-xl bg-[hsl(224_94%_37%)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[hsl(224_94%_32%)] transition-colors"
            >
              Recarregar página
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
