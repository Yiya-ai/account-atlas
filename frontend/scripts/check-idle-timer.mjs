// Execute the actual idle-lock effect with a fake clock and network boundary.
// No browser, real vault, or copied timer implementation is involved.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const marker = '    let lastActivity = Date.now()';
assert.equal(source.split(marker).length, 2, 'Locate exactly one idle-lock effect');
const start = source.lastIndexOf('  useEffect(() => {', source.indexOf(marker));
const end = source.indexOf('  async function saved', start);
assert.ok(start >= 0 && end > start, 'Idle-lock effect boundaries must exist');
const effect = source.slice(start, end);

function harness({enrollment = false} = {}) {
  let now = 100000, interval, cleanup, locks = 0, seconds = 60;
  let current = {unlocked:true, idleSeconds:60, enrollmentRequired:enrollment};
  const requests = [], events = new Map();
  const removeEventListener = key => events.delete(key);
  const document = {
    visibilityState:'visible',
    addEventListener:(key, handler) => events.set(key, handler),
    removeEventListener,
  };
  const context = {
    auth:current, idleSeconds:{current:60}, Date:{now:() => now}, document,
    window:{addEventListener:(key, handler) => events.set(key, handler), removeEventListener},
    useEffect:callback => {cleanup = callback();},
    setInterval:callback => {interval = callback; return 1;},
    clearInterval:() => {interval = undefined;},
    clear:() => {locks++;}, lock:async () => {locks++;},
    setAuth:update => {current = update(current);},
    api:async (path, method) => {
      requests.push({path, method});
      return {unlocked:true, idleSeconds:seconds};
    },
  };
  vm.runInNewContext(effect, context, {timeout:1000});
  return {
    advance:milliseconds => {now += milliseconds;},
    setSeconds:value => {seconds = value;},
    tick:async () => {if (interval) await interval();},
    dispatch:async (type, isTrusted = true) => {
      events.get(type)?.({isTrusted});
      // Drain the real async activity handler, which intentionally returns void.
      await new Promise(setImmediate);
    },
    setVisible:async visible => {
      document.visibilityState = visible ? 'visible' : 'hidden';
      events.get('visibilitychange')?.();
      await new Promise(setImmediate);
    },
    posts:() => requests.filter(r => r.path === '/activity' && r.method === 'POST').length,
    locks:() => locks,
    listeners:() => events.size,
    cleanup:() => cleanup?.(),
  };
}

const idle = harness();
await idle.tick();
idle.advance(30000); await idle.tick();
assert.equal(idle.posts(), 0, 'Status polling must never renew a session');
idle.advance(30000); await idle.tick();
assert.equal(idle.locks(), 1, 'An untouched session must lock at its deadline');

for (const type of ['pointerdown', 'keydown', 'scroll']) {
  const active = harness();
  active.advance(30000); await active.dispatch(type);
  assert.equal(active.posts(), 1, `${type} must renew an active visible session`);
  active.advance(20000); await active.tick();
  assert.equal(active.locks(), 0, `${type} must move the inactivity deadline`);
  active.advance(40000); await active.tick();
  assert.equal(active.locks(), 1, `${type} must not keep renewing without more input`);
}

const hidden = harness();
await hidden.setVisible(false);
await hidden.dispatch('pointerdown'); await hidden.tick();
assert.equal(hidden.posts(), 0, 'Hidden activity must not renew');
await hidden.setVisible(true);
await hidden.dispatch('keydown', false); await hidden.tick();
assert.equal(hidden.posts(), 0, 'Synthetic activity must not renew');

const changed = harness();
changed.advance(30000); changed.setSeconds(120); await changed.tick();
changed.advance(90000); await changed.tick();
assert.equal(changed.locks(), 1, 'Updating the timeout must retain the last actual activity time');

const expired = harness();
expired.advance(60000); await expired.dispatch('keydown');
assert.equal(expired.posts(), 0, 'Input after expiry must not resurrect the local session');
assert.equal(expired.locks(), 1);

const enrollment = harness({enrollment:true});
assert.equal(enrollment.listeners(), 0, '2FA enrollment must not start the activity heartbeat');
await enrollment.tick();
assert.equal(enrollment.posts(), 0);

const disposed = harness();
disposed.cleanup();
assert.equal(disposed.listeners(), 0, 'Unmount must remove activity listeners');
await disposed.dispatch('keydown'); await disposed.tick();
assert.equal(disposed.posts(), 0, 'Unmount must stop the interval');

console.log('Idle timer checks passed: polling, input heartbeat, expiry, visibility, timeout updates, enrollment and cleanup.');
