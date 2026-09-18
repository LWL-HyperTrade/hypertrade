import { useState } from 'react';
import { IconCheck, IconCopy } from './icons';
import robinhoodIcon from '../assets/images/robinhood-icon.webp';

const LWL_CA = '0x7bb3E171EC502F65C08D38a61D51B9841524A72D';
const LWL_CA_SHORT = `${LWL_CA.slice(0, 14)}…${LWL_CA.slice(-10)}`;

export function LwlByline() {
  const [copied, setCopied] = useState(false);

  const copyCa = async () => {
    try {
      await navigator.clipboard.writeText(LWL_CA);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex w-full items-center gap-2 rounded-lg border border-stroke-weak bg-surface px-2.5 py-2">
      <img
        src={robinhoodIcon}
        alt="Robinhood Chain"
        width={22}
        height={22}
        className="h-[22px] w-[22px] shrink-0 rounded-full object-contain"
      />
      <div className="min-w-0 flex-1">
        <span className="block text-[12px] font-extrabold leading-none text-fg">By $LWL</span>
        <span className="mt-0.5 block font-mono text-[10px] leading-snug text-fg-subtle">CA: {LWL_CA_SHORT}</span>
      </div>
      <button
        type="button"
        onClick={() => void copyCa()}
        aria-label={copied ? 'Copied contract address' : 'Copy contract address'}
        title={copied ? 'Copied' : 'Copy contract address'}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-fill-hover hover:text-fg"
      >
        {copied ? <IconCheck size={13} className="text-success" /> : <IconCopy size={13} />}
      </button>
    </div>
  );
}
