import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { createAppPrompt } from './app-prompt.ts';

const BOX = {
  type: 'info',
  message: 'What should closing the window do?',
  detail: 'Hiding to the tray keeps agents running.',
  buttons: ['OK', 'Cancel'],
  defaultId: 0,
  cancelId: 1,
};

function harness({ visible = true, ackMs = 50 } = {}) {
  const ipcMain = new EventEmitter();
  const sent = [];
  const webContents = {
    isLoading: () => false,
    isCrashed: () => false,
    send: (channel, prompt) => sent.push({ channel, prompt }),
  };
  const window = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isVisible: () => visible,
  });
  const fallbacks = [];
  const prompt = createAppPrompt({
    getWindow: () => window,
    ipcMain,
    fallback: (options) => {
      fallbacks.push(options);
      return Promise.resolve({ response: 0, checkboxChecked: false });
    },
    ackMs,
  });
  const answer = (id, state, sender = webContents) => ipcMain.emit(DESKTOP_IPC.appPromptAnswer, { sender }, id, state);
  return { prompt, sent, fallbacks, answer, window };
}

test('a hidden window answers with the native box', async () => {
  const { prompt, sent, fallbacks } = harness({ visible: false });
  assert.deepEqual(await prompt.show(BOX), { response: 0, checkboxChecked: false });
  assert.equal(sent.length, 0);
  assert.equal(fallbacks.length, 1);
});

test('the renderer dialog answers once it acknowledges', async () => {
  const { prompt, sent, fallbacks, answer } = harness();
  const result = prompt.show(BOX);
  assert.equal(sent[0].channel, DESKTOP_IPC.appPrompt);
  assert.equal(sent[0].prompt.title, BOX.message);
  assert.equal(sent[0].prompt.confirmLabel, 'OK');
  answer(sent[0].prompt.id, 'shown');
  await new Promise((resolve) => setTimeout(resolve, 80));
  answer(sent[0].prompt.id, 'cancel', {});
  answer(sent[0].prompt.id, 'confirm');
  assert.deepEqual(await result, { response: 0, checkboxChecked: false });
  assert.equal(fallbacks.length, 0);
});

test('a cancel resolves to the cancel button', async () => {
  const { prompt, sent, answer } = harness();
  const result = prompt.show(BOX);
  answer(sent[0].prompt.id, 'shown');
  answer(sent[0].prompt.id, 'cancel');
  assert.equal((await result).response, 1);
});

test('a three-button box offers an alternate answer; the X still cancels', async () => {
  const box = { ...BOX, buttons: ['Hide to tray', 'Quit completely', 'Cancel'], cancelId: 2 };
  for (const [state, response] of [
    ['alternate', 1],
    ['cancel', 2],
  ]) {
    const { prompt, sent, answer } = harness();
    const result = prompt.show(box);
    assert.equal(sent[0].prompt.alternateLabel, 'Quit completely');
    answer(sent[0].prompt.id, 'shown');
    answer(sent[0].prompt.id, state);
    assert.equal((await result).response, response);
  }
});

test('an unacknowledged prompt falls back to the native box', async () => {
  const { prompt, fallbacks } = harness({ ackMs: 10 });
  assert.equal((await prompt.show(BOX)).response, 0);
  assert.equal(fallbacks.length, 1);
});

test('closing the window cancels an open prompt', async () => {
  const { prompt, sent, answer, window } = harness();
  const result = prompt.show(BOX);
  answer(sent[0].prompt.id, 'shown');
  window.emit('closed');
  assert.equal((await result).response, 1);
});
