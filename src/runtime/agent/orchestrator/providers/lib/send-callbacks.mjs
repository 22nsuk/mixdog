const functionOrNull = (value) => (typeof value === 'function' ? value : null);

/** The caller-supplied stream/stage hooks of a send, each a function or null. */
export function streamCallbacks(opts) {
  return {
    onStageChange: functionOrNull(opts.onStageChange),
    onStreamDelta: functionOrNull(opts.onStreamDelta),
    onToolCall: functionOrNull(opts.onToolCall),
    onTextDelta: functionOrNull(opts.onTextDelta),
    onTextReset: functionOrNull(opts.onTextReset),
  };
}
