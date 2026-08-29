const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../lib/utils');

test('normalizePhone converts Nigerian local numbers to WhatsApp format', () => {
  assert.equal(normalizePhone('08012345678'), '2348012345678');
  assert.equal(normalizePhone('+2348012345678'), '2348012345678');
  assert.equal(normalizePhone('2348012345678'), '2348012345678');
  assert.equal(normalizePhone('080 123 456 78'), '2348012345678');
});

test('normalizePhone leaves empty input empty', () => {
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone(null), '');
});
