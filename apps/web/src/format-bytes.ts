export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  do { amount /= 1_024; unit += 1; } while (amount >= 1_024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
