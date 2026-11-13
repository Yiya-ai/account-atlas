// Render the actual forms without opening a browser or reading a real vault.
import assert from 'node:assert/strict';
import {readFile, writeFile, unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {fieldEnabled, verificationOptions, mergePlatformFields} from '../src/accountFields.js';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(frontend, '..');
const python = process.env.ATLAS_TEST_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const config = spawnSync(python, ['-c', 'import json; from backend.vault import empty_vault, platform_config, FIELD_LABELS; print(json.dumps({"platforms":[platform_config(p) for p in empty_vault()["platforms"]],"fieldCatalog":FIELD_LABELS}))'], {cwd:root, encoding:'utf8'});
assert.equal(config.status, 0, config.stderr);
const state = {...JSON.parse(config.stdout), accounts:[], groups:[], revision:0};
const apple = state.platforms.find(p => p.template === 'apple');
const google = state.platforms.find(p => p.template === 'google');
const blank = {secrets:{}, loginMethod:'password', verification:'none'};
for (const key of ['totp', 'googlePrompt', 'recoveryCodes', 'loginMethod', 'linkedAccount', 'passkeys', 'homeAddress', 'workAddress']) {
  assert.equal(fieldEnabled(apple, blank, key, true), false, `Apple optional fields must omit ${key}`);
}
assert.equal(fieldEnabled(apple, {...blank, googlePrompt:'Synthetic legacy note'}, 'googlePrompt'), true);
assert.equal(fieldEnabled(apple, {...blank, secrets:{totp:'JBSWY3DPEHPK3PXP'}}, 'totp'), true);
assert.equal(fieldEnabled(google, blank, 'totp'), true);
assert.deepEqual(Object.keys(verificationOptions(apple, 'none')), ['none','twofactor','disabled']);
assert.match(verificationOptions(apple, 'totp').totp, /历史记录/);
// Clearing a legacy field must not unmount it before the replacement can be typed.
assert.equal(fieldEnabled(apple, {...blank, googlePrompt:''}, 'googlePrompt', false, ['googlePrompt']), true);
assert.equal(fieldEnabled(apple, {...blank, secrets:{totp:''}}, 'totp', false, ['totp']), true);
assert.equal(fieldEnabled(apple, {...blank, secrets:{password:'synthetic'}}, 'totp', false, ['password']), false);
const publicFields = [{name:'Shared', value:'SYNTHETIC_VALUE', secret:false}];
const merged = mergePlatformFields(publicFields, [{name:'shared', secret:true, enabled:false}, {name:'Extra', secret:false, enabled:true}]);
assert.equal(merged.length, 2);
assert.equal(merged[0].value, 'SYNTHETIC_VALUE');
assert.equal(merged[0].secret, true);
assert.equal(publicFields[0].secret, false);
assert.equal(mergePlatformFields(merged, [{name:'Shared', secret:false, enabled:true}])[0].secret, true);

const source = await readFile(path.join(frontend, 'src/main.jsx'), 'utf8');
const mount = "createRoot(document.getElementById('root')).render(<App/>);";
assert.ok(source.includes(mount));
const result = await build({stdin:{contents:source.replace(mount, 'export {AccountEditor, PlatformManager};'), resolveDir:path.join(frontend, 'src'), loader:'jsx'}, bundle:true, platform:'node', format:'esm', packages:'external', write:false, loader:{'.css':'empty'}, define:{'import.meta.env':'{}'}});
const output = path.join(frontend, `.apple-form-check-${process.pid}.mjs`);
try {
  await writeFile(output, result.outputFiles[0].text);
  const {AccountEditor, PlatformManager} = await import(pathToFileURL(output).href);
  const html = renderToStaticMarkup(React.createElement(AccountEditor, {state, defaultPlatform:'apple'}));
  for (const label of ['Apple 账户（主要邮箱或电话号码）', '其他电子邮件地址', '受信任电话号码', '出生日期', '双重认证', '实体安全密钥', 'App 专用密码']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('连续输入 6～8 位数字'));
  assert.ok(html.includes('type="date"') && html.includes('max="9999-12-31"'), 'Keep a bounded native calendar picker');
  for (const label of ['Google 提示', '身份验证器', '恢复码 / 备用码', '关联已有账号', '工作地址', '付款方式备注', '（历史补充）']) assert.ok(!html.includes(label), label);
  const manager = renderToStaticMarkup(React.createElement(PlatformManager, {state, initialId:'apple'}));
  for (const label of ['付款方式备注', '配送地址', '家人共享', '隐藏邮件地址', 'iCloud 分析', '性别']) assert.ok(manager.includes(label), label);
  for (const label of ['Google 提示', 'TOTP 密钥', '恢复码 / 备用码', '安全问题 1']) assert.ok(!manager.includes(label), label);
  const fullState = {...state, platforms:state.platforms.map(p => p.id === 'apple' ? {...p, fields:p.availableFields} : p)};
  const full = renderToStaticMarkup(React.createElement(AccountEditor, {state:fullState, defaultPlatform:'apple'}));
  for (const label of ['付款与配送', '订阅与家庭', '关联设备', '隐藏邮件地址', 'iCloud 分析']) assert.ok(full.includes(label), label);
  assert.equal((full.match(/<span>性别<\/span>/g) || []).length, 1);
  assert.ok(!full.includes('Google 提示'));
  console.log('Apple form render, optional fields, platform settings and legacy compatibility checks passed.');
} finally {
  await unlink(output).catch(() => {});
}
