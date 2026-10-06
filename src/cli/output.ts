export interface OutputOptions {
  json: boolean;
}

export function printValue(value: unknown, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(value ?? null)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
    return;
  }
  if (Array.isArray(value)) {
    printTable(value);
    return;
  }
  if (value && typeof value === 'object') {
    printRecord(value as Record<string, unknown>);
    return;
  }
  process.stdout.write(`${String(value ?? '')}\n`);
}

function printRecord(record: Record<string, unknown>): void {
  const rows = Object.entries(record).map(([field, value]) => ({ field, value: display(value) }));
  printTable(rows);
}

function printTable(values: unknown[]): void {
  if (values.length === 0) {
    process.stdout.write('No results.\n');
    return;
  }
  const records = values.map(value => normalizeRecord(value));
  const columns = [...new Set(records.flatMap(record => Object.keys(record)))];
  const widths = columns.map(column => Math.max(column.length, ...records.map(record => display(record[column]).length)));
  process.stdout.write(`${columns.map((column, i) => column.padEnd(widths[i])).join('  ')}\n`);
  process.stdout.write(`${widths.map(width => '-'.repeat(width)).join('  ')}\n`);
  for (const record of records) {
    process.stdout.write(`${columns.map((column, i) => display(record[column]).padEnd(widths[i])).join('  ')}\n`);
  }
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function display(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/[\r\n]+/g, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
