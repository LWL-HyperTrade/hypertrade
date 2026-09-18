import { useEffect } from 'react';
import { IconCheck, IconClose } from '../icons';

export type TradeToastPayload = {
  kind: 'ok' | 'err';
  message: string;
};

export function TradeToast({
  toast,
  onDismiss,
}: {
  toast: TradeToastPayload | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(id);
  }, [toast, onDismiss]);

  if (!toast) return null;

  const ok = toast.kind === 'ok';
  return (
    <div
      role="status"
      className={`fixed bottom-4 left-1/2 z-[70] flex max-w-[min(420px,92vw)] -translate-x-1/2 items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[13px] font-semibold shadow-lg backdrop-blur-md ${
        ok
          ? 'border-market-up/35 bg-background/95 text-market-up'
          : 'border-market-down/35 bg-background/95 text-market-down'
      }`}
    >
      <span
        className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          ok ? 'bg-market-up/15' : 'bg-market-down/15'
        }`}
      >
        {ok ? <IconCheck size={12} /> : <IconClose size={12} />}
      </span>
      <span className="min-w-0 flex-1 leading-snug text-fg">{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-0.5 text-fg-subtle hover:bg-fill-weak hover:text-fg"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
