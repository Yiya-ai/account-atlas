import React, {useEffect, useRef, useState} from 'react';
import {ArrowDownToLine, LockKeyhole} from 'lucide-react';
import {api, exportFile, saveFile} from './api';

export default function ExportDialog({state, selectedIds, filteredIds, initialScope, defaultPlatform, filterDescription, onClose, ui}) {
  const {Dialog, Field, ErrorLine, Button} = ui;
  const [scope, setScope] = useState(initialScope || (selectedIds.length ? 'selected' : filteredIds.length ? 'filtered' : 'platform'));
  const [platformId, setPlatform] = useState(defaultPlatform || state.platforms[0]?.id || '');
  const [includeArchived, setArchived] = useState(true), [includeTrash, setTrash] = useState(false);
  const [plan, setPlan] = useState(null), [picked, setPicked] = useState([]), [query, setQuery] = useState('');
  const [format, setFormat] = useState('xlsx'), [csvExact, setCsvExact] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const alive = useRef(true), controller = useRef(null);
  useEffect(() => () => {alive.current = false; controller.current?.abort();}, []);
  useEffect(() => {
    let active = true; setPlan(null); setPicked([]); setLoading(true); setError(''); setNotice('');
    api('/export/preview', 'POST', {scope, ids:scope === 'selected' ? selectedIds : filteredIds, platformId, includeArchived, includeTrash, revision:state.revision})
      .then(result => {if(active) {setPlan(result); setPicked(result.fields.filter(f => f.default && !f.secret).map(f => f.key));}})
      .catch(e => {if(active) setError(e.message);}).finally(() => {if(active) setLoading(false);});
    return () => {active = false;};
  }, [scope, platformId, includeArchived, includeTrash, state.revision, selectedIds, filteredIds]);
  function change(setter, value) {setPlan(null); setPicked([]); setter(value);}
  function toggle(key, checked) {setPicked(keys => checked ? [...keys,key] : keys.filter(k => k !== key)); setNotice('');}
  const sensitive = plan?.fields.filter(f => picked.includes(f.key) && f.secret).length || 0;
  const groups = ['基础与个人资料','敏感资料','自定义字段'];
  async function download() {
    setBusy(true); setError(''); setNotice(''); controller.current = new AbortController();
    try {
      const ordered = plan.fields.filter(f => picked.includes(f.key)).map(f => f.key);
      const result = await exportFile({token:plan.token, fields:ordered, format, csvExact}, controller.current.signal);
      if(alive.current) {saveFile(result.blob,result.blob.type,result.filename); setNotice(`已下载 ${plan.count} 个账号、${ordered.length} 个字段。`);}
    } catch(e) {if(alive.current && e.name !== 'AbortError') setError(e.message);}
    finally {if(alive.current) setBusy(false);}
  }
  return <Dialog title="批量导出账号" subtitle="确认账号范围，再选择要保存到文件的字段。" onClose={onClose} wide>
    <div className="form-body"><ErrorLine error={error}/>{notice && <p role="status" className="notice">{notice}</p>}
      <fieldset className="export-scopes" disabled={busy}><legend>导出范围</legend>
        <label><input type="radio" name="export-scope" checked={scope === 'selected'} disabled={!selectedIds.length} onChange={() => change(setScope,'selected')}/><span>已选账号<small>{selectedIds.length} 个已勾选账号</small></span></label>
        <label><input type="radio" name="export-scope" checked={scope === 'filtered'} disabled={!filteredIds.length} onChange={() => change(setScope,'filtered')}/><span>当前筛选结果<small>{filteredIds.length} 个账号，包含所有分页</small></span></label>
        <label><input type="radio" name="export-scope" checked={scope === 'platform'} onChange={() => change(setScope,'platform')}/><span>指定平台<small>独立选择平台和归档范围</small></span></label>
      </fieldset>
      {scope === 'filtered' && <p className="muted export-filter-description">{filterDescription}</p>}
      {scope === 'platform' && <div className="export-platform"><Field label="导出平台"><select disabled={busy} value={platformId} onChange={e => change(setPlatform,e.target.value)}>{state.platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><label className="check"><input type="checkbox" disabled={busy} checked={includeArchived} onChange={e => change(setArchived,e.target.checked)}/>包含归档账号</label><label className="check"><input type="checkbox" disabled={busy} checked={includeTrash} onChange={e => change(setTrash,e.target.checked)}/>包含回收站账号</label></div>}
      <div className="export-summary" role="status">{loading || !plan ? '正在核对导出范围…' : <>将导出 <strong>{plan.count}</strong> 个账号 · 已选 <strong>{picked.length}</strong> 个字段<small>其中归档 {plan.archived} 个，回收站 {plan.trashed} 个；未选字段不会写入文件。</small></>}</div>
      <div className="form-grid"><Field label="文件格式"><select disabled={busy} value={format} onChange={e => setFormat(e.target.value)}><option value="xlsx">Excel（.xlsx，文本单元格）</option><option value="csv">CSV（UTF-8，含表头）</option></select></Field><Field label="查找导出字段"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="例如：邮箱、生日、密钥"/></Field></div>
      {format === 'csv' && <div className="csv-export-mode"><label className="check"><input type="checkbox" disabled={busy} checked={csvExact} onChange={e => setCsvExact(e.target.checked)}/>CSV 保留原始文本（用于再次导入）</label><p className="muted">{csvExact ? '保留所有字符。请通过表格软件的“按文本导入”功能打开，避免公式执行或号码格式被转换。' : '默认在以 =、+、-、@ 等开头的值前加单引号，避免被表格软件当作公式。精确保留密码和号码可选 Excel，或勾选原始文本。'}</p></div>}
      <div className="export-field-actions"><Button disabled={!plan || busy} onClick={() => setPicked(plan.fields.filter(f => !f.secret).slice(0,128).map(f => f.key))}>选择普通字段</Button><Button disabled={busy} onClick={() => setPicked([])}>清空选择</Button><span>最多 128 列 · 敏感字段须逐项勾选</span></div>
      {groups.map(group => {const fields=(plan?.fields || []).filter(f => f.group === group && f.label.toLowerCase().includes(query.toLowerCase())); return fields.length ? <section key={group} className="export-field-group"><h3>{group}</h3><div className="export-fields">{fields.map(f => <label className={`check ${f.secret ? 'export-sensitive' : ''}`} key={f.key}><input type="checkbox" disabled={busy || (!picked.includes(f.key) && picked.length >= 128)} checked={picked.includes(f.key)} onChange={e => toggle(f.key,e.target.checked)}/><span>{f.label}{f.secret && <small><LockKeyhole size={11}/>敏感</small>}</span></label>)}</div></section> : null;})}
      {plan && !plan.fields.some(f => f.label.toLowerCase().includes(query.toLowerCase())) && <p className="muted">没有匹配的字段，请换个关键词。</p>}
      <p className="notice">导出的 CSV / Excel 文件未加密。{sensitive ? `当前已勾选 ${sensitive} 个敏感字段，其内容会明文写入文件，请妥善保管。` : '密码、2FA 密钥及敏感自定义字段默认不选，按需逐项勾选。'}自定义字段按平台分别列出，包含已保存但停用的字段。</p>
    </div><footer className="dialog-actions"><Button onClick={onClose}>关闭</Button><Button primary icon={ArrowDownToLine} disabled={busy || loading || !plan?.count || !picked.length} onClick={download}>{busy ? '正在生成…' : `导出 ${format === 'xlsx' ? 'Excel' : 'CSV'}`}</Button></footer>
  </Dialog>;
}
