/** Electron's stdio pipes are asynchronous: text written without waiting for its flush is
 * lost when the process exits, which reads in CI as a successful run with no result. */
export const emit = (stream: NodeJS.WriteStream, text: string) =>
  new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
  });
