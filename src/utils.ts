export interface Hunk {
  file: string;
  header: string;
  content: string;
  added: number;
  removed: number;
  bytes: number;
  score: number;
}

export function fileImportanceWeight(file: string): number {
  if (!file) return 0;
  const lower = file.toLowerCase();
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.svelte')
  ) {
    return 10;
  }
  if (lower.endsWith('.html') || lower.endsWith('.hbs') || lower.endsWith('.njk')) return 6;
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.sass')) return 4;
  if (/\.(png|jpg|jpeg|gif|ico|svg)$/.exec(lower)) return 0;
  return 1;
}

export function pushHunkToTop(array: Hunk[], hunk: Hunk, maxSize: number): void {
  if (array.length < maxSize) {
    array.push(hunk);
    return;
  }
  let minIdx = 0;
  for (let i = 1; i < array.length; i += 1) if (array[i].score < array[minIdx].score) minIdx = i;
  if (hunk.score > array[minIdx].score) array[minIdx] = hunk;
}

// Minimal p-limit implementation (small, dependency-free)
// Usage: const limit = pLimit(concurrency); await Promise.all(items.map(item => limit(() => doWork(item))));
// (No concurrency helper; simplified, serial processing is used in summarizer)

// Helper function to recursively unescape '\n' in 'text' fields
export function unescapeNewlinesInText(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  // Create a deep clone to avoid modifying the original object
  const clonedObj = JSON.parse(JSON.stringify(obj));

  function recurse(current: unknown) {
    if (typeof current === 'object' && current !== null) {
      for (const key in current as Record<string, unknown>) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          const val = (current as Record<string, unknown>)[key];
          if (key === 'text' && typeof val === 'string') {
            (current as Record<string, unknown>)[key] = val.replace(/\\n/g, '\n');
          } else {
            recurse(val);
          }
        }
      }
    }
  }

  recurse(clonedObj);
  return clonedObj;
}
