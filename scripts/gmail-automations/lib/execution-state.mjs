export async function getExecution(supabase, automation, sourceId, step) {
  const { data, error } = await supabase
    .from('automation_executions')
    .select('status, attempt_count, result, last_error')
    .eq('automation', automation)
    .eq('source_id', sourceId)
    .eq('step', step)
    .maybeSingle();
  if (error) throw new Error(`reading automation checkpoint failed: ${error.message}`);
  return data;
}

export async function completeExecution(supabase, automation, sourceId, step, result = {}) {
  const existing = await getExecution(supabase, automation, sourceId, step);
  const now = new Date().toISOString();
  const { error } = await supabase.from('automation_executions').upsert({
    automation,
    source_id: sourceId,
    step,
    status: 'completed',
    attempt_count: (existing?.attempt_count ?? 0) + 1,
    result,
    last_error: null,
    last_attempted_at: now,
    completed_at: now,
  });
  if (error) throw new Error(`writing automation checkpoint failed: ${error.message}`);
}

export async function failExecution(supabase, automation, sourceId, step, errorValue) {
  const existing = await getExecution(supabase, automation, sourceId, step);
  const { error } = await supabase.from('automation_executions').upsert({
    automation,
    source_id: sourceId,
    step,
    status: 'failed',
    attempt_count: (existing?.attempt_count ?? 0) + 1,
    result: existing?.result ?? {},
    last_error: String(errorValue?.message ?? errorValue),
    last_attempted_at: new Date().toISOString(),
    completed_at: null,
  });
  if (error) throw new Error(`recording automation failure failed: ${error.message}`);
}

