import { readState, writeState, statePath } from './storage.js';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const relationship = context => ({
  relationship_permission: context?.relationship?.established ? 'established' : 'not_established',
  relationship_mode: context?.relationship?.mode || null,
  current_permissions: Array.isArray(context?.consent_profile?.current_permissions)
    ? context.consent_profile.current_permissions
    : [],
  revocable: context?.consent_profile?.revocable === true,
});

const result = ({ record, state, didMutate, mutationReason, incomingStateDiffIgnored }) => ({
  state,
  relationship: record?.relationship || null,
  did_mutate_yuki_state: didMutate,
  mutation_reason: mutationReason,
  incoming_state_diff_ignored: incomingStateDiffIgnored,
  state_pathname: statePath(record?.profile_id || ''),
});

export async function resolveState(profile, incoming, context, transition, requestId) {
  const now = new Date().toISOString();
  const existing = await readState(profile);

  if (!existing) {
    const record = {
      schema_version: '1.1',
      profile_id: profile,
      created_at: now,
      updated_at: now,
      persist_until: 'explicit_change',
      authority: 'session_relationship_state',
      authority_scope: 'relationship_and_consent_context_only',
      file_authority: 'none',
      state: incoming,
      relationship: relationship(context),
      last_transition: {
        type: 'initialize',
        request_id: requestId,
        reason: 'first_persistent_state',
      },
    };
    await writeState(profile, record);
    return result({
      record,
      state: record.state,
      didMutate: true,
      mutationReason: 'initialize_persistent_state',
      incomingStateDiffIgnored: false,
    });
  }

  if (transition?.action === 'replace') {
    const next = {
      ...existing,
      updated_at: now,
      state: incoming,
      relationship: relationship(context),
      last_transition: {
        type: 'explicit_replace',
        request_id: requestId,
        reason: transition.reason || 'explicit_state_transition',
      },
    };
    const mut = !same(existing.state, incoming) || !same(existing.relationship, next.relationship);
    if (mut) await writeState(profile, next);
    return result({
      record: mut ? next : existing,
      state: mut ? next.state : existing.state,
      didMutate: mut,
      mutationReason: mut ? 'explicit_state_transition' : 'explicit_transition_no_change',
      incomingStateDiffIgnored: false,
    });
  }

  return result({
    record: existing,
    state: existing.state,
    didMutate: false,
    mutationReason: 'preserve_existing_state',
    incomingStateDiffIgnored: !same(existing.state, incoming),
  });
}
