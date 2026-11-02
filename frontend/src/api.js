let generation = 0;
const pending = new Set();
export function invalidateRequests() {
  generation++;
  for (const controller of pending) controller.abort();
  pending.clear();
}
function ensureCurrent(start) {
  if (start !== generation) throw new Error('资料库已锁定，请重新解锁。');
}
export async function api(path, method = 'GET', data) {
  const start = generation, controller = new AbortController();
  pending.add(controller);
  const timer = path === '/status' ? setTimeout(() => controller.abort(), 8000) : null;
  try {
  const res = await fetch(`/api${path}`, {
    signal: controller.signal,
    method, credentials: 'same-origin', cache: 'no-store',
    headers: {'Content-Type': 'application/json', 'X-Atlas-Request': '1'},
    ...(data === undefined ? {} : {body: JSON.stringify(data)})
  });
  const payload = await res.json();
  ensureCurrent(start);
  if (!res.ok) {
    if (res.status === 403 || (res.status === 401 && !['/unlock', '/setup', '/password', '/restore/preview'].includes(path))) window.dispatchEvent(new Event('vault-locked'));
    throw new Error(payload.error || '操作未完成，请重试。');
  }
  return payload;
  } finally {clearTimeout(timer); pending.delete(controller);}
}
export async function readBackup(file) {
  if (!file) throw new Error('请选择备份文件。');
  if (file.size > 16 * 1024 * 1024) throw new Error('文件不能超过 16 MB。');
  try { return JSON.parse(await file.text()); } catch { throw new Error('备份文件格式不正确。'); }
}
export function download(data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = `账号簿备份-${new Date().toISOString().slice(0, 10)}.atlas`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function saveFile(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportFile(payload, signal) {
  const start = generation;
  const response = await fetch('/api/export/download', {method:'POST', credentials:'same-origin', cache:'no-store', signal,
    headers:{'Content-Type':'application/json','X-Atlas-Request':'1'}, body:JSON.stringify(payload)});
  if (!response.ok) {
    if(response.status === 401 || response.status === 403) window.dispatchEvent(new Event('vault-locked'));
    const error = await response.json(); throw new Error(error.error || '导出未完成，请重试。');
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const blob = await response.blob();
  ensureCurrent(start);
  return {blob, filename:encoded ? decodeURIComponent(encoded[1]) : `账号簿导出.${payload.format}`};
}
