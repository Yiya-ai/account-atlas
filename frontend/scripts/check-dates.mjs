import assert from 'node:assert/strict';
import {dateCandidates, displayDate, normalizeDateInput} from '../src/calendarDate.js';

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
for (const [value, expected] of Object.entries({19210101:'1921-01-01', 192111:'1921-01-01', 1921011:'1921-01-01', 1921101:'1921-10-01', 1921054:'1921-05-04', 1921131:'1921-01-31'})) {
  assert.equal(normalizeDateInput(value), expected, value);
}
assert.deepEqual(dateCandidates('1921125'), ['1921-12-05', '1921-01-25']);
assert.equal(normalizeDateInput('1921125'), null, 'Ambiguous dates require a choice');
assert.equal(normalizeDateInput('192101011'), null);
assert.equal(normalizeDateInput('19210/01/01'), null);
assert.equal(normalizeDateInput('1921201'), '1921-02-01');
assert.equal(normalizeDateInput('1921301'), '1921-03-01');
assert.equal(normalizeDateInput('1921909'), '1921-09-09');
assert.equal(displayDate('1921-01-01'), '1921/01/01');
assert.equal(displayDate('192101'), '192101');
console.log('Date input normalization and calendar validation passed.');
