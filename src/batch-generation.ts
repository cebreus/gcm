interface CommitBatchResult {
  completed: string[];
  skipped: string[];
  failed: string | null;
}

export async function runCommitBatch(params: {
  targets: string[];
  initialHead: string;
  getHead: () => Promise<string>;
  hasAmendment: (hash: string) => Promise<boolean>;
  runOne: (hash: string) => Promise<boolean>;
  report: (message: string) => void;
}): Promise<CommitBatchResult> {
  const { targets, initialHead, getHead, hasAmendment, runOne, report } =
    params;
  const result: CommitBatchResult = {
    completed: [],
    skipped: [],
    failed: null,
  };
  let expectedHead = initialHead;

  for (let index = 0; index < targets.length; index += 1) {
    const [hash] = targets.slice(index, index + 1);
    // eslint-disable-next-line no-await-in-loop -- batch must detect HEAD changes before each ordered commit
    const currentHead = await getHead();
    if (currentHead !== expectedHead) {
      report(`HEAD moved unexpectedly before ${hash}.`);
      result.failed = hash;
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- each ordered target requires its own amendment check
    if (await hasAmendment(hash)) {
      result.skipped.push(hash);
      report(
        `[${index + 1}/${targets.length}] Skipping ${hash}: amend! already exists.`,
      );
      continue;
    }
    report(`[${index + 1}/${targets.length}] Processing ${hash}.`);
    // eslint-disable-next-line no-await-in-loop -- commits must run sequentially because each commit changes HEAD
    if (!(await runOne(hash))) {
      result.failed = hash;
      break;
    }
    result.completed.push(hash);
    // eslint-disable-next-line no-await-in-loop -- next target must use HEAD produced by current commit
    expectedHead = await getHead();
  }

  return result;
}
