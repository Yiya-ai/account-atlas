import React, {useEffect, useRef, useState} from 'react';
import {Copy, ShieldCheck} from 'lucide-react';
import {api, saveFile} from './api';
import {passkeyCeremony} from './passkeys';
import {serverTunnel, publicHttps} from './deployment';

export default function SecurityDialog({ui, onClose, onChanged, enrollment=false}) {
  const {Dialog, Field, Button, ErrorLine} = ui;
  const [state, setState] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [password, setPassword] = useState(''), [code, setCode] = useState('');
  const [binding, setBinding] = useState(null), [codes, setCodes] = useState(null), [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState(false), [rules, setRules] = useState('');
  const [idleMinutes, setIdleMinutes] = useState('15');
  const [proof, setProof] = useState(''), [keyName, setKeyName] = useState(''), [names, setNames] = useState({});
  const alive = useRef(true);
  useEffect(() => {let active=true; api('/security').then(s => {if(active) {setState(s); setEnabled(s.ip.enabled); setRules(s.ip.rules.join('\n')); setIdleMinutes(String(s.idleMinutes));}}).catch(e => {if(active) setError(e.message);}); return () => {active=false; alive.current=false;};}, []);
  async function saveIdle(e) {
    e.preventDefault();
    const minutes = Number(idleMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return setError('锁定时间请输入 1 至 1440 的整数分钟。');
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/security/idle', 'POST', {minutes});
      const s = await api('/security');
      if (!alive.current) return;
      setState(s); setIdleMinutes(String(s.idleMinutes));
      await onChanged();
      if (alive.current) setNotice(`已保存：闲置 ${s.idleMinutes} 分钟后自动锁定。`);
    } catch(e) {if (alive.current) setError(e.message);}
    finally {if (alive.current) setBusy(false);}
  }
  async function cancelBinding() {
    if (!binding) return true;
    setBusy(true);
    try {await api('/security/setup/cancel', 'POST', {token:binding.token}); setBinding(null); setCode(''); return true;}
    catch(e) {if(alive.current) setError(e.message); return false;}
    finally {if(alive.current) setBusy(false);}
  }
  async function close() {
    if(busy) return;
    if(codes && !saved) return setError('请先保存恢复码，并勾选已妥善保存。');
    if(!await cancelBinding()) return;
    onClose();
  }
  async function perform(path, payload, message) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api(`/security/${path}`, 'POST', {...payload,proof});
      if(!alive.current) return;
      setPassword(''); setCode(''); setProof('');
      if(path === 'setup') {setBinding(result); onChanged();}
      else {
        setBinding(null);
        if(result.recoveryCodes) {setCodes(result.recoveryCodes); setSaved(false);}
        const s = await api('/security');
        if(!alive.current) return;
        setState(s); setEnabled(s.ip.enabled); setRules(s.ip.rules.join('\n'));
        onChanged();
      }
      setNotice(message);
    } catch(e) {if(alive.current) setError(e.message);}
    finally {if(alive.current) setBusy(false);}
  }
  async function copy(value) {
    try {await navigator.clipboard.writeText(value); setNotice('已复制，请保存在资料库之外。');}
    catch {setError('剪贴板不可用，请手动选择并复制。');}
  }
  async function usePasskey(register=false) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result=await passkeyCeremony(register ? '/security/passkey/options':'/security/passkey/proof-options',register ? '/security/passkey/register':'/security/passkey/proof',{password,code,proof,name:keyName},register);
      if(!alive.current) return;
      if(register) {
        setPassword(''); setCode(''); setProof(''); setKeyName('');
        if(result.recoveryCodes) {setCodes(result.recoveryCodes); setSaved(false);}
        setNotice('通行密钥已绑定。解锁时可选择通行密钥完成二次验证。');
      } else {setProof(result.proof); setNotice('通行密钥已验证，2 分钟内可确认一次门禁修改，仍需填写主密码。');}
      const s=await api('/security'); if(alive.current) {setState(s); onChanged();}
    } catch(e) {if(alive.current) {setError(e.message); setProof('');}}
    finally {if(alive.current) {setBusy(false); if(register) onChanged();}}
  }
  const canChange = Boolean(password && (!state?.factorEnabled || code || proof));
  return <Dialog title="自动锁定与安全设置" subtitle="设置闲置锁定时间、二次验证和 IP 门禁。" onClose={close} wide>
    <div className="form-body security-body"><ErrorLine error={error}/>{notice && <p className="notice" role="status">{notice}</p>}
      {!state ? <p className="muted">正在读取门禁设置…</p> : <>
        {!enrollment && !binding && !codes && <section><h3>自动锁定</h3><form onSubmit={saveIdle}><Field label="闲置锁定时间（分钟）" hint="1 至 1440 分钟，默认 15 分钟。点击、输入或滚动页面会重新计时；单纯打开页面不会续期。"><input type="number" inputMode="numeric" required min="1" max="1440" step="1" disabled={busy} value={idleMinutes} onChange={e => setIdleMinutes(e.target.value)}/></Field><Button primary disabled={busy}>保存锁定时间</Button></form><p className="muted">当前设置：{state.idleMinutes} 分钟。保存后立即生效，重启后仍保留；也可随时点击“锁定”。</p></section>}
        <div className="security-overview"><ShieldCheck size={25}/><div><strong>资料库二次验证：{state.factorEnabled ? '已启用' : '未启用'}</strong><p>验证器：{state.enabled ? '已启用' : '未启用'} · 通行密钥：{state.passkeys.length} 把</p><p>{state.networkGate && <span>地域门禁：{state.networkGate.allowed.join(' / ')}（已启用）<br/></span>}附加 IP 白名单：{state.ip.enabled ? '已启用' : '未启用'} · 当前连接 {state.ip.current}</p></div></div>
        {codes ? <section className="recovery-sheet"><h3>保存一次性恢复码</h3><p className="muted">手机丢失时，输入主密码后可使用任意一个未用过的恢复码。每个仅能使用一次，以下内容只显示这一次。重新生成会使旧恢复码全部失效。</p><pre>{codes.join('\n')}</pre><div className="security-actions"><Button icon={Copy} onClick={() => copy(codes.join('\n'))}>复制恢复码</Button><Button onClick={() => saveFile(`Account Atlas 一次性恢复码\n请保存在资料库之外，每个仅能使用一次。\n\n${codes.join('\n')}\n`, 'text/plain;charset=utf-8', '账号簿-2FA恢复码.txt')}>下载恢复码</Button></div><label className="check"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}/>我已将恢复码保存在资料库之外</label><Button disabled={!saved} onClick={() => {setCodes(null); setError(''); if(enrollment) onClose();}}>完成</Button></section> : <>
          <section><h3>身份验证器（2FA）</h3>{state.totpRequired && <p className="notice">公网模式必须启用 2FA。IP 地址入口不提供通行密钥，请使用验证器或一次性恢复码。</p>}<p className="muted">保护进入账号簿的入口，与账号详情里保存的 2FA 密钥相互独立。支持 Google Authenticator 等 TOTP 验证器；验证码为 6 位，每 30 秒更新。</p>
            {binding ? <form onSubmit={e => {e.preventDefault(); perform('enable',{token:binding.token,code},'2FA 已启用，请立即保存恢复码。');}}>
              <div className="totp-binding"><img src={binding.qr} alt="账号簿 2FA 绑定二维码"/><div><p>用手机验证器扫描二维码，或手动输入密钥：</p><code>{binding.secret}</code><Button type="button" icon={Copy} onClick={() => copy(binding.secret)}>复制绑定密钥</Button><p className="muted">10 分钟内输入手机验证码完成绑定。确认前不会开启 2FA。</p></div></div>
              <Field label="绑定验证码"><input required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value)}/></Field><div className="security-actions"><Button primary disabled={busy}>验证并启用 2FA</Button><Button type="button" disabled={busy} onClick={cancelBinding}>取消绑定</Button></div>
            </form> : <>
              {state.factorEnabled && <p className="notice">剩余 {state.recoveryRemaining} 个恢复码。门禁修改需要主密码，以及验证码、恢复码或一次新的通行密钥验证。</p>}
              <Field label="确认主密码"><input type="password" autoComplete="current-password" maxLength={1024} value={password} onChange={e => setPassword(e.target.value)}/></Field>
              {state.factorEnabled && <Field label="当前验证码或恢复码"><input autoComplete="one-time-code" maxLength={80} value={code} onChange={e => setCode(e.target.value)} placeholder="验证码 / 恢复码，或使用下方通行密钥验证"/></Field>}
              {state.passkeysAvailable !== false && state.passkeys.length > 0 && <Button disabled={busy} onClick={() => usePasskey()}>使用通行密钥确认修改</Button>}
              <div className="security-actions">{state.factorEnabled && <Button disabled={busy || !canChange} onClick={() => perform('recovery',{password,code},'恢复码已更新，旧码已失效。')}>重新生成恢复码</Button>}{state.enabled ? <Button danger disabled={busy || !canChange || state.totpRequired} onClick={() => perform('disable',{password,code},'身份验证器已关闭，通行密钥和 IP 门禁保持原设置。')}>验证并关闭验证器</Button> : <Button primary disabled={busy || !canChange} onClick={() => perform('setup',{password,code},'请扫描二维码并输入手机验证码。')}>开始绑定验证器</Button>}</div>
            </>}
          </section>
          {!binding && state.passkeysAvailable !== false && <section className="passkey-settings"><h3>通行密钥</h3><p className="muted">输入主密码后，可用 Windows Hello、手机或硬件安全密钥完成门禁。设备需验证指纹、人脸或 PIN。私钥由验证器保存，账号簿只保存公钥。请使用 localhost 地址，并在支持 WebAuthn 的浏览器中操作。</p>
            <Field label="新通行密钥名称"><input maxLength={60} value={keyName} onChange={e=>setKeyName(e.target.value)} placeholder="例如：这台电脑的 Windows Hello"/></Field><Button primary disabled={busy || !canChange || !keyName.trim() || state.passkeys.length >= 10} onClick={()=>usePasskey(true)}>添加通行密钥</Button>
            {state.passkeys.map(k=><div className="passkey-row" key={k.id}><Field label={`通行密钥名称：${k.name}`}><input maxLength={60} value={names[k.id] ?? k.name} onChange={e=>setNames(n=>({...n,[k.id]:e.target.value}))}/></Field><p className="muted">最近使用：{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('zh-CN') : '尚未使用'}</p><div className="security-actions"><Button disabled={busy || !canChange || !names[k.id]?.trim()} onClick={()=>perform('passkey/manage',{action:'rename',id:k.id,name:names[k.id],password,code},'通行密钥名称已更新。')}>保存名称</Button><Button danger disabled={busy || !canChange} onClick={()=>perform('passkey/manage',{action:'remove',id:k.id,password,code},'通行密钥已移除。')}>{state.passkeys.length===1 && !state.enabled ? '移除最后一把并关闭二次验证' : '移除此通行密钥'}</Button></div></div>)}
            <p className="muted">首次启用会生成恢复码。移除最后一种验证方式会关闭二次验证；从账号簿移除不会自动删除设备内的密钥。</p>
          </section>}
          {!binding && <section className="ip-settings"><h3>严格 IP 白名单</h3><p className="muted">{publicHttps ? "地域门禁要求来源归属中国福建厦门，未知归属或查询失败会拒绝。下面的 IP / CIDR 白名单可进一步缩小范围；关闭它不会关闭地域门禁。来源由可信 HTTPS 入口确认，访客提供的转发头不能覆盖。" : serverTunnel ? "当前通过 SSH 隧道访问，应用看到的来源是 127.0.0.1；启用时请保留此地址。应用白名单不能区分隧道外的公网 IP，远程入口由 SSH 公钥认证控制。" : "仅允许匹配的连接来源访问。当前为本机单人版，来源通常是 127.0.0.1；此功能不会开放局域网或公网访问，也不按公网出口 IP 判断。"}</p><label className="check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>启用 IP 白名单</label><Field label="允许的 IP / CIDR 网段" hint="每行一条，支持 IPv4 和 IPv6。启用时必须包含当前连接 IP。"><textarea rows={4} value={rules} onChange={e => setRules(e.target.value)} placeholder="127.0.0.1&#10;::1"/></Field><div className="security-actions"><Button disabled={busy} onClick={() => setRules(value => [...new Set([...value.split('\n').filter(Boolean),state.ip.current])].join('\n'))}>加入当前 IP</Button><Button primary disabled={busy || !canChange} onClick={() => perform('ip',{password,code,enabled,rules:rules.split('\n').map(s=>s.trim()).filter(Boolean)},'IP 门禁已保存并立即生效。')}>验证并保存 IP 门禁</Button></div><p className="muted">使用上方的主密码{state.factorEnabled ? '和二次验证' : ''}确认修改。服务端校验实际来源，浏览器不能通过自填转发头改变来源。</p></section>}
        </>}
        <p className="notice">加密备份只迁移账号资料，不携带门禁。恢复备份保留当前资料库门禁；新资料库需重新绑定验证器 / 通行密钥。请把恢复码保存在账号簿之外。</p>
      </>}
    </div><footer className="dialog-actions"><Button disabled={busy || Boolean(codes && !saved)} onClick={close}>关闭</Button></footer>
  </Dialog>;
}
