// Synthetic Apple account cards; no real account screenshots or addresses.
import assert from 'node:assert/strict';
import test from 'node:test';
import {extractOcrFields, applyOcrFields} from '../src/ocrFields.js';

const apple = {template:'apple', availableFields:['fullName', 'gender', 'birthday', 'passwordUpdatedAt', 'country', 'language', 'email', 'phone', 'loginPhones', 'verification', 'icloudAnalytics', 'hideMyEmail', 'paymentMethods', 'shippingAddress', 'familySharing', 'devices'], fieldLabels:{identifier:'Apple 账户', verification:'双重认证'}};
const line = (text, x, y, width=260) => ({text, confidence:95, bbox:{x0:x, y0:y, x1:x+width, y1:y+18}});
const card = (heading, values, x=100, y=100) => [line(heading, x, y), ...values.map((value, index) => line(value, x, y+30+index*24))];
const byKey = rows => Object.fromEntries(rows.map(row => [row.key, row.value]));
const extract = lines => extractOcrFields(lines, apple);

test('Apple email-and-phone summary identifies a single explicit email', () => {
  const rows = extract([
    ...card('电子邮件和电话号码', ['apple-owner@example.invalid'], 100, 100),
    ...card('密码', ['上次更新：2026年6月3日'], 500, 100),
  ]);
  assert.deepEqual(byKey(rows), {identifier:'apple-owner@example.invalid', passwordUpdatedAt:'2026-06-03'});
  assert.equal(applyOcrFields({}, rows).passwordUpdatedAt, '2026-06-03');
});

test('Multiple Apple emails are not arbitrarily assigned as the primary identifier', () => {
  assert.equal(byKey(extract(card('电子邮件和电话号码', ['first@example.invalid', 'second@example.invalid']))).identifier, undefined);
  assert.equal(byKey(extract([
    ...card('主要电子邮件地址', ['first@example.invalid'], 100, 100),
    ...card('主要电子邮件地址', ['second@example.invalid'], 500, 100),
  ])).identifier, undefined);
});

test('Password update requires its heading, complete year and a real date', () => {
  for (const value of ['上次更新：6月3日', '上次更新：June 3', '上次更新：2026年2月30日']) {
    assert.equal(byKey(extract(card('密码', [value]))).passwordUpdatedAt, undefined, value);
  }
  assert.equal(byKey(extract(card('App 专用密码', ['上次更新：2026年6月3日']))).passwordUpdatedAt, undefined);
  assert.equal(byKey(extract([
    line('密码', 100, 100), line('App 专用密码', 100, 128), line('上次更新：2026年6月3日', 100, 155),
  ])).passwordUpdatedAt, undefined, 'The intervening App password heading blocks the main-password date');
  assert.equal(byKey(extract([
    ...card('密码', ['查看详细信息'], 100, 100),
    ...card('App 专用密码', ['上次更新：2026年6月3日'], 500, 100),
  ])).passwordUpdatedAt, undefined, 'A neighboring card does not provide the password date');
});

test('Account-security summary signals enabled 2FA without treating a standalone title as status', () => {
  const rows = extract([
    ...card('账户安全', ['双重认证', '2 个受信任电话号码'], 100, 100),
    ...card('App 专用密码', ['查看详细信息'], 500, 100),
  ]);
  assert.deepEqual(byKey(rows), {verification:'twofactor'});
  assert.equal(byKey(extract([line('双重认证', 100, 100)])).verification, undefined);
  assert.equal(byKey(extract(card('双重认证', ['2 个受信任电话号码']))).verification, undefined);
  assert.equal(byKey(extract(card('2 个受信任电话号码', []))).phone, undefined);
});

test('Trusted-phone counts stay separate from explicit phone values', () => {
  const rows = extract(card('2 个受信任电话号码', ['+1 202 555 0100', '+1 202 555 0199']));
  assert.equal(byKey(rows).phone, '+1 202 555 0100\n+1 202 555 0199');
  assert.ok(!rows.some(row => row.value === '2'));
});

test('Apple privacy status is recorded only when explicit', () => {
  const rows = extract([
    ...card('性别', ['未选定'], 100, 100),
    ...card('iCloud 分析', ['关闭'], 500, 100),
    ...card('隐藏邮件地址', ['查看详细信息'], 100, 250),
  ]);
  assert.deepEqual(byKey(rows), {icloudAnalytics:'关闭'});
  assert.equal(applyOcrFields({}, rows).icloudAnalytics, '关闭');
});

test('Empty Apple payment, family, devices and privacy pages do not fabricate fields', () => {
  const rows = extract([
    ...card('付款与配送', ['No payment methods'], 100, 100),
    ...card('Shipping Address', ['No Delivery Address Set Up'], 500, 100),
    ...card('家庭', ['如何设置家人共享', '在 iPhone、iPad 或 iPod touch 上'], 100, 280),
    ...card('设备', ['没有设备'], 500, 280),
    ...card('隐藏邮件地址', ['查看详细信息'], 100, 460),
    ...card('性别', ['未选定'], 500, 460),
  ]);
  assert.deepEqual(rows, []);
});

test('Apple recognition preserves secrets and requires selected confirmation', () => {
  const rows = extract([
    ...card('密码', ['上次更新：2026年6月3日'], 100, 100),
    ...card('iCloud 分析', ['关闭'], 500, 100),
  ]);
  const form = {passwordUpdatedAt:'2020-01-01', icloudAnalytics:'开启', secrets:{password:'synthetic-secret'}, customFields:[{name:'keep', value:'synthetic', secret:true}]};
  const before = JSON.stringify(form);
  assert.deepEqual(applyOcrFields(form, rows.map(row => ({...row, selected:false}))), form);
  const applied = applyOcrFields(form, rows);
  assert.equal(applied.passwordUpdatedAt, '2026-06-03');
  assert.equal(applied.icloudAnalytics, '关闭');
  assert.equal(applied.secrets, form.secrets);
  assert.equal(applied.customFields, form.customFields);
  assert.equal(JSON.stringify(form), before);
});
