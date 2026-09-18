import { Link } from 'react-router-dom';
import { BrandMark } from './BrandMark';

const YEAR = new Date().getFullYear();
const WHITEPAPER_HREF = '/whitepaper.pdf';

export function SiteFooter() {
  return (
    <footer className="mt-auto flex min-h-[65px] items-center border-t border-stroke-weak bg-background px-4 lg:h-[69px] lg:min-h-[69px] lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between lg:gap-3 lg:py-0">
        <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:gap-3">
          <div className="hidden lg:block">
            <BrandMark compact />
          </div>
          <p className="text-[11px] font-semibold leading-relaxed text-fg-subtle">
            © {YEAR} LUNATIC WISDOM LABS LLC
          </p>
        </div>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] font-bold text-fg-muted">
          <Link to="/" className="hidden hover:text-fg lg:inline">
            Home
          </Link>
          <Link to="/explore" className="hidden hover:text-fg lg:inline">
            Explore
          </Link>
          <Link to="/apps" className="hidden hover:text-fg lg:inline">
            My Projects
          </Link>
          <Link to="/create" className="hidden hover:text-fg lg:inline">
            Launch
          </Link>
          <Link to="/docs" className="hover:text-fg">
            Docs
          </Link>
          <Link to="/terms" className="hover:text-fg">
            Terms
          </Link>
          <Link to="/privacy" className="hover:text-fg">
            Privacy
          </Link>
          <a
            href={WHITEPAPER_HREF}
            target="_blank"
            rel="noreferrer"
            className="hover:text-fg"
          >
            $LWL Whitepaper
          </a>
        </nav>
      </div>
    </footer>
  );
}
