/**
 * Three dots bouncing in sequence — web twin of
 * `frontend/src/components/BouncingDots.tsx`.
 */
export function BouncingDots({ className }: { className?: string }) {
  return (
    <span className={`bounce-dots ${className ?? ''}`.trim()} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
