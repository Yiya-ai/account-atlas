import React, {useId, useState} from 'react';
import {normalizeDateInput} from './calendarDate.js';

export default function DateInput({label, value, onChange, required = false}) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const invalid = normalizeDateInput(value) === null;
  const message = `${label}请输入有效的完整日期，例如 1994-06-01 或 19940601。`;
  return <>
    <input type="text" inputMode="numeric" required={required} placeholder="YYYY-MM-DD，例如 1994-06-01"
      value={value} aria-invalid={touched && invalid} aria-describedby={id}
      ref={el => {if (el) el.setCustomValidity(invalid ? message : '');}}
      onChange={e => onChange(e.target.value)}
      onInvalid={() => setTouched(true)}
      onBlur={() => {setTouched(true); const normalized = normalizeDateInput(value); if (normalized !== null) onChange(normalized);}}/>
    <small id={id} role={touched && invalid ? 'alert' : undefined}>
      {touched && invalid ? message : '可连续输入 8 位数字，如 19940601；也支持 1994/6/1。'}
    </small>
  </>;
}
