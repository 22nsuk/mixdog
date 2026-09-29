import assert from 'node:assert/strict';
import test from 'node:test';

import {
  automationFastSuffix,
  automationProjectOptions,
  automationWorkflowOptions,
  splitModelRoute,
} from './automation-editor-support.ts';

test('the +fast suffix needs fast support for the current effort, not just a fast-capable model', () => {
  const model = { fastCapable: true, fastEfforts: ['high'] };
  assert.equal(automationFastSuffix(model, 'high', {}, true), '+fast');
  assert.equal(automationFastSuffix(model, 'low', {}, true), '');
  assert.equal(automationFastSuffix(model, 'high', {}, false), '');
  assert.equal(automationFastSuffix(undefined, 'high', {}, true), '');
});

test('a model route splits at its first slash and a bare id has no provider', () => {
  assert.deepEqual(splitModelRoute('openrouter/vendor/model'), { provider: 'openrouter', id: 'vendor/model' });
  assert.deepEqual(splitModelRoute('bare-model'), { provider: '', id: '' });
  assert.deepEqual(splitModelRoute(''), { provider: '', id: '' });
});

test('project options lead with none, prefer alias over name, and keep an unlisted cwd selectable', () => {
  const projects = [
    { path: '/a', name: 'alpha', alias: ' Alias ' },
    { path: '/b', name: ' beta ', alias: '' },
    { path: '/c', name: '', alias: '' },
  ];
  assert.deepEqual(automationProjectOptions(projects, '/b'), [
    { value: '__none__', label: 'No project' },
    { value: '/a', label: 'Alias' },
    { value: '/b', label: 'beta' },
    { value: '/c', label: '/c' },
  ]);
  assert.deepEqual(automationProjectOptions([], '/gone').at(-1), { value: '/gone', label: '/gone' });
  assert.equal(automationProjectOptions([], '').length, 1);
});

test('workflow options fall back to the id for a label and drop rows without one', () => {
  assert.deepEqual(automationWorkflowOptions([{ id: 'default', name: 'Default' }, { id: 'x' }, { name: 'orphan' }]), [
    { value: 'default', label: 'Default' },
    { value: 'x', label: 'x' },
  ]);
});
