const DRY_RUN = process.env.DRY_RUN === '1';

export async function getExecution(database, automation, sourceId, step) {
  const response = await database('checkpoint-get', { automation, sourceId, step });
  return response.execution ?? null;
}

export async function completeExecution(database, automation, sourceId, step, result = {}) {
  if (DRY_RUN) {
    console.log(`[dry-run] complete checkpoint: ${automation}/${sourceId}/${step}`);
    return;
  }
  await database('checkpoint-complete', { automation, sourceId, step, result });
}

export async function failExecution(database, automation, sourceId, step, errorValue) {
  if (DRY_RUN) {
    console.log(`[dry-run] fail checkpoint: ${automation}/${sourceId}/${step}: ${errorValue?.message ?? errorValue}`);
    return;
  }
  await database('checkpoint-fail', {
    automation,
    sourceId,
    step,
    error: String(errorValue?.message ?? errorValue),
  });
}

