import { observeRuntimeError, resolveRuntimeError, runtimeErrorFingerprint } from './runtime-error-store.mjs';

try {
  // 第2引数が recovered の時は、その code の記録を「復帰を確認した」として解決にする（ADR 0041）。
  const result = process.argv[3] === 'recovered'
    ? resolveRuntimeError(runtimeErrorFingerprint(process.argv[2]), { reasonCode: 'recovered' })
    : observeRuntimeError({ code: process.argv[2] });
  process.exitCode = result.status === 'disabled' ? 3 : 0;
} catch {
  process.exitCode = 1;
}
