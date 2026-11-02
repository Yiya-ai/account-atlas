import React, {useEffect, useState} from 'react';
import {ArrowDownToLine} from 'lucide-react';
import {api, saveFile} from './api';

export default function ImportDialog({state, defaultPlatform, onClose, onSaved, ui}) {
  const {Dialog, Field, FilePicker, ErrorLine, Button} = ui;
  const [raw, setRaw] = useState(''), [delimiter, setDelimiter] = useState(','), [header, setHeader] = useState(true);
  const [platformId, setPlatform] = useState(defaultPlatform || 'google');
  const [mapping, setMapping] = useState({}), [columns, setColumns] = useState([]), [warnings, setWarnings] = useState([]);
  const [group, setGroup] = useState(''), [tagText, setTags] = useState(''), [mode, setMode] = useState('skip');
  const [preview, setPreview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false), [parsed, setParsed] = useState(false), [notice, setNotice] = useState('');
  const platform = state.platforms.find(p => p.id === platformId);
  const fields = platform?.importFields || [];

  useEffect(() => {
    let alive = true;
    setParsed(false); setMapping({}); setColumns([]); setWarnings([]); setError('');
    if (!raw.trim()) {setAnalyzing(false); return;}
    setAnalyzing(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api('/import/analyze', 'POST', {platformId, text:raw, delimiter, header});
        if (alive) {setColumns(result.columns); setMapping(result.mapping); setWarnings(result.warnings); setParsed(true);}
      } catch(e) {if (alive) setError(e.message);}
      finally {if (alive) setAnalyzing(false);}
    }, 350);
    return () => {alive = false; clearTimeout(timer);};
  }, [raw, platformId, delimiter, header]);

  const payload = {text:raw, delimiter, header, platformId, mapping, group, tags:tagText.split(/[,，]/).map(s => s.trim()).filter(Boolean), mode, revision:state.revision};
  async function inspect() {
    setBusy(true); setError('');
    try {setPreview(await api('/import/preview', 'POST', payload));}
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  async function getTemplate() {
    setBusy(true); setError('');
    try {
      const data = await api('/import/template', 'POST', {platformId});
      saveFile(data.csv, 'text/csv;charset=utf-8', data.filename);
      setNotice(`${platform.name} 导入模板已下载，包含 ${data.fields.length} 列。填写后上传，表头会自动匹配。`);
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <Dialog title="批量导入账号" subtitle="按平台配置映射字段，先预览，再确认入库。" wide onClose={onClose}>
    <div className="form-body"><ErrorLine error={error}/>{preview ? <>
      <div className="import-counts">{[['新增',preview.added],['更新',preview.updated],['跳过',preview.skipped],['无效',preview.invalid]].map(([label,count]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div>
      <p className="notice">只提交有效行；敏感内容不在预览中展示。预览最多显示前 100 行，有效期 10 分钟。</p>
      <div className="table-scroll"><table><thead><tr><th>行号</th><th>账号标识</th><th>处理结果</th></tr></thead><tbody>{preview.rows.map(r => <tr key={r.line}><td>{r.line}</td><td>{r.identifier}</td><td>{r.result}</td></tr>)}</tbody></table></div>
    </> : <>
      <div className="form-grid"><Field label="导入到平台"><select value={platformId} onChange={e => {setPlatform(e.target.value); setNotice('');}}>{state.platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><Field label="分隔符"><select value={delimiter} onChange={e => setDelimiter(e.target.value)}><option value=",">CSV（逗号，支持引号）</option><option value={'\t'}>TSV（制表符）</option><option value="----">四条横线 ----</option><option value="——">中文破折号 ——</option><option value="|">竖线 |</option></select></Field></div>
      <div className="import-template"><div><strong>{platform?.name} 的导入模板</strong><p>包含 {fields.length} 个字段，与该平台启用的字段一致。</p></div><Button icon={ArrowDownToLine} disabled={busy} onClick={getTemplate}>下载平台模板</Button></div>
      {notice && <p role="status" className="notice">{notice}</p>}
      <FilePicker label="选择 CSV / TXT 文件，或直接粘贴下方" accept=".csv,.tsv,.txt" onChange={async e => {const file=e.target.files[0]; if(file) {if(file.size>3_000_000) {setRaw(''); setError('文件不能超过 3 MB。'); return;} setRaw(await file.text());}}}/>
      <textarea aria-label="待导入资料" rows={5} value={raw} onChange={e => setRaw(e.target.value)} placeholder={'账号标识,登录密码,姓名\nexample@example.com,your-password,姓名'} spellCheck={false}/>
      <label className="check"><input type="checkbox" checked={header} onChange={e => setHeader(e.target.checked)}/>第一行是表头，不导入</label>
      <details className="import-help"><summary>填写格式与注意事项</summary><p>模板只有表头，不包含示例账号或现有资料。用表格软件填写时，将账号、电话、密码等列设为“文本”，避免丢失前导零或改变日期。</p><p>日期使用 YYYY-MM-DD，也支持中文年月日和斜线日期。多个邮箱、电话、联系人或 App 可在单元格内换行；CSV 含逗号或换行时必须带引号。标签用逗号分隔。</p><p>状态：使用中 / 备用 / 待处理 / 停用。登录方式：账号密码 / 通过 Google 登录 / 通过 Apple 登录 / 通行密钥 / 其他。两步验证方式与账号表单一致。关联账号列填写已存在记录的 ID，可在详情中复制。</p><p>密码和敏感自定义字段保持原样。填写后的 CSV 是明文，请妥善保管。切换平台、修改原文或分隔符后会重新匹配表头；无表头时需手动选择列。</p></details>
      <h3>字段映射 {analyzing ? '· 正在识别…' : columns.length ? `· ${columns.length} 列` : ''}</h3>
      <p className="muted">自动识别已知表头，未匹配的字段保持“不导入”。可手动调整；停用字段请先在平台管理中启用。</p>
      {warnings.map((message,i) => <p className="notice" key={i}>{message}</p>)}
      <div className="mapping-grid">{fields.map(f => <Field key={f.key} label={f.label + (f.key === 'identifier' ? ' *' : '')} hint={f.secret ? '敏感字段 · 加密保存' : undefined}><select aria-label={`映射 ${f.label}`} disabled={analyzing || !parsed} value={mapping[f.key] ?? ''} onChange={e => {const next={...mapping}; if(e.target.value==='') delete next[f.key]; else next[f.key]=Number(e.target.value); setMapping(next);}}><option value="">不导入</option>{columns.map(col => <option key={col.index} value={col.index}>{col.label}</option>)}</select></Field>)}</div>
      <h3>整理与冲突处理</h3><div className="form-grid"><Field label="默认分组"><input value={group} onChange={e => setGroup(e.target.value)} placeholder="未映射分组时使用"/></Field><Field label="统一添加标签"><input value={tagText} onChange={e => setTags(e.target.value)} placeholder="逗号分隔"/></Field><Field label="同一平台下，账号已存在时" wide><select value={mode} onChange={e => setMode(e.target.value)}><option value="skip">跳过，不修改已有资料</option><option value="fill">只补全空字段，合并标签</option><option value="replace">覆盖已映射字段（含空值），合并标签</option></select></Field></div>
    </>}</div>
    <footer className="dialog-actions"><Button onClick={preview ? () => {setPreview(null); setError('');} : onClose}>{preview ? '返回修改' : '取消'}</Button>{preview ? <Button primary disabled={busy || !(preview.added+preview.updated)} onClick={async () => {setBusy(true); try {await api('/import/apply','POST',{token:preview.token}); onSaved(`导入完成：新增 ${preview.added}，更新 ${preview.updated}`);} catch(e) {setError(e.message);} finally {setBusy(false);}}}>{busy ? '导入中…' : '确认导入有效行'}</Button> : <Button primary disabled={busy || analyzing || !parsed || mapping.identifier === undefined} onClick={inspect}>{busy ? '解析中…' : '预览导入结果'}</Button>}</footer>
  </Dialog>;
}
