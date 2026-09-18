import { useEffect, useState } from 'react';
import {
  getConfirmCloseOrders,
  getConfirmOpenOrders,
  getOrderNotifications,
  getSpotDusting,
  setConfirmCloseOrders,
  setConfirmOpenOrders,
  setOrderNotifications,
  setSpotDusting,
  SPOT_DUST_USD,
} from '../../lib/tradePrefs';
import { IconClose } from '../icons';

export function TradeSettingsSheet({
  open,
  ownerId,
  onClose,
}: {
  open: boolean;
  ownerId: string | null | undefined;
  onClose: () => void;
}) {
  const [notifications, setNotifications] = useState(() => getOrderNotifications(ownerId));
  const [confirmOpen, setConfirmOpen] = useState(() => getConfirmOpenOrders(ownerId));
  const [confirmClose, setConfirmClose] = useState(() => getConfirmCloseOrders(ownerId));
  const [spotDusting, setSpotDustingOn] = useState(() => getSpotDusting(ownerId));

  useEffect(() => {
    if (!open) return;
    setNotifications(getOrderNotifications(ownerId));
    setConfirmOpen(getConfirmOpenOrders(ownerId));
    setConfirmClose(getConfirmCloseOrders(ownerId));
    setSpotDustingOn(getSpotDusting(ownerId));
  }, [open, ownerId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-end">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Close" onClick={onClose} />
      <div className="relative m-3 mt-14 w-[min(340px,92vw)] rounded-2xl border border-stroke-weak bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-stroke-weak px-4 py-3">
          <h2 className="text-[14px] font-bold">Trade settings</h2>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-fill-weak"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>
        <div className="space-y-1 p-3">
          <ToggleRow
            label="Order notifications"
            hint="Subtle success and error toasts after place or close"
            checked={notifications}
            onChange={(on) => {
              setNotifications(on);
              setOrderNotifications(ownerId, on);
            }}
          />
          <ToggleRow
            label="Confirm open orders"
            hint="Ask before submitting market or limit orders"
            checked={confirmOpen}
            onChange={(on) => {
              setConfirmOpen(on);
              setConfirmOpenOrders(ownerId, on);
            }}
          />
          <ToggleRow
            label="Confirm close positions"
            hint="Ask before market-closing a live position"
            checked={confirmClose}
            onChange={(on) => {
              setConfirmClose(on);
              setConfirmCloseOrders(ownerId, on);
            }}
          />
          <ToggleRow
            label="Spot dusting"
            hint={`Hide spot tokens worth under $${SPOT_DUST_USD.toFixed(2)} in Portfolio`}
            checked={spotDusting}
            onChange={(on) => {
              setSpotDustingOn(on);
              setSpotDusting(ownerId, on);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl px-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold text-fg">{label}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-fg-subtle">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-brand' : 'bg-fill-weak'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </button>
    </div>
  );
}
