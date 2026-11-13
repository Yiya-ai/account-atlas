// Run the actual browser OCR implementation with deterministic browser boundaries.
// No screenshots, model downloads, worker processes, network or third-party calls.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/localOcr.js', import.meta.url), 'utf8');
const screenshot = 'data:image/png;base64,AQIDBA==';
const flush = () => new Promise(setImmediate);

function harness({deferModels=false, badHash=false, missingModel=false} = {}) {
  const workers = [], requests = [], progress = [], timers = new Map(), modelReplies = [];
  const codes = ['eng', 'chi_sim', 'chi_tra'];
  let timerId = 0, exports;
  class NativeWorker {
    constructor(url) {this.url=String(url); this.messages=[]; this.terminated=0; workers.push(this);}
    postMessage(packet) {this.messages.push(packet);}
    terminate() {this.terminated++;}
    reply(status='resolve', data={}, jobId=this.messages.at(-1)?.jobId) {this.onmessage?.({data:{status,data,jobId}});}
  }
  const context = {
    window:{location:{href:'https://atlas.example.invalid/account-atlas/'}},
    URL, AbortController, Uint8Array, Worker:NativeWorker,
    atob:value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout:(callback, milliseconds) => {const id=++timerId; timers.set(id,{callback,milliseconds}); return id;},
    clearTimeout:id => timers.delete(id),
    fetch:(url, options) => {
      const address = String(url), code = address.split('/').at(-1).replace('.traineddata', '');
      requests.push({url:address,options});
      assert.ok(codes.includes(code), 'Only bundled language files may be fetched');
      const response = {ok:!missingModel, arrayBuffer:async () => Uint8Array.of(codes.indexOf(code)).buffer};
      return new Promise((resolve,reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('Aborted model request')), {once:true});
        if (deferModels) modelReplies.push(() => resolve(response)); else resolve(response);
      });
    },
    crypto:{subtle:{digest:async (algorithm, data) => {
      assert.equal(algorithm,'SHA-256');
      const expected = exports.MODEL_HASHES[codes[data[0]]];
      return Uint8Array.from(Buffer.from(badHash ? '00'.repeat(32) : expected, 'hex')).buffer;
    }}},
  };
  vm.runInNewContext(source.replace(/^export /gm, '') + '\nglobalThis.ocrTestExports={recognizeScreenshot,MODEL_HASHES};', context, {timeout:1000});
  exports = context.ocrTestExports;
  return {
    workers, requests, progress, timers,
    start(language='simplified') {
      const job = exports.recognizeScreenshot(screenshot, language, message => progress.push(message));
      // Observe immediately so intentionally delayed assertions cannot trigger an
      // unhandled-rejection event while cancellation/error microtasks settle.
      job.promise.catch(() => {});
      return job;
    },
    replyModels:() => {for (const reply of modelReplies) reply();},
    timeout:() => {for (const timer of timers.values()) {assert.equal(timer.milliseconds,120000); timer.callback();}},
  };
}

function assertLocalRequests(test) {
  assert.ok(test.requests.length > 0);
  for (const {url,options} of test.requests) {
    assert.ok(url.startsWith('https://atlas.example.invalid/account-atlas/ocr/models/'));
    assert.equal(options.credentials,'same-origin');
    assert.equal(options.body,undefined,'Screenshots must never be uploaded');
    assert.equal(options.method,undefined,'Language requests use GET');
  }
}

function assertDisposed(test, worker) {
  assert.equal(test.timers.size,0,'Completion must clear its timeout');
  assert.ok(test.requests.every(request => request.options.signal.aborted),'Completion must abort remaining model requests');
  if (worker) assert.ok(worker.terminated > 0,'Completion must terminate its native worker');
}

function assertLateProgressIgnored(test, worker) {
  const count = test.progress.length;
  worker.reply('progress',{status:'recognizing text',progress:1});
  worker.reply('resolve',{blocks:[{paragraphs:[{lines:[{text:'LATE_RESULT'}]}]}]});
  assert.equal(test.progress.length,count,'Late worker progress must not reach the UI callback');
}

// Cancelling while model bytes are pending must abort GETs and never spawn a worker.
const loading = harness({deferModels:true});
const loadingJob = loading.start();
assert.equal(loading.workers.length,0);
loadingJob.cancel();
await assert.rejects(loadingJob.promise,/识别已取消/);
loading.replyModels(); await flush();
assert.equal(loading.workers.length,0,'Late model responses must not start recognition');
assertDisposed(loading); assertLocalRequests(loading);

// The native worker handle exists before WASM initialization finishes.
const initializing = harness();
const initializingJob = initializing.start();
await flush();
const initializingWorker = initializing.workers[0];
assert.ok(initializingWorker);
assert.equal(initializingWorker.messages[0].action,'load');
initializingJob.cancel();
assert.ok(initializingWorker.terminated > 0,'Cancel must synchronously terminate a worker stuck loading WASM');
await assert.rejects(initializingJob.promise,/识别已取消/);
assertDisposed(initializing,initializingWorker);
assertLateProgressIgnored(initializing,initializingWorker);
const terminated = initializingWorker.terminated;
initializingJob.cancel();
assert.equal(initializingWorker.terminated,terminated,'Repeated cancellation is idempotent');

// Native load errors, message decoding errors and protocol rejections all clean up.
for (const failure of ['error','messageerror','reject']) {
  const test = harness(), job = test.start('english');
  await flush();
  const worker = test.workers[0];
  if (failure === 'error') worker.onerror({message:'Synthetic worker failure'});
  else if (failure === 'messageerror') worker.onmessageerror({});
  else worker.reply('reject','Synthetic protocol failure');
  await assert.rejects(job.promise,/本地识别未完成/);
  assertDisposed(test,worker); assertLateProgressIgnored(test,worker);
}

for (const deferModels of [true,false]) {
  const test = harness({deferModels}), job = test.start();
  await flush(); test.timeout();
  await assert.rejects(job.promise,/识别已取消/);
  assertDisposed(test,test.workers[0]);
}

for (const option of [{badHash:true},{missingModel:true}]) {
  const test = harness(option), job = test.start();
  await assert.rejects(job.promise,option.badHash ? /校验失败/ : /语言文件不可用/);
  assert.equal(test.workers.length,0,'Unverified models must never be sent to a worker');
  assertDisposed(test);
}

// Success uses the pinned protocol in order, resolves lines and terminates once done.
const successful = harness(), successfulJob = successful.start('traditional');
await flush();
const worker = successful.workers[0];
assert.equal(worker.url,'https://atlas.example.invalid/account-atlas/ocr/runtime/worker.min.js');
const actions = ['load','loadLanguage','initialize','setParameters','recognize'];
for (const [index,action] of actions.entries()) {
  const packet = worker.messages.at(-1);
  assert.equal(packet.action,action);
  assert.equal(packet.jobId,`atlas-ocr-${index+1}`);
  if (action === 'load') assert.equal(packet.payload.options.corePath,'https://atlas.example.invalid/account-atlas/ocr/runtime/');
  if (action === 'loadLanguage') {
    assert.equal(packet.payload.options.cacheMethod,'none');
    assert.deepEqual(Array.from(packet.payload.langs,lang=>lang.code),['chi_tra','eng']);
  }
  if (action === 'initialize') assert.equal(packet.payload.langs, 'chi_tra+eng', 'Initialization takes language codes, never model bytes');
  if (action === 'recognize') {
    assert.deepEqual(Array.from(packet.payload.image),[1,2,3,4]);
    worker.reply('progress',{status:'recognizing text',progress:.5});
    worker.reply('resolve',{blocks:[{paragraphs:[{lines:[{text:'Synthetic Person',confidence:95,bbox:{x0:1,y0:2,x1:90,y1:22}}]}]}]});
  } else worker.reply();
  await flush();
}
const result = await successfulJob.promise;
assert.equal(result.length,1); assert.equal(result[0].text,'Synthetic Person');
assert.ok(successful.progress.includes('正在识别截图… 50%'));
assertDisposed(successful,worker); assertLocalRequests(successful);
assertLateProgressIgnored(successful,worker);

// Automatic mode loads only the three bundled, hash-verified languages and can
// be cancelled during initialization just like the single-language modes.
const mixed = harness(), mixedJob = mixed.start('auto');
await flush();
const mixedWorker = mixed.workers[0];
mixedWorker.reply(); await flush();
assert.deepEqual(Array.from(mixedWorker.messages.at(-1).payload.langs, lang => lang.code), ['chi_tra','chi_sim','eng']);
mixedWorker.reply(); await flush();
assert.equal(mixedWorker.messages.at(-1).payload.langs, 'chi_tra+chi_sim+eng');
mixedJob.cancel();
await assert.rejects(mixedJob.promise, /识别已取消/);
assertDisposed(mixed, mixedWorker); assertLocalRequests(mixed);

// Cancelling recognition itself must reject, not release a late recognition result.
const recognizing = harness(), recognizingJob = recognizing.start('english');
await flush();
const recognizingWorker = recognizing.workers[0];
for (let stage=0; stage<4; stage++) {recognizingWorker.reply(); await flush();}
assert.equal(recognizingWorker.messages.at(-1).action,'recognize');
recognizingJob.cancel();
await assert.rejects(recognizingJob.promise,/识别已取消/);
assertDisposed(recognizing,recognizingWorker); assertLateProgressIgnored(recognizing,recognizingWorker);

console.log('Local OCR lifecycle checks passed: model cancellation, initialization cancellation, errors, timeout, verified assets, success cleanup and ignored late callbacks.');
