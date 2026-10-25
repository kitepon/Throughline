// Product-owned vocabulary only. Never derive public diagnostics from an error,
// payload, path, thread identity, or arbitrary caller text.
export const RUNTIME_ERROR_CONTEXT_SCHEMA = 'throughline.runtime_error_context.v1';
const EVENTS = new Set(['unknown', 'stop', 'user-prompt-submit', 'post-tool-use', 'pre-compact']);
const STAGES = new Set(['arguments', 'payload', 'processing', 'handoff_request']);
const EFFECTS = new Set(['hook_exit_nonzero', 'continue_requested', 'stop_requested', 'unknown']);
const EXPECTED = Object.freeze({
  unknown: 'accept_valid_hook_input',
  stop: 'save_completed_turn',
  'user-prompt-submit': 'prepare_prompt_context',
  'post-tool-use': 'process_tool_completion',
  'pre-compact': 'request_handoff',
});
const BINDING_KEYS = ['fingerprint', 'count', 'first_seen', 'last_seen', 'product_version'];

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateRuntimeErrorContext(code, context) {
  if (code !== 'HOOK_CODEX_FAILED' || !exact(context, ['event', 'stage', 'effect'])
    || !EVENTS.has(context.event) || !STAGES.has(context.stage) || !EFFECTS.has(context.effect)
    || (context.stage === 'arguments' && context.event !== 'unknown')
    || (context.stage === 'handoff_request' && context.event !== 'pre-compact')
    || (context.stage !== 'handoff_request' && context.effect !== 'hook_exit_nonzero')) {
    throw new TypeError('runtime error context invalid');
  }
}

export function bindRuntimeErrorContext(record, context) {
  validateRuntimeErrorContext(record.error_code, context);
  return {
    schema: RUNTIME_ERROR_CONTEXT_SCHEMA,
    binding: Object.fromEntries(BINDING_KEYS.map((key) => [key, record[key]])),
    context: { ...context },
  };
}

export function validateRuntimeErrorContextState(value) {
  if (!exact(value, ['schema', 'binding', 'context']) || value.schema !== RUNTIME_ERROR_CONTEXT_SCHEMA
    || !exact(value.binding, BINDING_KEYS) || !/^[0-9a-f]{64}$/.test(value.binding.fingerprint)
    || !Number.isSafeInteger(value.binding.count) || value.binding.count < 1
    || ![value.binding.first_seen, value.binding.last_seen].every((v) =>
      typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
      && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    || value.binding.first_seen > value.binding.last_seen
    || typeof value.binding.product_version !== 'string' || value.binding.product_version.length < 1
    || value.binding.product_version.length > 128) {
    throw new Error('runtime error context state invalid');
  }
  validateRuntimeErrorContext('HOOK_CODEX_FAILED', value.context);
  return value;
}

export function runtimeErrorMessageWithContext(record, state) {
  if (!state || record.error_code !== 'HOOK_CODEX_FAILED') return record.message_template;
  validateRuntimeErrorContextState(state);
  // A later legacy/no-context writer, failed sidecar write, or reused aggregate
  // must never inherit a previous occurrence's description.
  if (!BINDING_KEYS.every((key) => state.binding[key] === record[key])) return record.message_template;
  const { event, stage, effect } = state.context;
  const expected = stage === 'arguments' ? 'parse_valid_arguments'
    : stage === 'payload' ? 'parse_valid_hook_json' : EXPECTED[event];
  const actual = stage === 'arguments' || stage === 'payload' ? 'input_rejected'
    : stage === 'handoff_request' ? 'handoff_request_failed' : 'hook_processing_failed';
  return `${record.message_template}. Latest occurrence only at ${record.last_seen}: operation=codex.${event}; expected=${expected}; actual=${actual}; effect=${effect}; user_impact=unknown; classification=diagnostic_only; prior_occurrences=uncharacterized.`;
}
