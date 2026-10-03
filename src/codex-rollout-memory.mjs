import { readFileSync } from 'node:fs';

import { defaultCodexHome, findCodexThreadCandidate } from './codex-thread-index.mjs';
import { estimateTokens } from './token-estimator.mjs';

const DEFAULT_PREVIEW_MAX_CHARS = 8_000;
const MAX_ENTRY_CHARS = 900;
const MAX_RECENT_ENTRIES = 40;

export function buildCodexRolloutTrimSource({
  threadId,
  codexHome = defaultCodexHome(),
  projectPath = process.cwd(),
  previewMaxChars = DEFAULT_PREVIEW_MAX_CHARS,
  sourceReason = 'explicit_codex_thread_rollout',
} = {}) {
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('threadId is required');
  }

  const candidate = findCodexThreadCandidate({
    threadId,
    codexHome,
    projectPath,
    requireProjectMatch: true,
  });
  if (!candidate) return null;

  const parsed = parseCodexRolloutFile(candidate.rolloutPath, { includeInFlightTurn: false });
  const memoryPreview = renderCodexRolloutMemoryPreview({
    candidate,
    parsed,
    previewMaxChars,
  });

  return {
    source: 'codex-rollout',
    sourceReason,
    threadId,
    rolloutPath: candidate.rolloutPath,
    projectPath: candidate.cwd ?? projectPath,
    capturedTurns: parsed.activeTurnCount,
    memoryPreview,
    stats: parsed.stats,
    restoreSafety: parsed.restoreSafety,
    contextEstimate: buildCodexContextEstimate(parsed),
  };
}

export function parseCodexRolloutFile(
  path,
  { includeRestoreIndex = false, includeInFlightTurn = true } = {},
) {
  const activeTurns = [];
  let openTurn = null;
  let postRollbackTurn = null;
  let afterRollback = false;
  let pendingMessages = [];
  let pendingDetails = [];
  const toolNameByCallId = new Map();
  const compactedReplacementUserTexts = new Map();
  const rolledBackUserTexts = new Map();
  const resurrectedUserTexts = new Map();
  const stats = {
    parsedRows: 0,
    corruptRows: 0,
    compactedRows: 0,
    compactedReplacementUserMessages: 0,
    taskStarted: 0,
    taskComplete: 0,
    rollbackEvents: 0,
    rolledBackTurns: 0,
    rolledBackUserMessages: 0,
    userMessagesAfterRollback: 0,
    latestRollbackAt: null,
    rollbackTextRetainedInCompacted: 0,
    resurrectedUserMessages: 0,
    injectedDeveloperMessages: 0,
    syntheticContinuationTurns: 0,
    toolInputs: 0,
    toolOutputs: 0,
    skippedMessages: 0,
    inFlightTurnsExcluded: 0,
  };

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
      stats.parsedRows++;
    } catch {
      stats.corruptRows++;
      continue;
    }

    const payload = row?.payload;
    if (row?.type === 'compacted') {
      stats.compactedRows++;
      const userMessages = compactedPayloadToUserMessages(payload, row.timestamp);
      stats.compactedReplacementUserMessages += userMessages.length;
      for (const message of userMessages) {
        incrementTextMap(compactedReplacementUserTexts, message.text);
      }
      continue;
    }

    if (row?.type === 'response_item') {
      const responseMessage = responseItemToConversationMessage(payload, row.timestamp);
      if (responseMessage?.role === 'user') {
        if (stats.rollbackEvents > 0) {
          stats.userMessagesAfterRollback++;
        }
        notePotentialResurrectedUserMessage({
          message: responseMessage,
          compactedReplacementUserTexts,
          rolledBackUserTexts,
          resurrectedUserTexts,
          stats,
        });
      }
      if (responseMessage?.role === 'developer') {
        stats.injectedDeveloperMessages++;
      }
      const detail = responseItemToDetail(payload, row.timestamp, toolNameByCallId);
      if (detail) {
        if (detail.kind === 'tool_input') stats.toolInputs++;
        if (detail.kind === 'tool_output') stats.toolOutputs++;
        if (openTurn) {
          openTurn.details.push(detail);
        } else if (afterRollback) {
          if (!postRollbackTurn) {
            postRollbackTurn = {
              number: `rollout-${stats.parsedRows}`,
              messages: [],
              details: [],
              completedAt: null,
            };
            activeTurns.push(postRollbackTurn);
          }
          postRollbackTurn.details.push(detail);
        } else {
          pendingDetails.push(detail);
        }
      }
      if (responseMessage && responseMessage.role !== 'developer') {
        if (openTurn) {
          appendUniqueMessage(openTurn.messages, responseMessage);
        } else if (afterRollback && responseMessage.role === 'assistant') {
          if (!postRollbackTurn) {
            postRollbackTurn = {
              number: `rollout-${stats.parsedRows}`,
              messages: [],
              details: [],
              completedAt: null,
            };
            activeTurns.push(postRollbackTurn);
          }
          appendUniqueMessage(postRollbackTurn.messages, responseMessage);
        } else {
          appendUniqueMessage(pendingMessages, responseMessage);
        }
      }
      continue;
    }

    if (row?.type !== 'event_msg' || !payload?.type) continue;

    if (payload.type === 'task_started') {
      const pendingSplit = splitPendingMessagesForTaskStart({
        messages: pendingMessages,
        details: pendingDetails,
        syntheticNumber: `rollout-${stats.parsedRows}`,
      });
      if (pendingSplit.syntheticTurn) {
        activeTurns.push(pendingSplit.syntheticTurn);
        stats.syntheticContinuationTurns++;
      }
      const turn = {
        number: stats.taskStarted + 1,
        messages: pendingSplit.currentMessages,
        details: pendingSplit.currentDetails,
        completedAt: null,
      };
      pendingMessages = [];
      pendingDetails = [];
      activeTurns.push(turn);
      openTurn = turn;
      postRollbackTurn = null;
      afterRollback = false;
      stats.taskStarted++;
      continue;
    }

    if (payload.type === 'task_complete') {
      stats.taskComplete++;
      if (openTurn) openTurn.completedAt = parseHostTimestamp(row.timestamp);
      openTurn = null;
      continue;
    }

    if (payload.type === 'thread_rolled_back') {
      const count = Math.max(0, Number(payload.num_turns) || 0);
      stats.rollbackEvents++;
      stats.rolledBackTurns += count;
      stats.latestRollbackAt = row.timestamp ?? null;
      const removedTurns = removeRolledBackTurns(activeTurns, count);
      for (const message of removedTurns.flatMap((turn) => turn.messages)) {
        if (message.role !== 'user') continue;
        stats.rolledBackUserMessages++;
        incrementTextMap(rolledBackUserTexts, message.text);
      }
      if (openTurn && !activeTurns.includes(openTurn)) {
        openTurn = null;
      }
      if (postRollbackTurn && !activeTurns.includes(postRollbackTurn)) {
        postRollbackTurn = null;
      }
      pendingMessages = [];
      pendingDetails = [];
      afterRollback = true;
      continue;
    }

    const message = eventPayloadToMemoryMessage(payload, row.timestamp);
    if (!message) {
      if (payload.type === 'user_message' || payload.type === 'agent_message') {
        stats.skippedMessages++;
      }
      continue;
    }
    if (message.role === 'user') {
      if (stats.rollbackEvents > 0) {
        stats.userMessagesAfterRollback++;
      }
      notePotentialResurrectedUserMessage({
        message,
        compactedReplacementUserTexts,
        rolledBackUserTexts,
        resurrectedUserTexts,
        stats,
      });
    }

    if (openTurn) {
      appendUniqueMessage(openTurn.messages, message);
    } else if (afterRollback && message.role === 'assistant') {
      if (!postRollbackTurn) {
        postRollbackTurn = {
          number: `rollout-${stats.parsedRows}`,
          messages: [],
          details: [],
          completedAt: null,
        };
        activeTurns.push(postRollbackTurn);
      }
      appendUniqueMessage(postRollbackTurn.messages, message);
    } else {
      appendUniqueMessage(pendingMessages, message);
    }
  }

  if (!includeInFlightTurn && openTurn) {
    const index = activeTurns.indexOf(openTurn);
    if (index >= 0) {
      activeTurns.splice(index, 1);
      stats.inFlightTurnsExcluded++;
    }
    openTurn = null;
  }

  if (!includeInFlightTurn && afterRollback && postRollbackTurn) {
    const index = activeTurns.indexOf(postRollbackTurn);
    if (index >= 0) {
      activeTurns.splice(index, 1);
      stats.inFlightTurnsExcluded++;
    }
    postRollbackTurn = null;
  }

  if (pendingMessages.length > 0 || pendingDetails.length > 0) {
    activeTurns.push({
      number: `rollout-${stats.parsedRows}`,
      messages: pendingMessages,
      details: pendingDetails,
      completedAt: null,
    });
  }

  const restoreSafety = buildRestoreSafetyDiagnostics({
    compactedReplacementUserTexts,
    rolledBackUserTexts,
    resurrectedUserTexts,
    stats,
  });

  return compactNullish({
    activeTurnCount: activeTurns.length,
    activeTurns,
    entries: activeTurns.flatMap((turn) =>
      turn.messages.map((message) => ({
        ...message,
        turn: turn.number,
      })),
    ),
    stats,
    restoreSafety,
    _restoreIndex: includeRestoreIndex
      ? {
          compactedReplacementUserTexts,
        }
      : null,
  });
}

export function inspectCodexPlannedRollbackRestoreSafety({ rolloutPath, rollbackTurns } = {}) {
  if (typeof rolloutPath !== 'string' || rolloutPath.length === 0) {
    throw new Error('rolloutPath is required');
  }
  if (!Number.isInteger(rollbackTurns) || rollbackTurns < 0) {
    throw new Error('rollbackTurns must be a non-negative integer');
  }

  const parsed = parseCodexRolloutFile(rolloutPath, {
    includeRestoreIndex: true,
    includeInFlightTurn: false,
  });
  const compactedReplacementUserTexts =
    parsed._restoreIndex?.compactedReplacementUserTexts ?? new Map();
  const targetTurns = parsed.activeTurns.slice(
    Math.max(0, parsed.activeTurns.length - rollbackTurns),
  );
  const plannedUserTexts = new Map();
  for (const message of targetTurns.flatMap((turn) => turn.messages)) {
    if (message.role !== 'user') continue;
    incrementTextMap(plannedUserTexts, message.text);
  }

  const retainedTexts = [];
  for (const [text, planned] of plannedUserTexts) {
    const compacted = compactedReplacementUserTexts.get(text);
    if (!compacted) continue;
    retainedTexts.push({
      textPreview: clipDiagnosticText(text),
      plannedRollbackCount: planned.count,
      compactedReplacementCount: compacted.count,
    });
  }

  const risks =
    retainedTexts.length > 0
      ? [
          {
            type: 'planned_rollback_text_retained_in_compacted_replacement_history',
            count: retainedTexts.length,
            message:
              'User text targeted by the planned rollback is already present in compacted.replacement_history and may be restored later.',
          },
        ]
      : [];

  return {
    status: risks.length > 0 ? 'risk' : 'ok',
    rolloutPath,
    plannedRollbackTurns: rollbackTurns,
    activeTurnCount: parsed.activeTurnCount,
    compactedRows: parsed.stats.compactedRows,
    compactedReplacementUserMessages: parsed.stats.compactedReplacementUserMessages,
    plannedRollbackUserMessages: [...plannedUserTexts.values()].reduce(
      (sum, entry) => sum + entry.count,
      0,
    ),
    rollbackTextRetainedInCompacted: retainedTexts.length,
    retainedTexts,
    risks,
  };
}

function compactedPayloadToUserMessages(payload, timestamp) {
  if (!Array.isArray(payload?.replacement_history)) return [];
  return payload.replacement_history
    .filter((item) => item?.type === 'message' && item.role === 'user')
    .map((item) => ({
      time: timestamp ?? null,
      role: 'user',
      text: normalizeMessageText(messageContentToText(item.content)),
    }))
    .filter((message) => message.text.length > 0);
}

function responseItemToDetail(payload, timestamp, toolNameByCallId) {
  if (['function_call', 'custom_tool_call'].includes(payload?.type)) {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
    const toolName = [payload.namespace, payload.name].filter((v) => typeof v === 'string' && v).join('.');
    const name = toolName || payload.type;
    if (callId) toolNameByCallId.set(callId, name);
    return {
      time: timestamp ?? null,
      kind: 'tool_input',
      tool_name: name,
      source_id: callId,
      input_text: stringifyToolArguments(payload.type === 'custom_tool_call' ? payload.input : payload.arguments),
      output_text: null,
    };
  }

  if (['function_call_output', 'custom_tool_call_output'].includes(payload?.type)) {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
    return {
      time: timestamp ?? null,
      kind: 'tool_output',
      tool_name: callId ? (toolNameByCallId.get(callId) ?? payload.type.replace(/_output$/, '')) : payload.type.replace(/_output$/, ''),
      source_id: callId ? `${callId}:output` : null,
      input_text: null,
      output_text: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? null),
    };
  }

  return null;
}

function stringifyToolArguments(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

function splitPendingMessagesForTaskStart({ messages, details, syntheticNumber }) {
  const firstCurrentMessageIndex = messages.findIndex((message) => message.role !== 'assistant');
  if (firstCurrentMessageIndex === -1 && messages.length > 0) {
    return {
      syntheticTurn: {
        number: syntheticNumber,
        messages,
        details,
        completedAt: null,
      },
      currentMessages: [],
      currentDetails: [],
    };
  }

  if (firstCurrentMessageIndex <= 0) {
    return {
      syntheticTurn: null,
      currentMessages: messages,
      currentDetails: details,
    };
  }

  const syntheticMessages = messages.slice(0, firstCurrentMessageIndex);
  const currentMessages = messages.slice(firstCurrentMessageIndex);
  const boundaryTime = currentMessages[0]?.time ?? null;
  const syntheticDetails = [];
  const currentDetails = [];

  for (const detail of details) {
    if (boundaryTime && detail?.time && detail.time < boundaryTime) {
      syntheticDetails.push(detail);
    } else {
      currentDetails.push(detail);
    }
  }

  return {
    syntheticTurn: {
      number: syntheticNumber,
      messages: syntheticMessages,
      details: syntheticDetails,
      completedAt: null,
    },
    currentMessages,
    currentDetails,
  };
}

function parseHostTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function removeRolledBackTurns(activeTurns, count) {
  return activeTurns.splice(Math.max(0, activeTurns.length - count), count);
}

function eventPayloadToMemoryMessage(payload, timestamp) {
  if (payload.type === 'user_message') {
    const text = normalizeMessageText(payload.message);
    if (!text || shouldSkipUserMessage(text)) return null;
    return {
      time: timestamp ?? null,
      role: 'user',
      text,
    };
  }

  if (payload.type === 'agent_message') {
    const text = normalizeMessageText(payload.message);
    if (!text) return null;
    return {
      time: timestamp ?? null,
      role: 'assistant',
      text,
    };
  }

  return null;
}

function responseItemToConversationMessage(payload, timestamp) {
  if (payload?.type !== 'message' || !['user', 'assistant', 'developer'].includes(payload.role)) return null;
  const text = normalizeMessageText(messageContentToText(payload.content));
  if (!text) return null;
  if (payload.role === 'developer' && !isThroughlineInjectedDeveloperMemory(text)) return null;
  if (payload.role === 'user' && shouldSkipUserMessage(text)) return null;
  return {
    time: timestamp ?? null,
    role: payload.role,
    text,
  };
}

function appendUniqueMessage(messages, message) {
  if (messages.some((item) => item.role === message.role && item.text === message.text)) return;
  messages.push(message);
}

function isThroughlineInjectedDeveloperMemory(text) {
  return text.startsWith('## Throughline: Active Work Context');
}

function messageContentToText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.input_text === 'string') return item.input_text;
      if (typeof item?.output_text === 'string') return item.output_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function shouldSkipUserMessage(text) {
  return text.startsWith('# AGENTS.md instructions') || text.startsWith('<hook_prompt');
}

function normalizeMessageText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function incrementTextMap(map, text) {
  if (!text) return;
  const existing = map.get(text);
  if (existing) {
    existing.count++;
    return;
  }
  map.set(text, { text, count: 1 });
}

function compactNullish(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

function notePotentialResurrectedUserMessage({
  message,
  compactedReplacementUserTexts,
  rolledBackUserTexts,
  resurrectedUserTexts,
  stats,
}) {
  if (stats.rollbackEvents < 1) return;
  if (!rolledBackUserTexts.has(message.text)) return;
  if (!compactedReplacementUserTexts.has(message.text)) return;
  stats.resurrectedUserMessages++;
  incrementTextMap(resurrectedUserTexts, message.text);
}

function buildRestoreSafetyDiagnostics({
  compactedReplacementUserTexts,
  rolledBackUserTexts,
  resurrectedUserTexts,
  stats,
}) {
  const retainedTexts = [];
  const rolledBackTexts = [...rolledBackUserTexts.values()].map((entry) => ({
    textPreview: clipDiagnosticText(entry.text),
    count: entry.count,
  }));

  for (const [text, rolledBack] of rolledBackUserTexts) {
    const compacted = compactedReplacementUserTexts.get(text);
    if (!compacted) continue;
    retainedTexts.push({
      textPreview: clipDiagnosticText(text),
      rolledBackCount: rolledBack.count,
      compactedReplacementCount: compacted.count,
    });
  }

  const resurrectedTexts = [...resurrectedUserTexts.values()].map((entry) => ({
    textPreview: clipDiagnosticText(entry.text),
    count: entry.count,
  }));

  stats.rollbackTextRetainedInCompacted = retainedTexts.length;
  stats.resurrectedUserMessages = resurrectedTexts.reduce((sum, entry) => sum + entry.count, 0);

  const risks = [];
  if (retainedTexts.length > 0) {
    risks.push({
      type: 'rollback_text_retained_in_compacted_replacement_history',
      count: retainedTexts.length,
      message:
        'Rollback-targeted user text is still present in compacted.replacement_history and may be restored later.',
    });
  }
  if (resurrectedTexts.length > 0) {
    risks.push({
      type: 'rolled_back_user_text_reappeared_after_rollback',
      count: resurrectedTexts.length,
      message: 'A user message matching rolled-back compacted history reappeared after rollback.',
    });
  }

  return {
    status: risks.length > 0 ? 'risk' : 'ok',
    compactedRows: stats.compactedRows,
    compactedReplacementUserMessages: stats.compactedReplacementUserMessages,
    rolledBackUserMessages: stats.rolledBackUserMessages,
    userMessagesAfterRollback: stats.userMessagesAfterRollback,
    latestRollbackAt: stats.latestRollbackAt,
    rollbackTextRetainedInCompacted: retainedTexts.length,
    resurrectedUserMessages: stats.resurrectedUserMessages,
    rolledBackTexts,
    retainedTexts,
    resurrectedTexts,
    risks,
  };
}

function clipDiagnosticText(text) {
  if (text.length <= 180) return text;
  return `${text.slice(0, 180).trimEnd()} [truncated]`;
}

function renderCodexRolloutMemoryPreview({ candidate, parsed, previewMaxChars }) {
  const lines = [];
  lines.push('## Throughline Trim Memory Preview');
  lines.push('');
  lines.push('Intent: Continue the active Codex work thread after rollback.');
  lines.push('');
  lines.push('### Reading Contract');
  lines.push(
    'This preview is current-task context for continuation, not a passive archive. ' +
      'Entries are oldest-to-newest; later entries may supersede earlier hypotheses.',
  );
  lines.push(
    'The source is the active Codex rollout after applying thread_rolled_back events; ' +
      'rolled-back tail turns are not included as current work.',
  );
  lines.push('');
  lines.push('### Source');
  lines.push(`Codex thread: ${candidate.id}`);
  lines.push(`Project: ${candidate.cwd ?? 'unknown'}`);
  lines.push(`Rollout: ${candidate.rolloutPath}`);
  lines.push(`Active turns: ${parsed.activeTurnCount}`);

  const recentEntries = parsed.entries.slice(-MAX_RECENT_ENTRIES);
  if (recentEntries.length > 0) {
    lines.push('');
    lines.push('### Active Work Thread (Codex Rollout)');
    lines.push('Entries are oldest-to-newest; later entries may supersede earlier hypotheses.');
    for (const entry of recentEntries) {
      const time = entry.time ?? 'unknown-time';
      lines.push(`[${time}] [turn ${entry.turn}] [${entry.role}] ${clipEntry(entry.text)}`);
    }
  }

  lines.push('');
  lines.push('### Continuation Instruction');
  lines.push(
    'Use these Codex rollout entries as the active work thread. Continue from the latest actionable state, ' +
      'and do not resurrect rolled-back turns or obsolete earlier hypotheses.',
  );

  const fullText = lines.join('\n');
  const truncated = fullText.length > previewMaxChars;
  return {
    text: truncated
      ? `${fullText.slice(0, previewMaxChars).trimEnd()}\n\n[truncated for dry-run preview]`
      : fullText,
    truncated,
    stats: {
      source: 'codex-rollout',
      activeTurns: parsed.activeTurnCount,
      recentEntries: parsed.entries.length,
      rollbackEvents: parsed.stats.rollbackEvents,
      rolledBackTurns: parsed.stats.rolledBackTurns,
      injectedDeveloperMessages: parsed.stats.injectedDeveloperMessages,
      skippedMessages: parsed.stats.skippedMessages,
      restoreSafety: parsed.restoreSafety,
    },
  };
}

function buildCodexContextEstimate(parsed) {
  const turns = parsed.activeTurns.map((turn) => {
    const text = [
      ...turn.messages.map((message) => message.text),
      ...turn.details.flatMap((detail) => [detail.input_text, detail.output_text]),
    ]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .join('\n');
    return {
      turn: turn.number,
      chars: text.length,
      estimatedTokens: estimateTokens(text),
    };
  });
  return {
    method: 'chars_div_4',
    activeTurns: turns.length,
    activeChars: turns.reduce((sum, row) => sum + row.chars, 0),
    activeEstimatedTokens: turns.reduce((sum, row) => sum + row.estimatedTokens, 0),
    turns,
  };
}

function clipEntry(text) {
  if (text.length <= MAX_ENTRY_CHARS) return text;
  return `${text.slice(0, MAX_ENTRY_CHARS).trimEnd()} [entry truncated]`;
}
