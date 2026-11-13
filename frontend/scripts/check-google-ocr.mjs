// Synthetic fixtures only: never copy account details from user screenshots.
import assert from 'node:assert/strict';
import test from 'node:test';
import {extractOcrFields, applyOcrFields} from '../src/ocrFields.js';

const google = {template:'google', availableFields:['fullName', 'gender', 'birthday', 'language', 'email', 'phone', 'recoveryEmail', 'verification', 'passkeys'], fieldLabels:{verification:'两步验证方式'}};
const line = (text, y, x=150) => ({text, confidence:94, bbox:{x0:x, y0:y, x1:x+300, y1:y+18}});
const cards = entries => entries.flatMap(([label, ...values], index) => [line(label, index*120), ...values.map((value, i) => line(value, index*120+30+i*24))]);
const extract = entries => extractOcrFields(cards(entries), google);
const byKey = rows => Object.fromEntries(rows.map(row => [row.key, row.value]));

test('Google profile maps named fields and does not choose a login email arbitrarily', () => {
  const rows = extract([
    ['Name', 'Mira Example'], ['Gender', 'Female'], ['Email', 'primary@example.invalid', 'other@example.invalid'],
    ['Phone', 'Add a recovery phone to help keep your account secure'], ['Birthday', 'June 17, 1985'],
    ['Language', 'English (United States)'], ['Home address', 'Not set'], ['Work address', 'Not set'],
    ['Google Password', 'Last changed Sep 18'],
  ]);
  assert.deepEqual(byKey(rows), {fullName:'Mira Example', gender:'女', birthday:'1985-06-17', language:'English (United States)', email:'primary@example.invalid\nother@example.invalid'});
});

test('English birthdays require a real date and an explicit four-digit year', () => {
  assert.equal(byKey(extract([['Birthday', 'February 29, 2000']])).birthday, '2000-02-29');
  for (const value of ['February 29, 1900', 'June 31, 1985', 'June 17', 'June 17, 85', 'February 30, 2000']) {
    assert.equal(byKey(extract([['Birthday', value]])).birthday, undefined, value);
  }
});

test('Damaged email remains reviewable without silently repairing its domain', () => {
  const rows = extract([['Email', 'owner@example invalid', 'second@example.invalid']]);
  const email = rows.find(row => row.key === 'email');
  assert.ok(email, 'Show an editable candidate rather than dropping the damaged address');
  assert.equal(email.value, 'owner@example invalid\nsecond@example.invalid');
  assert.ok(typeof email.warning === 'string' && email.warning.length > 0);
  const form = {email:'keep@example.invalid', identifier:'existing@example.invalid'};
  assert.deepEqual(applyOcrFields(form, [email]), form, 'Reject malformed selected values until the user corrects them');
  assert.equal(applyOcrFields(form, [{...email, value:'owner@example.invalid\nsecond@example.invalid'}]).email, 'owner@example.invalid\nsecond@example.invalid');
  assert.equal(byKey(rows).identifier, undefined);
});

test('Recovery email keeps the unverified warning and is not a login identifier', () => {
  const rows = extract([['Recovery email', '@ Verify recovery@example.invalid']]);
  const recovery = rows.find(row => row.key === 'recoveryEmail');
  assert.equal(recovery?.value, 'recovery@example.invalid');
  assert.ok(typeof recovery.warning === 'string' && recovery.warning.length > 0);
  assert.equal(byKey(rows).identifier, undefined);
  assert.equal(applyOcrFields({}, [recovery]).recoveryEmail, 'recovery@example.invalid');
});

test('Google enabled verification accepts the observed icon and joined-word OCR noise', () => {
  assert.equal(byKey(extract([['2-Step Verification', '@ Onsince Sep 18']])).verification, 'twofactor');
  assert.equal(byKey(extract([['2-Step Verification', 'Off']])).verification, 'disabled');
});

test('Authenticator is a method only when enabled verification is also explicit', () => {
  const rows = extract([['2-Step Verification', '@ Onsince Sep 18'], ['Authenticator', 'Added Sep 18']]);
  assert.equal(byKey(rows).verification, 'totp');
  assert.equal(applyOcrFields({}, rows).verification, 'totp');
  assert.ok(rows.every(row => !['totp', 'secrets', 'password', 'recoveryCodes'].includes(row.key)), 'Never invent a secret from setup status');
  assert.equal(byKey(extract([['Authenticator', 'Added Sep 18']])).verification, undefined);
  assert.equal(byKey(extract([['2-Step Verification', 'Off'], ['Authenticator', 'Added Sep 18']])).verification, 'disabled');
});

test('Unrelated On labels and empty settings do not supply security facts', () => {
  const rows = extract([
    ['2-Step Verification'], ['Skip password when possible', 'On'], ['Authenticator', 'Add authenticator'],
    ['Recovery phone', 'Add a mobile phone number'], ['Recovery email', 'Add recovery email'],
    ['Password', 'Last changed Sep 18'],
  ]);
  assert.deepEqual(rows, []);
  assert.deepEqual(extract([['Skip password when possible', 'On']]), []);
  assert.deepEqual(extractOcrFields([line('2-Step Verification', 0), line('Skip password when possible', 28), line('On', 55)], google), [], 'A nearby On belongs to its own heading');
});

test('Unsupported security and profile headings block lookahead', () => {
  const blocked = (label, boundary, value) => byKey(extractOcrFields([line(label, 0), line(boundary, 28), line(value, 55)], google));
  assert.equal(blocked('Name', 'Google Password', 'Synthetic Secret').fullName, undefined);
  assert.equal(blocked('Email', 'Password', 'secret@example.invalid').email, undefined);
  assert.equal(blocked('Birthday', 'Password', 'June 17, 1985').birthday, undefined);
});

test('Confirmation preserves existing fields and never writes secret/custom content', () => {
  const form = {fullName:'Existing Name', birthday:'1990-01-01', verification:'none', secrets:{password:'synthetic'}, customFields:[{name:'keep', value:'synthetic', secret:true}]};
  const before = JSON.stringify(form);
  const rows = extract([['Gender', 'Female'], ['Birthday', 'June 17, 1985']]);
  assert.deepEqual(applyOcrFields(form, rows.map(row => ({...row, selected:false}))), form);
  const result = applyOcrFields(form, rows);
  assert.equal(result.gender, '女');
  assert.equal(result.birthday, '1985-06-17');
  assert.equal(result.fullName, form.fullName);
  assert.equal(result.secrets, form.secrets);
  assert.equal(result.customFields, form.customFields);
  assert.equal(JSON.stringify(form), before);
});
