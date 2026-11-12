import assert from 'node:assert/strict';
import {normalizeDateInput} from '../src/calendarDate.js';

for (const value of ['19940601', '1994-06-01', '1994/6/1', '1994年6月1日', ' 1994-6-1 ']) {
  assert.equal(normalizeDateInput(value), '1994-06-01', value);
}
for (const value of ['199406', '199406-01-01', '1994-02-29', '1900-02-29', '2000-13-01', '2000-00-01', '2000-01-00', '2000-04-31', '0000-01-01', '2024-W01-1', 'abc']) {
  assert.equal(normalizeDateInput(value), null, value);
}
assert.equal(normalizeDateInput('20000229'), '2000-02-29');
assert.equal(normalizeDateInput('2024-2-29'), '2024-02-29');
assert.equal(normalizeDateInput(''), '');
assert.equal(normalizeDateInput('  '), '');
console.log('Date input normalization and calendar validation passed.');
