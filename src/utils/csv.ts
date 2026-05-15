// Serializador CSV mínimo conforme a RFC 4180.

export type CsvValue = string | number | boolean | null | undefined;

export function csvEscape(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  // CRLF: separador de registros recomendado por RFC 4180.
  return lines.join("\r\n");
}
