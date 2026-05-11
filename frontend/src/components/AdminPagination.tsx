import { Button } from "@/components/ui/button";

interface AdminPaginationProps {
  page: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
  itemLabel: string;
  isFetching: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

const AdminPagination = ({
  page,
  totalPages,
  totalCount,
  pageSize,
  itemLabel,
  isFetching,
  onPrevious,
  onNext,
}: AdminPaginationProps) => {
  if (totalCount === 0) {
    return null;
  }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalCount);

  return (
    <div className="admin-card-surface mt-5 flex flex-col gap-3 rounded-[28px] border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-foreground">
          Exibindo {start} a {end} de {totalCount} {itemLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          Página {page} de {Math.max(totalPages, 1)}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          onClick={onPrevious}
          disabled={page <= 1 || isFetching}
        >
          Anterior
        </Button>
        <Button
          type="button"
          className="rounded-full"
          onClick={onNext}
          disabled={page >= totalPages || isFetching}
        >
          Próxima
        </Button>
      </div>
    </div>
  );
};

export default AdminPagination;
