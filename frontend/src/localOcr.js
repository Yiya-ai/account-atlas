const MODEL_HASHES = {
  eng:'7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
  chi_sim:'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730',
  chi_tra:'529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b',
};

export async function prepareScreenshot(file) {
  if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 截图。');
  if (file.size > 10 * 1024 * 1024) throw new Error('截图不能超过 10 MB，请先裁剪。');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取截图，请重新选择。'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = data;
  try {await image.decode();} catch {throw new Error('图片无法解码，请选择有效截图。');}
  if (!image.width || !image.height || image.width * image.height > 16000000 || Math.max(image.width, image.height) > 8000) throw new Error('截图尺寸过大，请裁剪到 1600 万像素以内。');
  const scale = Math.min(1, 3200 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

export function recognizeScreenshot(image, language, onProgress) {
  const controller = new AbortController();
  let worker, cancelled = false, rejectJob, pending;
  const stopped = new Promise((_, reject) => {rejectJob = reject;});
  const cancel = () => {
    if (cancelled) return;
    cancelled = true; controller.abort();
    worker?.terminate();
    rejectJob(new Error('识别已取消。'));
  };
  const timer = setTimeout(() => cancel(), 120000);
  const work = async () => {
    const base = new URL('ocr/', window.location.href);
    const codes = language === 'traditional' ? ['chi_tra','eng'] : language === 'english' ? ['eng'] : ['chi_sim','eng'];
    onProgress('正在加载本地识别语言…');
    const langs = await Promise.all(codes.map(async code => {
      const response = await fetch(new URL(`models/${code}.traineddata`, base), {signal:controller.signal, credentials:'same-origin'});
      if (!response.ok) throw new Error('本地语言文件不可用，请刷新重试或检查安装。');
      const data = new Uint8Array(await response.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== MODEL_HASHES[code]) throw new Error('本地语言文件校验失败，请重新安装。');
      return {code, data};
    }));
    if (cancelled) throw new Error('识别已取消。');
    // Own the native Worker from construction, so cancel/lock can terminate even
    // during WASM initialization. Protocol is pinned to Tesseract.js 7.0.0.
    worker = new Worker(new URL('runtime/worker.min.js', base));
    let sequence = 0;
    const fail = () => rejectJob(new Error('本地识别未完成，请重试或裁剪更清晰的截图。'));
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.onmessage = ({data:packet}) => {
      if (cancelled) return;
      if (packet.status === 'progress') {
        const message = packet.data;
        onProgress(message.status === 'recognizing text' ? `正在识别截图… ${Math.round(message.progress * 100)}%` : '正在准备本地识别引擎…');
      } else if (pending && packet.jobId === pending.id) {
        if (packet.status === 'resolve') {pending.resolve(packet); pending = null;}
        else if (packet.status === 'reject') fail();
      }
    };
    const run = (action, payload) => new Promise(resolve => {
      const id = `atlas-ocr-${++sequence}`;
      pending = {id, resolve};
      worker.postMessage({workerId:'atlas-local', jobId:id, action, payload});
    });
    await run('load', {options:{lstmOnly:true, corePath:new URL('runtime/', base).href, logging:false}});
    await run('loadLanguage', {langs, options:{langPath:new URL('models/', base).href, cacheMethod:'none', gzip:false, lstmOnly:true}});
    await run('initialize', {langs:codes.join('+'), oem:1, config:{}});
    await run('setParameters', {params:{tessedit_pageseg_mode:'11', preserve_interword_spaces:'1'}});
    const bytes = Uint8Array.from(atob(image.split(',')[1]), char => char.charCodeAt(0));
    const {data} = await run('recognize', {image:bytes, options:{}, output:{text:true, blocks:true}});
    return (data.blocks || []).flatMap(block => block.paragraphs || []).flatMap(paragraph => paragraph.lines || []);
  };
  const promise = Promise.race([work(), stopped]).finally(() => {
    clearTimeout(timer); cancelled = true; controller.abort();
    worker?.terminate(); pending = null;
  });
  return {promise, cancel};
}
