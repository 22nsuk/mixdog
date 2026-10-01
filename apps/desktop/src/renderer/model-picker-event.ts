// Asks the focused conversation's composer route picker to open on its model
// pane. The listener calls preventDefault() to claim the request; the return
// value tells the caller whether anything handled it.
export const OPEN_MODEL_PICKER_EVENT = 'mixdog:open-model-picker';

export function requestOpenModelPicker(): boolean {
  return !window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER_EVENT, { cancelable: true }));
}
