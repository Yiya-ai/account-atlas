import {api} from './api';

const decode = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=')), c=>c.charCodeAt(0));
const encode = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

export async function passkeyCeremony(optionsPath, verifyPath, payload={}, create=false) {
  if(location.hostname !== 'localhost') throw new Error('请使用 localhost 地址打开账号簿后操作通行密钥。');
  if(!window.PublicKeyCredential || !navigator.credentials) throw new Error('此浏览器暂不支持通行密钥，请在 Edge 或 Chrome 中打开账号簿。');
  const options=await api(optionsPath,'POST',payload);
  options.challenge=decode(options.challenge);
  if(options.user) options.user.id=decode(options.user.id);
  for(const key of ['excludeCredentials','allowCredentials']) if(options[key]) options[key]=options[key].map(c=>({...c,id:decode(c.id)}));
  let credential;
  try {credential=await navigator.credentials[create ? 'create':'get']({publicKey:options});}
  catch(e) {
    if(e.name==='NotAllowedError' || e.name==='AbortError') throw new Error('通行密钥操作已取消或超时，可重试或使用验证码 / 恢复码。');
    if(e.name==='InvalidStateError') throw new Error('该验证器已有此资料库的通行密钥，请使用已有密钥或换一台验证器。');
    throw new Error('设备未能完成通行密钥验证，请检查浏览器和 Windows Hello / 安全密钥设置。');
  }
  if(!credential) throw new Error('未收到通行密钥，请重试。');
  const response={};
  for(const key of ['clientDataJSON','attestationObject','authenticatorData','signature','userHandle']) if(credential.response[key]) response[key]=encode(credential.response[key]);
  if(credential.response.getTransports) response.transports=credential.response.getTransports();
  return api(verifyPath,'POST',{credential:{id:credential.id,rawId:encode(credential.rawId),type:credential.type,response}});
}
