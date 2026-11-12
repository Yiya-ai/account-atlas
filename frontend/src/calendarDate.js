// Keep partial input intact; normalize only a complete, real calendar date.
export function normalizeDateInput(value) {
  const text = value.trim();
  if (!text) return '';
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
    || /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
    || /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
