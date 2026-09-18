import { Link } from 'react-router-dom';
import icon from '../assets/images/builderpad-icon.webp';

/** Static status under the brand name — same stack as the trade-terminal Live row, no pulse. */
export function BrandStatus({ label = 'Beta' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold leading-none text-fg-muted sm:text-[11px]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
      {label}
    </span>
  );
}

export function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2 text-fg">
      <img src={icon} alt="" className="h-7 w-7 shrink-0 rounded-[6px]" />
      {compact ? null : (
        <span className="flex min-w-0 flex-col items-start justify-center gap-0.5">
          <span className="text-[15px] font-extrabold leading-none tracking-tight">
            Builder<span className="text-brand">Pad</span>
          </span>
          <BrandStatus />
        </span>
      )}
    </Link>
  );
}
