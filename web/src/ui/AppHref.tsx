import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isExternalHref } from '../lib/config';

/** Internal React Router `to`, or an absolute `https://{slug}.builderpad.xyz`. */
export function AppHref({
  to,
  className,
  children,
  onClick,
  'aria-label': ariaLabel,
}: {
  to: string;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  'aria-label'?: string;
}) {
  if (isExternalHref(to)) {
    return (
      <a href={to} className={className} aria-label={ariaLabel} onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} className={className} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </Link>
  );
}
