function calendarDate(y, m, d) {
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// A four-digit year is fixed. Seven-digit input may have two valid readings.
export function dateCandidates(value) {
  const text = value.trim();
  const separated = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
    || /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(text);
  if (separated) return [calendarDate(...separated.slice(1))].filter(Boolean);
  if (!/^\d{6,8}$/.test(text)) return [];
  const year = text.slice(0, 4), rest = text.slice(4);
  const primary = rest.length === 3 ? calendarDate(year, rest.slice(0, 2), rest[2]) : null;
  const pairs = rest.length === 2 ? [[rest[0], rest[1]]]
    : rest.length === 4 ? [[rest.slice(0, 2), rest.slice(2)]]
    : [[rest.slice(0, 2), rest[2]], ...(!primary || Number(rest.slice(1)) >= 10 ? [[rest[0], rest.slice(1)]] : [])];
  return [...new Set(pairs.map(([month, day]) => calendarDate(year, month, day)).filter(Boolean))];
}

export function normalizeDateInput(value) {
  if (!value.trim()) return '';
  const candidates = dateCandidates(value);
  return candidates.length === 1 ? candidates[0] : null;
}

export function displayDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', '/') : value;
}
