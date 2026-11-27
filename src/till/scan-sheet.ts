/** The native NFC manager reports session invalidation, but Core NFC does not report when its success sheet finishes
 * dismissing. Keep the decoration behind that event and allow the system success check time to leave the screen. */
const DISMISS_MS = 1500;
const MISSING_EVENT_MS = 3500;
export type AfterScanSheet = (visible: () => void) => () => void;

export function iosScanSheet() {
  let connected = false;
  let closeRequestedAt: number | null = null;
  let invalidatedAt: number | null = null;
  const waiting = new Set<() => void>();

  const whenClear: AfterScanSheet = visible => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function cancel() {
      if (timer !== undefined) clearTimeout(timer);
      waiting.delete(schedule);
    }
    function schedule() {
      cancel();
      if (connected && closeRequestedAt === null && invalidatedAt === null) {
        waiting.add(schedule);
        return;
      }
      const clearAt = invalidatedAt !== null ? invalidatedAt + DISMISS_MS
        : closeRequestedAt !== null ? closeRequestedAt + MISSING_EVENT_MS : 0;
      const left = clearAt - Date.now();
      if (left <= 0) { visible(); return; }
      waiting.add(schedule);
      timer = setTimeout(schedule, left);
    }
    schedule();
    return cancel;
  };

  return {
    connected() { connected = true; closeRequestedAt = invalidatedAt = null; },
    closing() {
      if (!connected) return;
      closeRequestedAt = Date.now();
      for (const schedule of Array.from(waiting)) schedule();
    },
    closed() {
      if (!connected || invalidatedAt !== null) return;
      invalidatedAt = Date.now();
      connected = false;
      for (const schedule of Array.from(waiting)) schedule();
    },
    whenClear,
  };
}
