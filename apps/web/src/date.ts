type DateValue = string | number | Date | null | undefined;

function validDate(value: DateValue): Date | null {
  const date = value instanceof Date ? value : new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatShortDate(value: DateValue): string {
  return validDate(value)?.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }) ?? "—";
}

export function formatDateTime(value: DateValue): string {
  return validDate(value)?.toLocaleString() ?? "—";
}
