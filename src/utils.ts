interface Hunk {
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
export function unescapeNewlinesInText(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  // Create a deep clone to avoid modifying the original object
  const clonedObj = JSON.parse(JSON.stringify(obj));

  function recurse(current: any) {
    if (typeof current === 'object' && current !== null) {
      for (const key in current) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          if (key === 'text' && typeof current[key] === 'string') {
            current[key] = current[key].replace(/\\n/g, '\n');
          } else {
            recurse(current[key]);
          }
        }
      }
    }
  }

  recurse(clonedObj);
  return clonedObj;
}
