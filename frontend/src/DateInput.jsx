import React, {useId, useRef, useState} from 'react';
import {CalendarDays} from 'lucide-react';
import {dateCandidates, displayDate, normalizeDateInput} from './calendarDate.js';

export default function DateInput({label, value, onChange, required = false}) {
  const id = useId(), picker = useRef(null);
  const [touched, setTouched] = useState(false);
  const normalized = normalizeDateInput(value), candidates = dateCandidates(value);
  const invalid = normalized === null, ambiguous = candidates.length > 1;
  const message = ambiguous ? `${label}有两种可能，请选择日期。` : `${label}请输入有效日期，年份须为 4 位，例如 1921/01/01。`;
  const choose = date => {setTouched(false); onChange(date);};
  return <>
    <span className="date-control"><input type="text" inputMode="numeric" aria-label={label} required={required} placeholder="yyyy/mm/dd" maxLength={11}
      value={displayDate(value)} aria-invalid={touched && invalid} aria-describedby={id}
      ref={el => {if (el) el.setCustomValidity(invalid ? message : '');}}
      onChange={e => {const next=e.target.value; if (/^\d{9,}$/.test(next) || /^\d{5,}[-/年]/.test(next)) return; onChange(next);}}
      onInvalid={() => setTouched(true)}
      onBlur={() => {setTouched(true); if (normalized !== null) onChange(normalized);}}/>
      <input ref={picker} className="date-calendar-native" type="date" aria-label={`日历选择${label}`} tabIndex={-1} min="0001-01-01" max="9999-12-31" value={normalized || ''}
        onChange={e => {const date=normalizeDateInput(e.target.value); if (date !== null) choose(date);}}/>
      <button type="button" className="date-calendar-button" aria-label={`打开${label}日历`} onClick={() => {if (picker.current.showPicker) picker.current.showPicker(); else {picker.current.focus(); picker.current.click();}}}><CalendarDays size={16}/></button>
    </span>
    {touched && ambiguous && <span className="date-choices" role="group" aria-label={`选择${label}的正确日期`}>{candidates.map(date => <button type="button" className="button" key={date} onClick={() => choose(date)}>{displayDate(date)}</button>)}</span>}
    <small id={id} role={touched && invalid ? 'alert' : undefined}>
      {touched && invalid ? message : '可用日历选择，或连续输入 6～8 位数字；显示为 yyyy/mm/dd。'}
    </small>
  </>;
}
