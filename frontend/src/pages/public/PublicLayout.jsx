import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { ArrowRight, Menu, X } from 'lucide-react';
import { useAuth } from '../../store/auth.js';
import { ThemeSwitch } from '../../components/Layout.jsx';
import { Brand, Logo, cx } from '../../components/ui.jsx';

export const PUBLIC_NAV = [['/', 'Home'], ['/features', 'Features'], ['/how-to-use', 'How to use'], ['/why-emails-pro', 'Why Emails Pro']];

export function SignInCta({ size = 'md', label }) {
  const { status, user } = useAuth();
  const authed = status === 'authenticated' && user;
  const to = authed ? (user.role === 'ADMIN' ? '/admin' : '/app') : '/login';
  return (
    <Link to={to} className={cx('inline-flex items-center gap-2 rounded-full bg-inv font-medium text-inv-fg transition hover:opacity-90', size === 'lg' ? 'h-12 px-6 text-[15px]' : 'h-10 px-4 text-sm')}>
      {label || (authed ? 'Open dashboard' : 'Sign in')} <ArrowRight className="h-4 w-4" />
    </Link>
  );
}

export default function PublicLayout({ children }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { setOpen(false); window.scrollTo({ top: 0 }); }, [pathname]);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', h, { passive: true });
    return () => window.removeEventListener('scroll', h);
  }, []);
  return (
    <div className="min-h-screen bg-app">
      <header className={cx('sticky top-0 z-40 transition', scrolled && 'backdrop-blur-xl')}>
        <div className="mx-auto flex max-w-[1240px] items-center gap-3 px-4 py-4 sm:px-6">
          <Link to="/" className="pill flex h-14 items-center px-4"><Brand /></Link>
          <nav className="pill mx-auto hidden h-14 items-center gap-1 px-2 md:flex">
            {PUBLIC_NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cx('rounded-full px-4 py-2 text-[15px] transition', isActive ? 'bg-inv font-medium text-inv-fg' : 'text-fg2 hover:bg-subtle hover:text-fg')}>{label}</NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <div className="hidden sm:block"><ThemeSwitch vertical={false} /></div>
            <div className="hidden sm:block"><SignInCta /></div>
            <button type="button" className="pill flex h-12 w-12 items-center justify-center md:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu">{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
          </div>
        </div>
        {open && (
          <div className="mx-4 mb-3 animate-pop card p-2 md:hidden">
            {PUBLIC_NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cx('block rounded-2xl px-4 py-3', isActive ? 'bg-inv text-inv-fg' : 'text-fg2')}>{label}</NavLink>)}
            <div className="flex items-center justify-between gap-2 p-2"><ThemeSwitch vertical={false} /><SignInCta /></div>
          </div>
        )}
      </header>
      <main>{children}</main>
      <footer className="mt-24 border-t border-line">
        <div className="mx-auto grid max-w-[1240px] gap-10 px-6 py-14 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Logo className="h-14" />
            <p className="mt-4 max-w-sm text-sm text-muted">Employee-owned email infrastructure with centralized administrative control — safe sending, original-thread follow-ups and honest analytics.</p>
          </div>
          <div>
            <div className="text-sm font-semibold text-fg">Product</div>
            <ul className="mt-3 space-y-2 text-sm text-muted">{PUBLIC_NAV.map(([to, l]) => <li key={to}><Link className="hover:text-fg" to={to}>{l}</Link></li>)}</ul>
          </div>
          <div>
            <div className="text-sm font-semibold text-fg">Workspace</div>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li><Link className="hover:text-fg" to="/login">Sign in</Link></li>
              <li><Link className="hover:text-fg" to="/forgot-password">Reset password</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-line py-6 text-center text-xs text-faint">© {new Date().getFullYear()} Emails Pro · Email Marketing Platform</div>
      </footer>
    </div>
  );
}

export function Section({ eyebrow, title, subtitle, children, className }) {
  return (
    <section className={cx('mx-auto max-w-[1240px] px-4 sm:px-6', className)}>
      {(eyebrow || title) && (
        <div className="mx-auto mb-10 max-w-2xl text-center">
          {eyebrow && <div className="mb-3 inline-flex rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">{eyebrow}</div>}
          {title && <h2 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{title}</h2>}
          {subtitle && <p className="mt-3 text-[17px] text-muted">{subtitle}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHero({ eyebrow, title, subtitle, children }) {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-brand-500/15 blur-3xl" />
      <div className="relative mx-auto max-w-[920px] px-4 pb-10 pt-14 text-center sm:px-6 sm:pt-20">
        {eyebrow && <div className="mb-5 inline-flex animate-fade-up rounded-full bg-card px-4 py-1.5 text-sm text-fg2 shadow-sm ring-1 ring-line">{eyebrow}</div>}
        <h1 className="animate-fade-up text-4xl font-semibold tracking-tight text-fg [animation-delay:.08s] sm:text-6xl">{title}</h1>
        {subtitle && <p className="mx-auto mt-5 max-w-2xl animate-fade-up text-lg text-muted [animation-delay:.16s]">{subtitle}</p>}
        {children && <div className="mt-8 animate-fade-up [animation-delay:.24s]">{children}</div>}
      </div>
    </section>
  );
}
