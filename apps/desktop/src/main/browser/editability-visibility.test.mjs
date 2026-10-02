import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { BROWSER_EDITABILITY_CHECK } from './editability.ts';

test('hidden ancestors and shadow hosts cannot be filled despite the input own display', () => {
  const dom = new JSDOM('<div id="parent" style="display:none"><input value="original"></div>', {
    runScripts: 'outside-only',
  });
  try {
    const { window } = dom;
    const check = window.eval(`(${BROWSER_EDITABILITY_CHECK})`);
    const parent = window.document.querySelector('#parent');
    const input = parent.querySelector('input');
    assert.notEqual(window.getComputedStyle(input).display, 'none');
    assert.equal(check(input), 'element is hidden');
    assert.equal(input.value, 'original');
    parent.style.display = 'block';
    assert.equal(check(input), '');
    const shadow = parent.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input value="shadow-original">';
    parent.style.display = 'none';
    assert.equal(check(shadow.querySelector('input')), 'element is hidden');
    parent.style.display = 'block';
    assert.equal(check(shadow.querySelector('input')), '');
  } finally {
    dom.window.close();
  }
});

test('a visible descendant of visibility:hidden remains editable, but inert and disabled do not', () => {
  const dom = new JSDOM('<div style="visibility:hidden"><input style="visibility:visible"></div>', {
    runScripts: 'outside-only',
  });
  try {
    const check = dom.window.eval(`(${BROWSER_EDITABILITY_CHECK})`);
    const input = dom.window.document.querySelector('input');
    assert.equal(check(input), '');
    input.parentElement.setAttribute('inert', '');
    assert.equal(check(input), 'element is disabled');
    input.parentElement.removeAttribute('inert');
    input.disabled = true;
    assert.equal(check(input), 'element is disabled');
  } finally {
    dom.window.close();
  }
});
