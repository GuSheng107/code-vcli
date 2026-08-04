export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  delayMs: number,
  transform: (value: T, index: number) => Promise<R>,
  onComplete?: (result: R, index: number, completed: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      const result = await transform(value, index);
      results[index] = result;
      completed += 1;
      onComplete?.(result, index, completed);
      if (nextIndex < values.length && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker),
  );
  return results;
}
