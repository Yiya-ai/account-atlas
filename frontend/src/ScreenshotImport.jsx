import React, {useEffect, useRef, useState} from 'react';
import {prepareScreenshot, recognizeScreenshot} from './localOcr';
import {extractOcrFields, applyOcrFields} from './ocrFields';

export default function ScreenshotImport({platform, form, onApply}) {
  const [open, setOpen] = useState(false), [image, setImage] = useState('');
  const [language, setLanguage] = useState('simplified'), [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const generation = useRef(0), job = useRef(null), picker = useRef(null);
  const clear = () => {generation.current++; job.current?.cancel(); job.current=null; setImage(''); setRows([]); setBusy(false); setMessage(''); setError(''); if (picker.current) picker.current.value='';};
  useEffect(() => () => {generation.current++; job.current?.cancel();}, []);
  useEffect(() => {clear();}, [platform?.id]);
  async function choose(file) {
    clear(); const current = generation.current; setBusy(true);
    try {const next = await prepareScreenshot(file); if (generation.current === current) {setImage(next); setMessage('截图已准备好，点击“开始识别”。');}}
    catch(e) {if (generation.current === current) setError(e.message);}
    finally {if (generation.current === current) setBusy(false);}
  }
  async function recognize() {
    const current = ++generation.current; setBusy(true); setError(''); setRows([]);
    job.current = recognizeScreenshot(image, language, text => {if (generation.current === current) setMessage(text);});
    try {
      const lines = await job.current.promise;
      if (generation.current !== current) return;
      const candidates = extractOcrFields(lines, platform);
      setRows(candidates.map(row => ({...row, selected:false})));
      setMessage(candidates.length ? '请核对识别值并勾选要填入的字段；已有内容不会自动覆盖。' : '未找到可匹配字段。请裁剪包含字段名称和内容的区域，或切换识别语言后重试。');
    } catch(e) {if (generation.current === current) {setError(e.message); setMessage('');}}
    finally {if (generation.current === current) {setBusy(false); job.current=null;}}
  }
  function apply() {
    const confirmed = rows.filter(row => row.selected);
    const valid = applyOcrFields({}, confirmed);
    const invalid = confirmed.find(row => !Object.hasOwn(valid, row.key));
    if (invalid) {setError(`${invalid.label}的识别值无效，请修正或取消勾选。`); return;}
    const next = applyOcrFields(form, confirmed);
    onApply(next, confirmed.map(row => row.key));
    clear(); setOpen(false);
  }
  const update = (index, patch) => setRows(current => current.map((row, i) => i === index ? {...row, ...patch} : row));
  return <section className="ocr-import" aria-label="截图识别录入">
    <button type="button" className="button" aria-expanded={open} onClick={() => {if (open) clear(); setOpen(!open);}}>截图识别填写</button>
    {open && <div className="ocr-panel" aria-busy={busy} onPaste={event => {
      const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'));
      if (file && !busy) {event.preventDefault(); choose(file);}
    }}>
      <p className="notice">截图仅在当前浏览器内识别，不上传服务器或第三方。识别结果需你勾选确认；填入后仍需保存账号。关闭窗口或锁定会清除截图及识别结果。</p>
      <div className="form-grid"><label className="field"><span>选择截图</span><input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => {const file=event.target.files?.[0]; if (file) choose(file);}}/><small>支持 PNG / JPEG / WebP，最大 10 MB、1600 万像素。</small></label>
      <label className="field"><span>截图文字语言</span><select disabled={busy} value={language} onChange={event => {setLanguage(event.target.value); setRows([]);}}><option value="simplified">简体中文 + English</option><option value="traditional">繁體中文 + English</option><option value="english">English</option></select></label></div>
      <div className="ocr-paste" tabIndex={0} role="group" aria-label="粘贴截图区域">也可点击此处，按 Ctrl+V 粘贴截图</div>
      {image && <img className="ocr-preview" src={image} alt="待识别截图预览"/>}
      <div className="security-actions"><button type="button" className="button primary" disabled={!image || busy} onClick={recognize}>开始识别</button><button type="button" className="button" onClick={clear}>{busy ? '取消识别并清除' : '清除截图'}</button></div>
      {busy && <progress aria-label="识别进行中"/>}{message && <p role="status" className="muted">{message}</p>}{error && <p role="alert" className="error">{error}</p>}
      {rows.length > 0 && <div className="ocr-results"><h4>确认要填入的字段</h4>{rows.map((row,index) => <div className="ocr-result" key={row.key}>
        <label className="check"><input type="checkbox" aria-label={`填入${row.label}`} checked={row.selected} onChange={event => update(index, {selected:event.target.checked})}/>填入{row.label}</label>
        <label className="field"><span>{row.label}识别值</span>{row.key === 'verification' ? <select aria-label={`${row.label}识别值`} value={row.value} onChange={event => update(index,{value:event.target.value})}><option value="twofactor">已开启双重认证</option><option value="disabled">未开启双重认证</option></select> : <textarea aria-label={`${row.label}识别值`} rows={1} maxLength={2000} value={row.value} onChange={event => update(index,{value:event.target.value})}/>}</label>
        <small>{form[row.key] && form[row.key] !== 'none' ? '此字段已有内容，勾选并确认将替换原值。' : '此字段当前为空。'} {row.confidence < 80 ? '识别把握较低，请仔细核对。' : '请核对截图原文。'}</small>
      </div>)}<p className="muted">不自动填入密码、密钥及恢复码。打码、模糊内容无法恢复；未匹配的字段请手动填写。</p><button type="button" className="button primary" disabled={!rows.some(row => row.selected && row.value.trim())} onClick={apply}>确认填入所选字段</button></div>}
    </div>}
  </section>;
}
