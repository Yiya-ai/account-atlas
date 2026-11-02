import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Archive, ArrowDownToLine, ArrowUpFromLine, BookKey, Check, ChevronLeft, ChevronRight, Copy, DatabaseBackup, Eye, Folder, Globe, KeyRound, Layers, LockKeyhole, Plus, Search, Settings2, ShieldCheck, Star, Tag, Trash2, X} from 'lucide-react';
import {api, download, readBackup, invalidateRequests} from './api';
import './style.css';
import ImportDialog from './ImportDialog';
import ExportDialog from './ExportDialog';
import SecurityDialog from './SecurityDialog';
import {passkeyCeremony} from './passkeys';

const STATES = {active: '使用中', reserve: '备用', attention: '待处理', disabled: '停用'};
const SECRET_LABELS = {password: '登录密码', totp: '身份验证器（TOTP 密钥）', recoveryCodes: '恢复码 / 备用码', appPassword: '应用专用密码', recoveryKey: '恢复密钥', legacyAccessKey:'遗产联系人访问密钥'};
const PERSONAL_LABELS = {fullName:'姓名', gender:'性别', birthday:'生日', language:'语言', country:'国家或地区', homeAddress:'住址', workAddress:'工作地址'};
const APPLE_SECURITY_LABELS = {loginPhones:'登录电话号码', passwordUpdatedAt:'密码上次更新日期', recoveryStatus:'账户恢复状态', recoveryContacts:'账户恢复联系人', legacyContacts:'遗产联系人', appleSignInApps:'通过 Apple 登录的 App / 网站'};
const parseTags = value => value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
const date = value => value ? new Date(value).toLocaleString('zh-CN', {hour12: false}) : '—';
const blank = (platformId = 'google') => ({platformId, title: '', identifier: '', email: '', phone: '', region: '', group: '', tags: [], notes: '', recoveryEmail: '', trustedDevices: '', status: 'active', favorite: false, archived: false, loginMethod: 'password', linkedAccount: '', verification: 'none', secrets: {}, customFields: []});

function Button({children, icon: Icon, primary, danger, className = '', ...props}) {
  return <button className={`button ${primary ? 'primary' : ''} ${danger ? 'danger' : ''} ${className}`} {...props}>{Icon && <Icon size={17}/>}<span>{children}</span></button>;
}
function Field({label, children, hint, wide = false}) { return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function FilePicker({label, accept, required, onChange}) {
  const [name, setName] = useState('');
  return <Field label={label}><span className="file-picker"><ArrowUpFromLine size={19}/><span className="file-picker-action">选择文件</span><span className="file-picker-name">{name || '尚未选择文件'}</span><input aria-label={label} type="file" accept={accept} required={required} onChange={e => {setName(e.target.files[0]?.name || ''); onChange(e);}}/></span></Field>;
}
function ErrorLine({error}) { return error ? <div role="alert" className="error">{error}</div> : null; }
function Dialog({title, subtitle, onClose, children, wide = false, drawer = false}) {
  const ref = useRef(null);
  useEffect(() => {const el = ref.current; el.showModal(); return () => el.close();}, []);
  return <dialog ref={ref} className={`${wide ? 'dialog-wide' : ''} ${drawer ? 'drawer' : ''}`} onCancel={e => {e.preventDefault(); onClose();}} aria-label={title}>
    <header className="dialog-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭窗口" onClick={onClose}><X size={21}/></button></header>{children}
  </dialog>;
}

function Gate({initialized, onUnlock}) {
  const [challenge, setChallenge] = useState(false), [code, setCode] = useState('');
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [password, setPassword] = useState(''), [repeat, setRepeat] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [restore, setRestore] = useState(false), [file, setFile] = useState(null), [backupPassword, setBackupPassword] = useState('');
  async function submit(e) {
    e.preventDefault(); setError('');
    if (!initialized && password !== repeat) return setError('两次输入的主密码不一致。');
    setBusy(true);
    try {
      if(challenge) {
        await api('/unlock/verify', 'POST', {code}); setCode(''); setChallenge(false); onUnlock(); return;
      }
      const body = {password};
      if (restore) { body.backup = await readBackup(file); body.backupPassword = backupPassword; }
      const result = await api(initialized ? '/unlock' : '/setup', 'POST', body); setPassword(''); setRepeat(''); setBackupPassword('');
      if(result.mfaRequired) {setChallenge(true); setPasskeyAvailable(result.passkeyAvailable); setCode('');} else onUnlock();
    } catch (e) {setError(e.message);} finally {setBusy(false);}
  }
  async function usePasskey() {
    setBusy(true); setError('');
    try {await passkeyCeremony('/unlock/passkey/options','/unlock/passkey/verify'); setCode(''); setChallenge(false); await onUnlock();}
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <main className="gate"><section className="gate-story"><div className="brand"><BookKey size={28}/><span>账号簿<small>Account Atlas</small></span></div>
    <div className="gate-copy"><span className="pill-light">只在你的电脑上</span><h1>每一个账号，<br/>都有自己的位置。</h1><p>从常用邮箱到备用账号，<br/>把资料收好，需要时就能找到。</p></div>
    <div className="gate-index"><div><span>G</span><p>Google<small>工作与日常</small></p><LockKeyhole size={16}/></div><div><span>A</span><p>Apple<small>设备与服务</small></p><LockKeyhole size={16}/></div><div><Globe size={22}/><p>你的其他平台<small>自由分类，统一收纳</small></p><LockKeyhole size={16}/></div></div>
    <p className="gate-foot"><ShieldCheck size={16}/> 本地保存 · 加密资料库</p>
  </section><section className="gate-form"><form onSubmit={submit}><div className="lock-emblem"><KeyRound size={27}/></div><h2>{challenge ? '完成二次验证' : initialized ? '解锁你的账号簿' : restore ? '从备份开始' : '创建你的账号簿'}</h2><p className="muted">{challenge ? '使用已绑定的验证方式完成解锁。' : initialized ? '输入主密码，继续整理你的账号资料。' : '主密码用于加密整个资料库，请妥善保管。'}</p>
    {!initialized && <div className="segmented"><button type="button" className={!restore ? 'chosen' : ''} onClick={() => setRestore(false)}>全新资料库</button><button type="button" className={restore ? 'chosen' : ''} onClick={() => setRestore(true)}>恢复备份</button></div>}
    {restore && <><FilePicker label="加密备份文件" accept=".atlas,.json" required onChange={e => setFile(e.target.files[0])}/><Field label="备份密码"><input type="password" required value={backupPassword} onChange={e => setBackupPassword(e.target.value)}/></Field></>}
    {challenge ? <><p className="notice">主密码已验证。请在 5 分钟内完成二次验证，也可使用一个未用过的恢复码。</p>{passkeyAvailable && <Button type="button" className="full" disabled={busy} icon={KeyRound} onClick={usePasskey}>使用通行密钥解锁</Button>}<Field label="验证码或恢复码"><input autoFocus required autoComplete="one-time-code" maxLength={80} value={code} onChange={e => setCode(e.target.value)}/></Field><button type="button" className="text-button" disabled={busy} onClick={async () => {try {await api('/unlock/cancel','POST',{});} catch {} setChallenge(false); setCode(''); setError('');}}>返回主密码验证</button></> : <Field label={initialized ? '主密码' : '设置主密码'} hint={!initialized ? '至少 12 个字符，建议使用较长的词组。' : undefined}><input autoFocus type="password" autoComplete={initialized ? 'current-password' : 'new-password'} required minLength={initialized ? 1 : 12} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)}/></Field>}
    {!initialized && <><Field label="再次输入主密码"><input type="password" autoComplete="new-password" minLength={12} required value={repeat} onChange={e => setRepeat(e.target.value)}/></Field><p className="notice">主密码没有找回入口。忘记后，只能使用仍记得密码的加密备份恢复。</p></>}
    <ErrorLine error={error}/><Button primary disabled={busy} icon={LockKeyhole} className="full">{busy ? '正在处理…' : challenge ? '验证并解锁' : initialized ? '解锁资料库' : '创建并进入'}</Button><p className="gate-note">资料不会上传。闲置 15 分钟后自动锁定。</p>
  </form></section></main>;
}

function AccountEditor({initial, state, defaultPlatform, onClose, onSaved}) {
  const defaults = id => (state.platforms.find(p => p.id === id)?.fieldTemplates || []).filter(f => f.enabled).map(f => ({name:f.name, value:'', secret:f.secret}));
  const [form, setForm] = useState(() => initial || {...blank(defaultPlatform), customFields: defaults(defaultPlatform)});
  const [tagText, setTagText] = useState(initial?.tags.join(', ') || '');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(Boolean(initial)), [show, setShow] = useState(false);
  const revision = useRef(state.revision);
  useEffect(() => {
    if (!initial) return;
    let alive = true;
    Promise.all([api(`/accounts/${initial.id}`), api(`/accounts/${initial.id}/reveal`, 'POST', {})]).then(([a, s]) => {if (alive) setForm({...a, ...s});}).catch(e => {if (alive) setError(e.message);}).finally(() => {if (alive) setLoading(false);});
    return () => {alive = false;};
  }, [initial]);
  const patch = (key, value) => setForm(f => ({...f, [key]: value}));
  const currentPlatform = state.platforms.find(p => p.id === form.platformId);
  const template = currentPlatform?.template;
  const [allFields, setAllFields] = useState(false);
  const enabled = key => allFields || currentPlatform?.fields?.includes(key) || Boolean(key in SECRET_LABELS ? form.secrets?.[key] : !['none', 'password'].includes(form[key]) && form[key]);
  function changePlatform(id) {
    setForm(f => ({...f, platformId:id, customFields:[...(f.customFields || []), ...defaults(id).filter(t => !(f.customFields || []).some(x => x.name.toLowerCase() === t.name.toLowerCase()))]}));
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {await api(initial ? `/accounts/${initial.id}` : '/accounts', initial ? 'PUT' : 'POST', {...form, tags: parseTags(tagText), revision: revision.current}); onSaved('账号资料已保存');}
    catch (e) {setError(e.message);} finally {setBusy(false);}
  }
  function input(key, label, type = 'text', required = false, hint) {
    if (!['title', 'identifier'].includes(key) && !enabled(key)) return null;
    if (type === 'textarea') return <Field label={label} hint={hint} wide><textarea rows={2} value={form[key] || ''} onChange={e => patch(key,e.target.value)}/></Field>;
    return <Field label={label} hint={hint}><input type={type} required={required} value={form[key] || ''} onChange={e => patch(key, e.target.value)}/></Field>;
  }
  return <Dialog title={initial ? '编辑账号' : '添加账号'} subtitle="资料按平台分别保存，相同邮箱也能拥有独立记录。" onClose={onClose} drawer>
    <form onSubmit={save} className="dialog-form"><div className="form-body"><ErrorLine error={error}/>{loading ? <p>正在读取资料…</p> : <>
      <div className="section-tools"><h3>基本资料</h3><button type="button" className="text-button" onClick={() => setAllFields(!allFields)}>{allFields ? '使用平台默认字段' : '显示所有可选字段'}</button></div><p className="muted">按平台模板显示；已有内容始终保留。可在“平台与字段管理”调整默认字段。</p><div className="form-grid"><Field label="所属平台"><select value={form.platformId} onChange={e => changePlatform(e.target.value)}>{state.platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>{input('title', '显示名称', 'text', false, '例如：工作主账号、日区备用')}{input('identifier', '账号标识 *', 'text', true, '邮箱、手机号或用户名')}{input('email', '联系邮箱', 'textarea', false, '多个邮箱可换行填写')}{input('phone', template === 'apple' ? '受信任电话号码' : '绑定手机号', 'textarea', false, '多个号码可换行填写')}{input('region', template === 'apple' ? '商店地区' : '地区')}
      <Field label="分组"><input list="groups" value={form.group} onChange={e => patch('group', e.target.value)}/><datalist id="groups">{state.groups.map(g => <option key={g} value={g}/>)}</datalist></Field><Field label="状态（手动记录）"><select value={form.status} onChange={e => patch('status', e.target.value)}>{Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="标签" hint="用逗号分隔，例如：工作, 主账号" wide><input value={tagText} onChange={e => setTagText(e.target.value)}/></Field></div>
      {Object.keys(PERSONAL_LABELS).some(enabled) && <><h3>个人信息</h3><div className="form-grid">{Object.entries(PERSONAL_LABELS).map(([key,label]) => <React.Fragment key={key}>{input(key,label,key === 'birthday' ? 'date' : ['language','homeAddress','workAddress'].includes(key) ? 'textarea' : 'text',false,key === 'country' && template === 'apple' ? '账户个人信息中的国家或地区，与商店地区分别记录' : undefined)}</React.Fragment>)}</div></>}
      <h3>登录与恢复资料</h3><div className="form-grid">{enabled('loginMethod') && <Field label="登录方式"><select value={form.loginMethod || 'password'} onChange={e => patch('loginMethod', e.target.value)}><option value="password">账号密码</option><option value="google">通过 Google 登录</option><option value="apple">通过 Apple 登录</option><option value="passkey">通行密钥</option><option value="other">其他</option></select></Field>}{enabled('linkedAccount') && <Field label="关联已有账号"><select value={form.linkedAccount || ''} onChange={e => patch('linkedAccount', e.target.value)}><option value="">不关联</option>{state.accounts.filter(a => a.id !== form.id && !a.deletedAt).map(a => <option key={a.id} value={a.id}>{a.title} / {a.identifier}</option>)}</select></Field>}
      {input('recoveryEmail', '恢复邮箱')}{enabled('verification') && <Field label="两步验证方式"><select value={form.verification || 'none'} onChange={e => patch('verification', e.target.value)}><option value="none">未记录</option><option value="totp">身份验证器 TOTP</option><option value="device">受信任设备</option><option value="sms">短信 / 电话</option><option value="passkey">安全密钥 / 通行密钥</option><option value="multiple">多种方式</option><option value="twofactor">已开启双重认证</option><option value="disabled">未开启双重认证</option></select></Field>}
      {input('trustedDevices', '受信任设备备注', 'textarea', false, '每行记录一台设备')}{input('personalProfile', '个人资料补充', 'textarea', false, '保留已有个人资料；姓名、生日等可在独立字段填写')}{input('twoStepPhone', '两步验证手机号')}{input('passkeys', '通行密钥备注', 'text', false, '记录已启用的设备或保管位置，不保存通行密钥私钥')}{input('googlePrompt', 'Google 提示', 'text', false, '例如：已启用，接收提示的手机或平板')}{Object.entries(APPLE_SECURITY_LABELS).map(([key,label]) => <React.Fragment key={key}>{input(key,label,key === 'passwordUpdatedAt' ? 'date' : 'textarea',false,key === 'recoveryStatus' ? '例如：未设置 / 已设置恢复联系人或恢复密钥' : key === 'passwordUpdatedAt' ? '手动记录平台上显示的日期' : '多项可换行填写')}</React.Fragment>)}
      </div><div className="section-tools"><p className="muted">敏感字段可留空，填写的内容会加密保存。</p><button type="button" className="text-button" onClick={() => setShow(!show)}><Eye size={15}/>{show ? '隐藏内容' : '显示内容'}</button></div>
      <div className="form-grid">{Object.entries(SECRET_LABELS).filter(([key]) => enabled(key)).map(([key, label]) => <Field key={key} label={label} hint={key === 'totp' ? (template === 'apple' ? 'Apple 设备验证码不属于 TOTP，此项通常留空。' : '填写 Base32 密钥，保存后详情页自动显示验证码。') : undefined}><input type={show ? 'text' : 'password'} autoComplete="new-password" value={form.secrets?.[key] || ''} onChange={e => patch('secrets', {...form.secrets, [key]: e.target.value})}/></Field>)}</div>
      <div className="section-tools"><h3>自定义字段</h3><button type="button" className="text-button" onClick={() => patch('customFields', [...form.customFields, {name: '', value: '', secret: false}])}><Plus size={16}/> 添加字段</button></div>
      {form.customFields.map((f, i) => <div className="custom-row" key={i}><input aria-label={`字段名称 ${i + 1}`} placeholder="字段名称" required value={f.name} onChange={e => patch('customFields', form.customFields.map((x, j) => i === j ? {...x, name: e.target.value} : x))}/><input aria-label={`字段内容 ${i + 1}`} placeholder="字段内容" type={f.secret && !show ? 'password' : 'text'} value={f.value} onChange={e => patch('customFields', form.customFields.map((x, j) => i === j ? {...x, value: e.target.value} : x))}/><label className="check"><input type="checkbox" checked={f.secret} onChange={e => patch('customFields', form.customFields.map((x, j) => i === j ? {...x, secret: e.target.checked} : x))}/>敏感</label><button type="button" className="icon-button" aria-label={`移除字段 ${i + 1}`} onClick={() => patch('customFields', form.customFields.filter((_, j) => i !== j))}><X size={16}/></button></div>)}
      {enabled('notes') && <Field label="备注" wide><textarea rows={4} value={form.notes} onChange={e => patch('notes', e.target.value)} placeholder="用途、注意事项或你想记住的信息"/></Field>}
    </>}</div><footer className="dialog-actions"><Button type="button" onClick={onClose}>取消</Button><Button primary disabled={busy || loading || (Boolean(initial) && !form.secrets)}>{busy ? '保存中…' : '保存账号'}</Button></footer></form>
  </Dialog>;
}

function LiveTotp({id, copy}) {
  const [value, setValue] = useState(null), [remaining, setRemaining] = useState(0), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, pending = false, next = 0, deadline = 0;
    async function tick() {
      const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      if (alive) setRemaining(seconds);
      if (!seconds && alive) setValue(null);
      if (document.hidden || pending || performance.now() < next) return;
      pending = true;
      try {
        const started = performance.now();
        const result = await api(`/accounts/${id}/totp`, 'POST', {});
        if (!alive) return;
        deadline = started + (result.expiresAt - result.serverTime) * 1000;
        next = deadline;
        setValue(result.code); setRemaining(Math.max(0, Math.ceil((deadline - performance.now()) / 1000))); setError('');
      } catch(e) {if (alive) {setValue(null); setError(e.message);} next = performance.now() + 5000;}
      finally {pending = false;}
    }
    const visible = () => {if (!document.hidden) {next = 0; tick();}};
    tick(); const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', visible);
    return () => {alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', visible);};
  }, [id]);
  return <section className="live-totp" aria-label="实时两步验证码"><div><strong>身份验证器验证码</strong><small>{error || (value && remaining > 0 ? `${remaining} 秒后更新 · 点击复制` : '正在更新…')}</small></div><button className="code" aria-label="复制实时验证码" disabled={!value || remaining <= 0} onClick={() => copy(value)}>{value && remaining > 0 ? value : '— — —'}</button><progress aria-label="验证码剩余有效时间" max={30} value={remaining}/></section>;
}

function Detail({entry, state, onClose, onEdit, onBatch, notify}) {
  const [data, setData] = useState(null), [secret, setSecret] = useState(null), [error, setError] = useState('');
  useEffect(() => {let alive = true; api(`/accounts/${entry.id}`).then(d => {if (alive) setData(d);}).catch(e => {if (alive) setError(e.message);}); return () => {alive = false;};}, [entry.id]);
  async function reveal() {try {setSecret(await api(`/accounts/${entry.id}/reveal`, 'POST', {}));} catch(e) {setError(e.message);}}
  async function copy(value) {try {await navigator.clipboard.writeText(value); notify('已复制，请在使用后清理剪贴板');} catch {setError('无法写入剪贴板，请显示内容后手动复制。');}}
  const p = state.platforms.find(p => p.id === entry.platformId);
  return <Dialog title={entry.title} subtitle={p?.name} onClose={onClose} drawer><div className="form-body"><ErrorLine error={error}/>{!data ? <p>正在读取…</p> : <>
    <div className="detail-identity"><PlatformMark platform={p}/><div><h3>{entry.identifier}</h3><span className={`status ${entry.status}`}>{STATES[entry.status]}</span></div><button aria-label="复制账号标识" className="icon-button" onClick={() => copy(entry.identifier)}><Copy size={18}/></button></div>
    {entry.hasTotp && <LiveTotp id={entry.id} copy={copy}/>}
    <dl className="detail-grid">{[['记录 ID', data.id], ['显示名称', data.title], ...Object.entries({...PERSONAL_LABELS,...APPLE_SECURITY_LABELS}).map(([key,label]) => [label,data[key]]), ['分组', data.group], ['标签', data.tags.join('、')], ['联系邮箱', data.email], ['手机号', data.phone], ['地区', data.region], ['恢复邮箱', data.recoveryEmail], ['受信任设备', data.trustedDevices], ['个人资料', data.personalProfile], ['两步验证手机号', data.twoStepPhone], ['通行密钥备注', data.passkeys], ['Google 提示', data.googlePrompt], ['两步验证方式', {totp:'身份验证器 TOTP',device:'受信任设备',sms:'短信 / 电话',passkey:'安全密钥 / 通行密钥',multiple:'多种方式',twofactor:'已开启双重认证',disabled:'未开启双重认证'}[data.verification]], ['登录方式', {password: '账号密码', google: '通过 Google', apple: '通过 Apple', passkey: '通行密钥', other: '其他'}[data.loginMethod]], ['关联账号', state.accounts.find(a => a.id === data.linkedAccount)?.identifier], ['创建时间', date(data.createdAt)], ['更新时间', date(data.updatedAt)]].filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}<button className="icon-button" aria-label={`复制${k}`} onClick={() => copy(v)}><Copy size={14}/></button></dt><dd>{v}</dd></div>)}</dl>
    <div className="section-tools"><h3>敏感资料</h3><Button icon={Eye} onClick={secret ? () => setSecret(null) : reveal}>{secret ? '收起敏感资料' : '查看敏感资料'}</Button></div>
    {secret ? <div className="secret-list">{Object.entries(SECRET_LABELS).filter(([k]) => secret.secrets[k]).map(([k, label]) => <div key={k}><small>{label}</small><code>{secret.secrets[k]}</code><button aria-label={`复制${label}`} className="icon-button" onClick={() => copy(secret.secrets[k])}><Copy size={16}/></button></div>)}{Object.values(secret.secrets).every(v => !v) && <p className="muted">尚未填写敏感资料。</p>}</div> : <p className="protected-note"><LockKeyhole size={16}/> 内容已隐藏，点击后查看或复制。</p>}
    {(secret?.customFields || data.customFields).length > 0 && <><h3>自定义资料</h3><dl className="detail-grid">{(secret?.customFields || data.customFields).map((f, i) => <div key={i}><dt>{f.name}{(!f.secret || secret) && f.value && <button className="icon-button" aria-label={`复制${f.name}`} onClick={() => copy(f.value)}><Copy size={14}/></button>}</dt><dd>{f.secret && !secret ? '••••••' : f.value || '—'}</dd></div>)}</dl></>}
    {data.notes && <><div className="section-tools"><h3>备注</h3><Button icon={Copy} onClick={() => copy(data.notes)}>复制备注</Button></div><p className="note-content">{data.notes}</p></>}
    <h3>修改记录</h3><p className="muted">记录操作与时间，不保留历史密码明文。</p><ol className="timeline">{data.history.map((h, i) => <li key={i}><span>{h.action}</span><time>{date(h.at)}</time></li>)}</ol>
  </>}</div><footer className="dialog-actions">{entry.deletedAt ? <Button primary onClick={() => onBatch([entry.id], 'restore')}>恢复账号</Button> : <><Button danger icon={Trash2} onClick={() => onBatch([entry.id], 'trash')}>移入回收站</Button><Button primary onClick={() => onEdit(entry)}>编辑资料</Button></>}</footer></Dialog>;
}

function PlatformMark({platform}) {return <span className={`platform-mark ${platform?.template || 'custom'}`}>{platform?.template === 'custom' ? <Globe size={19}/> : platform?.name?.slice(0, 1) || '?'}</span>;}

function PlatformManager({state, initialId, onClose, onSaved}) {
  const [id, setId] = useState(initialId || state.platforms[0].id);
  const original = state.platforms.find(p => p.id === id);
  const [form, setForm] = useState(() => structuredClone(original));
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState('');
  const patch = (key, value) => setForm(f => ({...f, [key]:value}));
  const change = next => {setId(next); setForm(structuredClone(state.platforms.find(p => p.id === next))); setConfirm(''); setError('');};
  const suggestions = form.template === 'apple' ? ['姓名', '生日', 'iCloud 邮箱', '安全问题 1', '安全答案 1', '安全问题 2', '安全答案 2', '安全问题 3', '安全答案 3'] : ['姓名', '生日', '恢复手机号', '账号注册年份', '语言', '备用登录邮箱'];
  function addField(name = '') {patch('fieldTemplates', [...form.fieldTemplates, {name, secret:name.startsWith('安全答案'), enabled:true}]);}
  function updateField(index, patchValue) {patch('fieldTemplates', form.fieldTemplates.map((f,i) => i === index ? {...f,...patchValue} : f));}
  function move(index, direction) {const rows = [...form.fieldTemplates]; [rows[index],rows[index+direction]] = [rows[index+direction],rows[index]]; patch('fieldTemplates',rows);}
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {await api(`/platforms/${id}`, 'PUT', {...form, revision:state.revision}); onSaved('平台与默认字段已保存');}
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  async function remove() {
    setBusy(true); setError('');
    try {await api(`/platforms/${id}`, 'DELETE', {revision:state.revision,confirm}); onSaved('平台已删除');}
    catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <Dialog title="平台与字段管理" subtitle="设置平台资料，以及每次添加账号时显示的字段。" onClose={onClose} wide><form onSubmit={save}><div className="form-body"><Field label="选择要管理的平台"><select value={id} onChange={e => change(e.target.value)}>{state.platforms.map(p => <option key={p.id} value={p.id}>{p.name} · {p.accountCount} 个账号</option>)}</select></Field><ErrorLine error={error}/><div className="form-grid"><Field label="平台名称"><input required maxLength={60} value={form.name} onChange={e => patch('name',e.target.value)}/></Field><Field label="登录网址"><input type="url" value={form.url} onChange={e => patch('url',e.target.value)}/></Field></div>
    <h3>默认录入字段</h3><p className="muted">账号标识、显示名称、分组、标签、状态始终显示。取消勾选只收起空字段，已有内容不会删除。</p><div className="field-options">{Object.entries(state.fieldCatalog || {}).map(([key,label]) => <label className="check" key={key}><input type="checkbox" checked={form.fields.includes(key)} onChange={e => patch('fields',e.target.checked ? [...form.fields,key] : form.fields.filter(k => k !== key))}/>{label}</label>)}</div>
    <div className="section-tools"><h3>自定义默认字段</h3><Button type="button" icon={Plus} disabled={form.fieldTemplates.length >= 30} onClick={() => addField()}>新增字段</Button></div><p className="muted">勾选“默认添加”的字段会随新账号自动创建；敏感标记也会保护已有同名字段。更名、停用或移除模板不改写已有值，也不会取消已有敏感标记。</p>
    <div className="suggested-fields"><span>按需添加：</span>{suggestions.filter(name => !form.fieldTemplates.some(f => f.name === name) && !form.fields.some(key => state.fieldCatalog[key] === name)).map(name => <button type="button" key={name} disabled={form.fieldTemplates.length >= 30} onClick={() => addField(name)}>＋ {name}</button>)}</div>
    {form.fieldTemplates.map((f,i) => <div className="template-row" key={i}><input aria-label={`默认字段名称 ${i+1}`} required maxLength={100} value={f.name} onChange={e => updateField(i,{name:e.target.value})}/><label className="check"><input type="checkbox" checked={f.enabled} onChange={e => updateField(i,{enabled:e.target.checked})}/>默认添加</label><label className="check"><input type="checkbox" checked={f.secret} onChange={e => updateField(i,{secret:e.target.checked})}/>敏感</label><div className="template-actions"><button type="button" className="icon-button" aria-label={`上移字段 ${i+1}`} disabled={i === 0} onClick={() => move(i,-1)}>↑</button><button type="button" className="icon-button" aria-label={`下移字段 ${i+1}`} disabled={i === form.fieldTemplates.length-1} onClick={() => move(i,1)}>↓</button><button type="button" className="icon-button" aria-label={`删除默认字段 ${i+1}`} onClick={() => patch('fieldTemplates',form.fieldTemplates.filter((_,j) => j !== i))}><X size={16}/></button></div></div>)}
    {original.template === 'custom' && <section className="platform-delete"><h3>删除平台</h3>{original.accountCount > 0 ? <p className="muted">此平台有 {original.accountCount} 个账号（含归档和回收站）。先编辑账号更换所属平台，或清理账号后再删除。</p> : <><Field label={`输入平台名称“${original.name}”确认删除`}><input value={confirm} onChange={e => setConfirm(e.target.value)}/></Field><Button type="button" danger disabled={busy || confirm !== original.name} onClick={remove}>删除此平台</Button></>}</section>}
    </div><footer className="dialog-actions"><Button type="button" onClick={onClose}>取消</Button><Button primary disabled={busy}>{busy ? '保存中…' : '保存平台与字段'}</Button></footer></form></Dialog>;
}

function PlatformDialog({onClose, onSaved}) {
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <Dialog title="添加自定义平台" subtitle="为你使用的网站或服务建立独立分类。" onClose={onClose}><form onSubmit={async e => {e.preventDefault(); setBusy(true); try {await api('/platforms', 'POST', {name, url}); onSaved('平台已添加');} catch(e) {setError(e.message);} finally {setBusy(false);}}}><div className="form-body"><Field label="平台名称"><input required maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="例如 GitHub、微软、工作系统"/></Field><Field label="登录网址（可选）"><input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://"/></Field><ErrorLine error={error}/></div><footer className="dialog-actions"><Button type="button" onClick={onClose}>取消</Button><Button primary disabled={busy}>添加平台</Button></footer></form></Dialog>;
}

function BatchDialog({ids, initialAction, onClose, onSaved}) {
  const [action, setAction] = useState(initialAction || 'group'), [value, setValue] = useState(''), [confirm, setConfirm] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const actions = initialAction ? {[initialAction]: {trash: '移入回收站', restore: '恢复账号', purge: '永久删除', archive: '归档', unarchive: '取消归档'}[initialAction]} : {group: '设置分组', tags_add: '添加标签', tags_remove: '移除标签', status: '设置状态', archive: '归档', unarchive: '取消归档', favorite: '加入收藏', trash: '移入回收站'};
  return <Dialog title={`整理 ${ids.length} 个账号`} subtitle="只处理已勾选的账号，不影响其他记录。" onClose={onClose}><form onSubmit={async e => {e.preventDefault(); setBusy(true); try {await api('/batch', 'POST', {ids, action, value: action.startsWith('tags_') ? parseTags(value) : action === 'favorite' ? true : value, confirm}); onSaved(`已处理 ${ids.length} 个账号`);} catch(e) {setError(e.message);} finally {setBusy(false);}}}><div className="form-body"><Field label="操作"><select value={action} onChange={e => {setAction(e.target.value); setValue('');}}>{Object.entries(actions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
    {['group', 'tags_add', 'tags_remove'].includes(action) && <Field label={action === 'group' ? '分组名称（留空移出分组）' : '标签，逗号分隔'}><input value={value} onChange={e => setValue(e.target.value)} required={action !== 'group'}/></Field>}
    {action === 'status' && <Field label="状态"><select required value={value} onChange={e => setValue(e.target.value)}><option value="">请选择</option>{Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
    {action === 'trash' && <p className="notice">账号将移入回收站，之后可以恢复。</p>}{action === 'purge' && <Field label="此操作不可撤销。输入“永久删除”确认"><input required pattern="永久删除" value={confirm} onChange={e => setConfirm(e.target.value)}/></Field>}<ErrorLine error={error}/></div><footer className="dialog-actions"><Button type="button" onClick={onClose}>取消</Button><Button primary={action !== 'purge'} danger={action === 'purge'} disabled={busy}>确认操作</Button></footer></form></Dialog>;
}

function BackupDialog({onClose, onSaved, notify, onSecurity}) {
  const [tab, setTab] = useState('backup'), [password, setPassword] = useState(''), [repeat, setRepeat] = useState(''), [current, setCurrent] = useState(''), [file, setFile] = useState(null), [preview, setPreview] = useState(null), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      if (tab === 'backup') {if (password !== repeat) throw new Error('两次备份密码不一致。'); download(await api('/backup', 'POST', {password})); setPassword(''); setRepeat(''); notify('加密备份已生成，请保存下载的 .atlas 文件');}
      else if (tab === 'password') {if (password !== repeat) throw new Error('两次新密码不一致。'); await api('/password', 'POST', {current, password}); onSaved('主密码已更新，旧备份仍使用原备份密码');}
      else if (!preview) {setPreview(await api('/restore/preview', 'POST', {backup: await readBackup(file), password})); setPassword('');}
      else {await api('/restore/apply', 'POST', {token: preview.token, confirm}); onSaved('备份已恢复，当前主密码保持不变');}
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  return <Dialog title="备份与安全" subtitle="定期备份，让资料在换电脑后也能继续使用。" onClose={onClose}><div className="security-entry"><Button icon={ShieldCheck} onClick={onSecurity}>2FA / 通行密钥 / IP 门禁</Button></div><div className="tab-row">{[['backup', '导出备份'], ['restore', '恢复备份'], ['password', '修改主密码']].map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => {setTab(k); setError(''); setPassword(''); setRepeat(''); setCurrent(''); setPreview(null); setConfirm('');}}>{label}</button>)}</div>
  <form onSubmit={submit}><div className="form-body"><ErrorLine error={error}/>{tab === 'restore' && preview ? <><p className="notice">备份包含 {preview.accounts} 个账号、{preview.platforms} 个平台，将替换当前的 {preview.current} 个账号。当前主密码不变。恢复前会在本机 data 文件夹保留一份使用当前主密码加密的快照。</p><Field label="输入“替换资料库”确认"><input required pattern="替换资料库" value={confirm} onChange={e => setConfirm(e.target.value)}/></Field></> : <>
    {tab === 'restore' && <FilePicker label="选择 .atlas 备份文件" accept=".atlas,.json" required onChange={e => setFile(e.target.files[0])}/>}{tab === 'password' && <Field label="当前主密码"><input type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)}/></Field>}
    <Field label={tab === 'backup' ? '设置备份密码' : tab === 'restore' ? '备份密码' : '新主密码'}><input type="password" required minLength={tab === 'restore' ? 1 : 12} maxLength={1024} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></Field>
    {tab !== 'restore' && <Field label="再次输入密码"><input type="password" required minLength={12} autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)}/></Field>}<p className="notice">{tab === 'backup' ? '备份包括平台、账号、标签和回收站，全部加密。备份密码独立于主密码，请妥善保管。' : tab === 'restore' ? '先验证密码并预览数量，确认后才替换当前资料。' : '至少 12 个字符。更改主密码不会改变已导出备份的密码。'}</p></>}</div><footer className="dialog-actions"><Button type="button" onClick={onClose}>关闭</Button><Button primary disabled={busy}>{busy ? '处理中…' : tab === 'backup' ? '下载加密备份' : tab === 'password' ? '更新主密码' : preview ? '确认恢复' : '验证并预览'}</Button></footer></form></Dialog>;
}

function App() {
  const [auth, setAuth] = useState(null), [state, setState] = useState({accounts: [], platforms: [], tags: [], groups: [], revision: 0});
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [view, setView] = useState('all'), [platform, setPlatform] = useState(''), [group, setGroup] = useState(''), [tag, setTag] = useState(''), [status, setStatus] = useState('');
  const [selected, setSelected] = useState([]), [page, setPage] = useState(1), [dialog, setDialog] = useState(null), [toast, setToast] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [loadedSearch, setLoadedSearch] = useState('');
  const epoch = useRef(0), toastTimer = useRef(null), lockChannel = useRef(null);
  const notify = useCallback(message => {clearTimeout(toastTimer.current); setToast(message); toastTimer.current = setTimeout(() => setToast(''), 4500);}, []);
  const clear = useCallback(() => {invalidateRequests(); epoch.current++; clearTimeout(toastTimer.current); setState({accounts: [], platforms: [], tags: [], groups: [], revision: 0}); setDialog(null); setSelected([]); setQuery(''); setSearch(''); setView('all'); setPlatform(''); setGroup(''); setTag(''); setStatus(''); setLoadedSearch(''); setLoading(false); setError(''); setToast(''); setAuth(a => a ? {...a, unlocked: false} : a);}, []);
  const load = useCallback(async () => {const e = ++epoch.current; setLoading(true); try {const data = await api(`/state?q=${encodeURIComponent(search)}`); if (epoch.current === e) {setState(data); setLoadedSearch(search); setError(''); setSelected([]);}} catch(err) {if (epoch.current === e) setError(err.message);} finally {if (epoch.current === e) setLoading(false);}}, [search]);
  useEffect(() => {api('/status').then(setAuth).catch(e => setError(e.message));}, []);
  useEffect(() => {window.addEventListener('vault-locked', clear); return () => window.removeEventListener('vault-locked', clear);}, [clear]);
  useEffect(() => {const timer = setTimeout(() => setSearch(query), 220); return () => clearTimeout(timer);}, [query]);
  useEffect(() => {if (auth?.unlocked) load();}, [auth?.unlocked, load]);
  useEffect(() => {setPage(1); setSelected([]);}, [search, view, platform, group, tag, status]);
  const lock = useCallback(async () => {clear(); lockChannel.current?.postMessage('locked'); try {await api('/lock', 'POST', {});} catch {}}, [clear]);
  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('atlas-lock');
    lockChannel.current = channel;
    if (channel) channel.onmessage = event => {if (event.data === 'locked') clear();};
    return () => {channel?.close(); lockChannel.current = null;};
  }, [clear]);
  useEffect(() => {
    if (!auth?.unlocked) return;
    const hide = () => {
      // Remove plaintext DOM before the browser can freeze a history snapshot.
      flushSync(clear); lockChannel.current?.postMessage('locked');
      fetch('/api/lock', {method:'POST', credentials:'same-origin', cache:'no-store', keepalive:true,
        headers:{'Content-Type':'application/json','X-Atlas-Request':'1'}, body:'{}'}).catch(() => {});
    };
    window.addEventListener('pagehide', hide);
    return () => window.removeEventListener('pagehide', hide);
  }, [auth?.unlocked, clear]);
  useEffect(() => {
    if (!auth?.unlocked) return;
    let deadline = Date.now() + auth.idleSeconds * 1000;
    const activity = () => {deadline = Date.now() + auth.idleSeconds * 1000;};
    window.addEventListener('pointerdown', activity); window.addEventListener('keydown', activity);
    let checking = false, alive = true;
    const check = async () => {
      if (checking) return;
      if (Date.now() >= deadline) return lock();
      checking = true;
      try {const s = await api('/status'); if (alive && !s.unlocked) clear();}
      catch {if (alive) clear();}
      finally {checking = false;}
    };
    const focus = () => {if (document.visibilityState === 'visible') check();};
    document.addEventListener('visibilitychange', focus);
    const timer = setInterval(check, 10000);
    return () => {alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', focus); window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity);};
  }, [auth?.unlocked, auth?.idleSeconds, clear, lock]);
  async function saved(message) {setDialog(null); notify(message); await load();}
  function navigate(nextView, p = '', g = '') {setView(nextView); setPlatform(p); setGroup(g); setTag(''); setStatus('');}
  const filtered = useMemo(() => state.accounts.filter(a => (view === 'trash' ? Boolean(a.deletedAt) : !a.deletedAt && (view === 'archive' ? a.archived : !a.archived)) && (view !== 'favorites' || a.favorite) && (!platform || a.platformId === platform) && (!group || a.group === group) && (!tag || a.tags.includes(tag)) && (!status || a.status === status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [state.accounts, view, platform, group, tag, status]);
  const exportReady = !loading && !error && query === search && loadedSearch === search;
  const openExport = initialScope => setDialog({type:'export', selectedIds:[...selected], filteredIds:filtered.map(a => a.id), initialScope});
  const pages = Math.max(1, Math.ceil(filtered.length / 30)), currentPage = Math.min(page, pages), visible = filtered.slice((currentPage - 1) * 30, currentPage * 30);
  const heading = group || state.platforms.find(p => p.id === platform)?.name || {all: '全部账号', favorites: '常用收藏', archive: '已归档', trash: '回收站'}[view];
  if (!auth) return <div className="startup"><BookKey/><p>{error || '正在打开账号簿…'}</p></div>;
  if (!auth.unlocked) return <Gate initialized={auth.initialized} onUnlock={async () => {setAuth(await api('/status')); navigate('all');}}/>;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><BookKey size={29}/><span>账号簿<small>Account Atlas</small></span></div><div className="workspace-label"><span className="online-dot"/> 我的本地资料库</div>
    <nav aria-label="账号分类"><button className={view === 'all' && !platform && !group ? 'selected' : ''} onClick={() => navigate('all')}><Layers size={18}/>全部账号<span>{state.total || 0}</span></button><button className={view === 'favorites' ? 'selected' : ''} onClick={() => navigate('favorites')}><Star size={18}/>常用收藏</button>
    <div className="nav-title">平台<button aria-label="添加自定义平台" onClick={() => setDialog({type: 'platform'})}><Plus size={17}/></button></div>{state.platforms.map(p => <button key={p.id} className={platform === p.id ? 'selected' : ''} onClick={() => navigate('all', p.id)}><span className="nav-letter">{p.name.slice(0, 1)}</span>{p.name}<span>{state.accounts.filter(a => a.platformId === p.id && !a.deletedAt && !a.archived).length}</span></button>)}
    <div className="nav-title">分组</div>{state.groups.length ? state.groups.map(g => <button key={g} className={group === g ? 'selected' : ''} onClick={() => navigate('all', '', g)}><Folder size={17}/><span className="group-name">{g}</span></button>) : <p className="nav-hint">添加账号时创建分组</p>}
    <div className="nav-bottom"><button onClick={() => setDialog({type: 'platforms'})}><Settings2 size={18}/>平台与字段管理</button><button className={view === 'archive' ? 'selected' : ''} onClick={() => navigate('archive')}><Archive size={18}/>已归档</button><button className={view === 'trash' ? 'selected' : ''} onClick={() => navigate('trash')}><Trash2 size={18}/>回收站</button><button onClick={() => setDialog({type: 'backup'})}><DatabaseBackup size={18}/>备份与安全</button></div></nav>
    <div className="sidebar-foot"><ShieldCheck size={17}/><span>仅本机访问<small>资料加密保存</small></span><button aria-label="锁定资料库" title="锁定资料库" onClick={lock}><LockKeyhole size={18}/></button></div>
  </aside><main className="workspace"><header className="topbar"><span><span className="breadcrumb">我的资料库</span><ChevronRight size={14}/>{heading}</span><button className="text-button" onClick={lock}><LockKeyhole size={16}/>锁定</button></header>
    <section className="page-content"><div className="page-heading"><div><h1>{heading}</h1><p>{view === 'trash' ? '暂存删除的账号，可恢复或彻底删除。' : '保存好每一份资料，让查找简单一点。'}</p></div><div className="heading-actions"><Button icon={ArrowDownToLine} disabled={!exportReady} onClick={() => openExport()}>批量导出</Button><Button icon={ArrowUpFromLine} onClick={() => setDialog({type: 'import'})}>批量导入</Button><Button primary icon={Plus} onClick={() => setDialog({type: 'edit'})}>添加账号</Button></div></div>
    <div className="mobile-nav"><select aria-label="查看分类" value={platform ? `platform:${platform}` : group ? `group:${group}` : view} onChange={e => {const v=e.target.value; if(v.startsWith("platform:")) navigate("all", v.slice(9)); else if(v.startsWith("group:")) navigate("all", "", v.slice(6)); else navigate(v);}}><option value="all">全部账号</option><option value="favorites">常用收藏</option><option value="archive">已归档</option><option value="trash">回收站</option><optgroup label="平台">{state.platforms.map(p => <option key={p.id} value={`platform:${p.id}`}>{p.name}</option>)}</optgroup><optgroup label="分组">{state.groups.map(g => <option key={g} value={`group:${g}`}>{g}</option>)}</optgroup></select><Button icon={Plus} onClick={() => setDialog({type:"platform"})}>平台</Button><Button icon={Settings2} onClick={() => setDialog({type:"platforms"})}>管理</Button></div><div className="toolbar"><div className="search-box"><Search size={19}/><input aria-label="搜索账号" placeholder="搜索账号、名称、备注…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="清空搜索" onClick={() => setQuery('')}><X size={16}/></button>}</div><select aria-label="标签筛选" value={tag} onChange={e => setTag(e.target.value)}><option value="">所有标签</option>{state.tags.map(t => <option key={t} value={t}>{t}</option>)}</select><select aria-label="状态筛选" value={status} onChange={e => setStatus(e.target.value)}><option value="">所有状态</option>{Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
    <ErrorLine error={error}/><div className="list-meta"><span>{loading ? '正在查找…' : `找到 ${filtered.length} 个账号`}</span><span>状态由你手动记录</span></div>
    {selected.length > 0 && <div className="selection-bar"><strong>已选择 {selected.length} 项</strong><Button icon={ArrowDownToLine} disabled={!exportReady} onClick={() => openExport('selected')}>导出已选</Button>{view === 'trash' ? <><Button onClick={() => setDialog({type: 'batch', ids: selected, action: 'restore'})}>恢复</Button><Button danger onClick={() => setDialog({type: 'batch', ids: selected, action: 'purge'})}>永久删除</Button></> : <Button icon={Settings2} onClick={() => setDialog({type: 'batch', ids: selected})}>批量整理</Button>}<button className="text-button" onClick={() => setSelected([])}>取消选择</button></div>}
    {filtered.length ? <div className="list-panel"><div className="table-scroll"><table className="accounts-table"><thead><tr><th className="checkbox-col"><input type="checkbox" aria-label="选择本页全部账号" checked={visible.length > 0 && visible.every(a => selected.includes(a.id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...visible.map(a => a.id)])] : selected.filter(id => !visible.some(a => a.id === id)))}/></th><th>账号</th><th>平台</th><th>分组 / 标签</th><th>状态</th><th>更新日期</th><th/></tr></thead><tbody>{visible.map(a => {const p = state.platforms.find(p => p.id === a.platformId); return <tr key={a.id} className={selected.includes(a.id) ? 'row-selected' : ''}><td><input type="checkbox" aria-label={`选择 ${a.title}`} checked={selected.includes(a.id)} onChange={e => setSelected(e.target.checked ? [...selected, a.id] : selected.filter(id => id !== a.id))}/></td><td><button className="account-link" onClick={() => setDialog({type: 'detail', entry: a})}><PlatformMark platform={p}/><span><strong>{a.title}</strong><small>{a.identifier}</small></span></button></td><td><span className="platform-label">{p?.name}</span></td><td><div className="row-group">{a.group || '未分组'}</div><div className="tags">{a.tags.slice(0, 2).map(t => <span key={t}>{t}</span>)}{a.tags.length > 2 && <span>+{a.tags.length - 2}</span>}</div></td><td><span className={`status ${a.status}`}>{STATES[a.status]}</span></td><td className="date-cell">{new Date(a.updatedAt).toLocaleDateString('zh-CN')}</td><td><button className={`icon-button favorite ${a.favorite ? 'is-favorite' : ''}`} aria-label={a.favorite ? `取消收藏 ${a.title}` : `收藏 ${a.title}`} disabled={Boolean(a.deletedAt)} onClick={async () => {try {await api('/batch', 'POST', {ids: [a.id], action: 'favorite', value: !a.favorite}); load();} catch(e) {notify(e.message);}}}><Star size={17}/></button></td></tr>;})}</tbody></table></div><footer className="table-footer"><span>每页 30 条</span><div><button className="icon-button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={18}/></button><span>{currentPage} / {pages}</span><button className="icon-button" aria-label="下一页" disabled={currentPage >= pages} onClick={() => setPage(p => p + 1)}><ChevronRight size={18}/></button></div></footer></div> : <div className="empty-state"><div className="empty-drawing"><Folder size={60} strokeWidth={1.2}/><KeyRound size={26}/></div><h2>{query || tag || status ? '没有找到匹配的账号' : view === 'trash' ? '回收站是空的' : '从第一个账号开始'}</h2><p>{query || tag || status ? '换一个关键词，或调整筛选条件。' : view === 'trash' ? '删除的账号会暂存在这里。' : '添加一个账号，或把已有的资料批量导入。'}</p>{view !== 'trash' && !query && <Button primary icon={Plus} onClick={() => setDialog({type: 'edit'})}>添加账号</Button>}</div>}
    <div className="workspace-foot"><LockKeyhole size={14}/><span>整个资料库均加密保存，包括名称、标签和备注。</span><button className="text-button" onClick={() => setDialog({type: 'backup'})}>备份资料</button></div></section></main>
    {dialog?.type === 'edit' && <AccountEditor initial={dialog.entry} state={state} defaultPlatform={platform || 'google'} onClose={() => setDialog(null)} onSaved={saved}/>}
    {dialog?.type === 'detail' && <Detail entry={dialog.entry} state={state} onClose={() => setDialog(null)} onEdit={entry => setDialog({type: 'edit', entry})} onBatch={(ids, action) => setDialog({type: 'batch', ids, action})} notify={notify}/>}
    {dialog?.type === 'platforms' && <PlatformManager state={state} initialId={platform} onClose={() => setDialog(null)} onSaved={async message => {navigate('all'); await saved(message);}}/>}
    {dialog?.type === 'platform' && <PlatformDialog onClose={() => setDialog(null)} onSaved={saved}/>}
    {dialog?.type === 'export' && <ExportDialog ui={{Dialog, Field, ErrorLine, Button}} state={state} selectedIds={dialog.selectedIds} filteredIds={dialog.filteredIds} initialScope={dialog.initialScope} defaultPlatform={platform} filterDescription={[heading, query && `搜索：${query}`, tag && `标签：${tag}`, status && `状态：${STATES[status]}`].filter(Boolean).join(' · ')} onClose={() => setDialog(null)}/>}
    {dialog?.type === 'import' && <ImportDialog ui={{Dialog, Field, FilePicker, ErrorLine, Button}} state={state} defaultPlatform={platform} onClose={() => setDialog(null)} onSaved={saved}/>}
    {dialog?.type === 'batch' && <BatchDialog ids={dialog.ids} initialAction={dialog.action} onClose={() => setDialog(null)} onSaved={saved}/>}
    {dialog?.type === 'backup' && <BackupDialog onClose={() => setDialog(null)} onSaved={saved} notify={notify} onSecurity={() => setDialog({type:"security"})}/>}
    {dialog?.type === 'security' && <SecurityDialog ui={{Dialog, Field, Button, ErrorLine}} onClose={() => setDialog(null)} onChanged={load}/>}
    {toast && <div role="status" className="toast"><Check size={18}/>{toast}</div>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
