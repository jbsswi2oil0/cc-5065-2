import test from 'node:test';
import assert from 'node:assert/strict';
import { runValidation, validateBrightness } from '../src/core/validation.js';

test('MIS weights normalize and accepted connections have positive weights', () => {
  const result = runValidation();
  for (const check of result.checks) {
    if (check.name.startsWith('MIS')) {
      assert.equal(check.pass, true, `${check.name}: ${JSON.stringify(check)}`);
      assert.ok(check.maxSumError < 1e-10);
      assert.equal(check.zeroActualWeight, 0);
    }
  }
});

test('vertex density records contain finite forward/reverse values', () => {
  const result = runValidation();
  for (const check of result.checks) {
    if (check.name.startsWith('forward/reverse')) {
      assert.equal(check.pass, true, `${check.name}: ${JSON.stringify(check)}`);
    }
  }
});

test('visibility kernel detects blocker', () => {
  const result = runValidation();
  const visibility = result.checks.find((c) => c.name.includes('visibility'));
  assert.equal(visibility.pass, true);
});

test('specular chains are rejected as arbitrary connection endpoints', () => {
  const result = runValidation();
  const check = result.checks.find((c) => c.name.includes('specular endpoints'));
  assert.equal(check.pass, true, JSON.stringify(check));
  assert.ok(check['camera-end-specular-not-connectible'] > 0);
  assert.ok(check['light-end-specular-not-connectible'] > 0);
});

test('weighted strategy buffers partition beauty without extra accumulation', () => {
  const result = runValidation();
  for (const check of result.checks.filter((c) => c.name.startsWith('strategy buffers partition'))) {
    assert.equal(check.pass, true, `${check.name}: rel=${check.maxRelativeError}`);
    assert.ok(check.maxRelativeError < 1e-10);
  }
});

test('BDPT and unidirectional PT brightness agree within Monte Carlo tolerance', { timeout: 120000 }, () => {
  const checks = validateBrightness();
  for (const c of checks) {
    assert.equal(c.pass, true, `${c.name}: ratio=${c.ratio}`);
  }
});
