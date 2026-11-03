export const OBSERVER_PARENT_WATCH_INTERVAL_MS = 1000;

export function installCancellation({ controller, processRef, setIntervalFn, clearIntervalFn, parentWatchIntervalMs }) {
  const abort = () => controller.abort();
  const parentPid = processRef.ppid;
  processRef.on('SIGINT', abort);
  processRef.on('SIGTERM', abort);
  processRef.on('disconnect', abort);

  let parentTimer = null;
  if (Number.isSafeInteger(parentPid) && parentPid > 1) {
    const checkParent = () => {
      if (processRef.ppid !== parentPid) return abort();
      try {
        processRef.kill(parentPid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') abort();
      }
    };
    parentTimer = setIntervalFn(checkParent, parentWatchIntervalMs);
    parentTimer?.unref?.();
  }

  return () => {
    processRef.removeListener('SIGINT', abort);
    processRef.removeListener('SIGTERM', abort);
    processRef.removeListener('disconnect', abort);
    if (parentTimer !== null) clearIntervalFn(parentTimer);
  };
}

