export interface CommitBatchResult {
  completed: string[];
  skipped: string[];
  failed: string | null;
}

export async function runCommitBatch(params: {
  targets: string[];
  initialHead: string;
  getHead(): Promise<string>;
  hasAmendment(hash: string): Promise<boolean>;
  runOne(hash: string, index: number, total: number): Promise<boolean>;
  report(message: string): void;
}): Promise<CommitBatchResult> {
  const { targets, initialHead, getHead, hasAmendment, runOne, report } = params;
  const result: CommitBatchResult = { completed: [], skipped: [], failed: null };
  let expectedHead = initialHead;

  for (let index = 0; index < targets.length; index += 1) {
    const hash = targets[index];
    if (!hash) continue;
    const currentHead = await getHead();
    if (currentHead !== expectedHead) {
      report(`HEAD moved unexpectedly before ${hash}.`);
      result.failed = hash;
      break;
    }
    if (await hasAmendment(hash)) {
      result.skipped.push(hash);
      report(`[${index + 1}/${targets.length}] Skipping ${hash}: amend! already exists.`);
      continue;
    }
    report(`[${index + 1}/${targets.length}] Processing ${hash}.`);
    if (!(await runOne(hash, index, targets.length))) {
      result.failed = hash;
      break;
    }
    result.completed.push(hash);
    expectedHead = await getHead();
  }

  return result;
}
