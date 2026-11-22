import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, ArrowRight, BarChart3, Eye, EyeOff, KeyRound, Lock, Mail, MailCheck, Send, Settings2, ShieldCheck, Users } from 'lucide-react';
import { API_BASE, get, post } from '../api/client.js';
import { useAuth } from '../store/auth.js';
import { useTheme } from '../store/theme.js';
import { ConnectionBanner, ThemeSwitch } from '../components/Layout.jsx';
import { FlightIllustration, Particles, TypeHeadline, Waves } from '../components/AuthScene.jsx';
import { Logo, Spinner, cx } from '../components/ui.jsx';

const FEATURES = [[Send, 'Campaigns'], [Users, 'Audience'], [BarChart3, 'Reports'], [Settings2, 'Automation']];

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
function MicrosoftIcon() {
  return <svg viewBox="0 0 23 23" className="h-5 w-5" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z" /><path fill="#7fba00" d="M12 1h10v10H12z" /><path fill="#00a4ef" d="M1 12h10v10H1z" /><path fill="#ffb900" d="M12 12h10v10H12z" /></svg>;
}

function GlassInput({ icon: Icon, right, ...props }) {
  return (
    <div className="group relative">
      <Icon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 transition group-focus-within:text-brand-500 dark:text-sky-200/70" strokeWidth={1.7} />
      <input {...props}
        className="h-14 w-full rounded-2xl border border-slate-200 bg-white/70 pl-12 pr-12 text-[15px] text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-4 focus:ring-brand-500/15 dark:border-white/15 dark:bg-white/[0.06] dark:text-white dark:placeholder:text-sky-100/50 dark:focus:border-sky-300/60 dark:focus:bg-white/[0.09] dark:focus:ring-sky-400/15" />
      {right && <div className="absolute right-3 top-1/2 -translate-y-1/2">{right}</div>}
    </div>
  );
}

function OtpBoxes({ value, onChange, onComplete, disabled }) {
  const refs = useRef([]);
  const digits = value.padEnd(6, ' ').slice(0, 6).split('');
  const set = (next) => { onChange(next); if (next.length === 6 && /^\d{6}$/.test(next)) onComplete?.(next); };
  const onKey = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const arr = value.split('');
      if (arr[i]) { arr[i] = ''; set(arr.join('').slice(0, i)); } else if (i > 0) { set(value.slice(0, i - 1)); refs.current[i - 1]?.focus(); }
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
  };
  const onInput = (i, e) => {
    const d = e.target.value.replace(/\D/g, '');
    if (!d) return;
    const next = (value.slice(0, i) + d).slice(0, 6);
    set(next);
    refs.current[Math.min(5, next.length)]?.focus();
  };
  const onPaste = (e) => {
    const d = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (d) { e.preventDefault(); set(d); refs.current[Math.min(5, d.length)]?.focus(); }
  };
  useEffect(() => { refs.current[0]?.focus(); }, []);
  return (
    <div className="flex justify-between gap-2" onPaste={onPaste}>
      {digits.map((d, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={1} disabled={disabled}
          aria-label={`Digit ${i + 1}`} value={d.trim()} onChange={(e) => onInput(i, e)} onKeyDown={(e) => onKey(i, e)}
          className="h-14 w-full min-w-0 rounded-2xl border border-slate-200 bg-white/70 text-center text-2xl font-semibold text-slate-900 outline-none transition focus:border-brand-400 focus:ring-4 focus:ring-brand-500/15 dark:border-white/15 dark:bg-white/[0.06] dark:text-white dark:focus:border-sky-300/60" />
      ))}
    </div>
  );
}

function useCountdown(seconds) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => { setLeft(seconds); }, [seconds]);
  useEffect(() => {
    if (left <= 0) return undefined;
    const t = setTimeout(() => setLeft((x) => x - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft];
}

function Alert({ tone = 'error', children }) {
  if (!children) return null;
  return <div role="alert" className={cx('rounded-2xl px-4 py-3 text-sm', tone === 'error' ? 'bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-200' : 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200')}>{children}</div>;
}

const PrimaryBtn = ({ loading, children, ...p }) => (
  <button type="submit" {...p} disabled={loading || p.disabled}
    className="group relative flex h-14 w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-sky-400 via-brand-500 to-brand-600 text-[17px] font-semibold text-white shadow-lg shadow-brand-500/30 transition hover:brightness-110 active:scale-[.99] disabled:opacity-60">
    <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition duration-700 group-hover:translate-x-full" />
    {loading ? <Spinner className="h-5 w-5" /> : children}
  </button>
);

export default function Login({ mode: initialMode = 'login' }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { status, user, login, verifyOtp, bootstrap } = useAuth();
  const dark = useTheme((s) => s.resolved === 'dark');

  const [mode, setMode] = useState(initialMode); // login | otp | forgot | reset | done
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [opts, setOpts] = useState({ sso: {}, passwordReset: false });
  const [resendLeft, setResendLeft] = useCountdown(0);

  useEffect(() => { get('/api/auth/options', { retry: false }).then(setOpts).catch(() => {}); }, []);
  useEffect(() => { setMode(initialMode); setError(null); setInfo(null); }, [initialMode]);

  const dest = (u) => {
    const next = params.get('next');
    const home = u.role === 'ADMIN' ? '/admin' : '/app';
    return next && next.startsWith(home) ? next : home;
  };

  // Already signed in (or just returned from Google/Microsoft) → go to the workspace.
  useEffect(() => {
    const sso = params.get('sso');
    if (sso === 'success') { bootstrap(); setParams({}, { replace: true }); }
    if (sso === 'error') { setError(params.get('message') || 'Sign-in failed'); setParams({}, { replace: true }); }
  }, [params, setParams, bootstrap]);
  useEffect(() => { if (status === 'authenticated' && user) navigate(dest(user), { replace: true }); }, [status, user]);

  const run = async (fn) => {
    setBusy(true); setError(null); setInfo(null);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const submitLogin = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await login(email, password, remember);
      if (r.otp) { setChallenge(r.otp); setCode(''); setMode('otp'); setResendLeft(r.otp.resendIn || 45); }
    });
  };
  const submitOtp = (value = code) => run(async () => { await verifyOtp(challenge.challengeId, value); });
  const resend = () => run(async () => {
    const r = await post('/api/auth/login/resend', { challengeId: challenge.challengeId });
    setResendLeft(r.resendIn || 45); setCode(''); setInfo('A new code is on its way.');
  });
  const submitForgot = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await post('/api/auth/password/forgot', { email });
      setInfo(r.message); setCode(''); setMode('reset');
    });
  };
  const submitReset = (e) => {
    e.preventDefault();
    run(async () => {
      await post('/api/auth/password/reset', { email, code, newPassword: newPw });
      setMode('done'); setPassword('');
    });
  };
  const sso = (p) => { window.location.href = `${API_BASE}/api/auth/sso/${p}/start?remember=${remember}`; };
  const anySso = opts.sso?.google || opts.sso?.microsoft;

  return (
    <div className={cx('relative min-h-screen overflow-hidden', dark ? 'bg-[#020a24] text-white' : 'bg-gradient-to-br from-[#f4f8ff] via-[#eaf1ff] to-[#dfe9ff] text-slate-900')}>
      {/* background */}
      {dark && <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_10%,rgba(37,99,235,0.35),transparent_55%),radial-gradient(ellipse_at_85%_30%,rgba(56,189,248,0.18),transparent_50%),radial-gradient(ellipse_at_10%_95%,rgba(124,58,237,0.35),transparent_45%)]" />}
      {!dark && <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_80%_20%,rgba(58,99,251,0.15),transparent_55%),radial-gradient(ellipse_at_10%_90%,rgba(56,189,248,0.2),transparent_45%)]" />}
      <Waves />
      <Particles />

      <div className="relative z-10 flex min-h-screen flex-col">
        <ConnectionBanner />
        <div className="flex items-center justify-between px-5 pt-5 sm:px-10">
          <Link to="/" className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm backdrop-blur transition', dark ? 'bg-white/5 text-sky-100/80 hover:bg-white/10' : 'bg-white/60 text-slate-600 hover:bg-white')}><ArrowLeft className="h-4 w-4" /> Back to home</Link>
          <ThemeSwitch vertical={false} />
        </div>

        <div className="mx-auto grid w-full max-w-[1320px] flex-1 items-center gap-10 px-5 pb-12 pt-6 sm:px-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          {/* left: story */}
          <div className="hidden lg:block">
            <div className="animate-fade-down"><Logo className="h-[72px]" /></div>
            <TypeHeadline
              className="mt-8 whitespace-nowrap text-[46px] font-extrabold italic leading-[1.08] tracking-tight xl:text-[54px]"
              parts={[{ t: 'Turn Emails into' }, { br: true }, { t: 'Real ' }, { t: 'Business Growth', cls: 'text-gradient' }]}
            />
            <svg className="-mt-1 ml-[30%] h-4 w-72" viewBox="0 0 260 16" aria-hidden="true"><path d="M2 12 C 70 2, 170 2, 258 8" fill="none" stroke="url(#ug)" strokeWidth="4" strokeLinecap="round" strokeDasharray="400" style={{ animation: 'draw 1.4s ease-out 2.4s both' }} /><defs><linearGradient id="ug"><stop offset="0" stopColor="#38bdf8" /><stop offset="1" stopColor="#3a63fb" /></linearGradient></defs></svg>
            <p className={cx('mt-5 max-w-xl text-lg leading-relaxed animate-fade-up [animation-delay:.9s]', dark ? 'text-sky-100/80' : 'text-slate-600')}>
              The all-in-one email marketing platform to create, send, follow up and track high-converting campaigns — from your team's own mailboxes.
            </p>
            <div className="mt-8 flex gap-4 animate-fade-up [animation-delay:1.1s]">
              {FEATURES.map(([I, l]) => (
                <div key={l} className={cx('flex w-[104px] flex-col items-center gap-2 rounded-2xl py-4 text-sm backdrop-blur-md transition hover:-translate-y-1', dark ? 'bg-white/[0.06] text-sky-50 ring-1 ring-white/10' : 'bg-white/70 text-slate-700 ring-1 ring-white')}>
                  <I className={cx('h-7 w-7', dark ? 'text-sky-300' : 'text-brand-500')} strokeWidth={1.6} />{l}
                </div>
              ))}
            </div>
            <div className="-mt-6 max-w-[460px] origin-top-left scale-[.8]"><FlightIllustration /></div>
          </div>

          {/* right: glass card */}
          <div className="mx-auto w-full max-w-[520px] animate-card-in">
            <div className="mb-6 flex justify-center lg:hidden"><Logo className="h-14" /></div>
            <div className={cx('relative rounded-[32px] p-[1.5px]', dark ? 'bg-gradient-to-b from-sky-300/70 via-brand-500/30 to-violet-500/40' : 'bg-gradient-to-b from-white via-brand-200/60 to-sky-200')}>
              <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[40px] bg-brand-500/25 blur-3xl" style={{ animation: 'glow 4s ease-in-out infinite' }} />
              <div className={cx('rounded-[31px] px-7 py-9 backdrop-blur-2xl sm:px-10', dark ? 'bg-[#071433]/75' : 'bg-white/80')}>
                {mode === 'login' && (
                  <form onSubmit={submitLogin} className="space-y-5">
                    <div className="mb-2 text-center">
                      <p className={cx('text-xl', dark ? 'text-sky-50/90' : 'text-slate-600')}>Welcome to</p>
                      <p className="mt-1 font-serif text-[44px] font-bold leading-tight tracking-tight">Emails <i className="text-gradient">Pro</i></p>
                      <div className="mx-auto mt-1 h-[2px] w-24 rounded bg-gradient-to-r from-transparent via-sky-400 to-transparent" />
                      <p className={cx('mt-3 text-[15px]', dark ? 'text-sky-100/75' : 'text-slate-500')}>Sign in to manage your email campaigns</p>
                    </div>
                    <GlassInput icon={Mail} type="email" autoComplete="username" placeholder="Enter your email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                    <GlassInput icon={Lock} type={showPw ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" required value={password} onChange={(e) => setPassword(e.target.value)}
                      right={<button type="button" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? 'Hide password' : 'Show password'} className={cx('rounded-lg p-1.5', dark ? 'text-sky-100/70 hover:text-white' : 'text-slate-400 hover:text-slate-700')}>{showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}</button>} />
                    <div className="flex items-center justify-between text-sm">
                      <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-[18px] w-[18px] rounded accent-brand-500" /> Remember me</label>
                      <Link to="/forgot-password" className="font-medium text-brand-600 hover:underline dark:text-sky-300">Forgot password?</Link>
                    </div>
                    <Alert>{error}</Alert>
                    <PrimaryBtn loading={busy}>Sign In <ArrowRight className="h-5 w-5 transition group-hover:translate-x-1" /></PrimaryBtn>
                    {opts.otpLogin && <p className={cx('flex items-center justify-center gap-1.5 text-xs', dark ? 'text-sky-100/60' : 'text-slate-500')}><ShieldCheck className="h-3.5 w-3.5" /> Protected by email verification code</p>}
                    {anySso && (
                      <>
                        <div className={cx('flex items-center gap-3 text-sm', dark ? 'text-sky-100/60' : 'text-slate-400')}><span className="h-px flex-1 bg-current opacity-40" />or continue with<span className="h-px flex-1 bg-current opacity-40" /></div>
                        <div className="grid grid-cols-2 gap-3">
                          {opts.sso.google && <button type="button" onClick={() => sso('google')} className={cx('flex h-12 items-center justify-center gap-2.5 rounded-2xl border text-[15px] font-medium transition', dark ? 'border-white/15 bg-white/[0.04] hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-50')}><GoogleIcon /> Google</button>}
                          {opts.sso.microsoft && <button type="button" onClick={() => sso('microsoft')} className={cx('flex h-12 items-center justify-center gap-2.5 rounded-2xl border text-[15px] font-medium transition', dark ? 'border-white/15 bg-white/[0.04] hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-50', !opts.sso.google && 'col-span-2')}><MicrosoftIcon /> Microsoft</button>}
                        </div>
                      </>
                    )}
                    <p className={cx('pt-1 text-center text-xs', dark ? 'text-sky-100/50' : 'text-slate-400')}>First sign-in after a quiet period can take up to a minute while the server wakes up.</p>
                  </form>
                )}

                {mode === 'otp' && challenge && (
                  <form onSubmit={(e) => { e.preventDefault(); submitOtp(); }} className="space-y-6">
                    <div className="text-center">
                      <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-sky-400 to-brand-600 text-white shadow-lg shadow-brand-500/30"><MailCheck className="h-8 w-8" /></span>
                      <h2 className="text-2xl font-semibold">Check your email</h2>
                      <p className={cx('mt-2 text-[15px]', dark ? 'text-sky-100/75' : 'text-slate-500')}>We sent a 6-digit code to <b className={dark ? 'text-white' : 'text-slate-800'}>{challenge.email}</b>. It expires in 10 minutes.</p>
                    </div>
                    <OtpBoxes value={code} onChange={setCode} onComplete={(v) => submitOtp(v)} disabled={busy} />
                    <Alert>{error}</Alert>
                    <Alert tone="ok">{info}</Alert>
                    <PrimaryBtn loading={busy} disabled={code.length !== 6}>Verify & sign in</PrimaryBtn>
                    <div className={cx('flex items-center justify-between text-sm', dark ? 'text-sky-100/70' : 'text-slate-500')}>
                      <button type="button" onClick={() => { setMode('login'); setError(null); setInfo(null); }} className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="h-4 w-4" /> Use a different account</button>
                      {resendLeft > 0 ? <span>Resend in {resendLeft}s</span> : <button type="button" onClick={resend} className="font-medium text-brand-600 hover:underline dark:text-sky-300">Resend code</button>}
                    </div>
                  </form>
                )}

                {(mode === 'forgot' || mode === 'reset') && (
                  <form onSubmit={mode === 'forgot' ? submitForgot : submitReset} className="space-y-5">
                    <div className="text-center">
                      <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-sky-400 to-brand-600 text-white shadow-lg shadow-brand-500/30"><KeyRound className="h-8 w-8" /></span>
                      <h2 className="text-2xl font-semibold">{mode === 'forgot' ? 'Forgot your password?' : 'Choose a new password'}</h2>
                      <p className={cx('mt-2 text-[15px]', dark ? 'text-sky-100/75' : 'text-slate-500')}>{mode === 'forgot' ? "Enter your work email and we'll send you a reset code." : `Enter the code we emailed to ${email} and your new password.`}</p>
                    </div>
                    {mode === 'forgot' && !opts.passwordReset && <Alert>Email reset isn't set up yet — ask your administrator to reset your password.</Alert>}
                    {mode === 'forgot' ? (
                      <GlassInput icon={Mail} type="email" autoComplete="username" placeholder="Enter your email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                    ) : (
                      <>
                        <OtpBoxes value={code} onChange={setCode} />
                        <GlassInput icon={Lock} type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="New password (min. 10 characters)" required minLength={10} value={newPw} onChange={(e) => setNewPw(e.target.value)}
                          right={<button type="button" onClick={() => setShowPw((s) => !s)} aria-label="Toggle password visibility" className="rounded-lg p-1.5 text-slate-400">{showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}</button>} />
                      </>
                    )}
                    <Alert>{error}</Alert>
                    <Alert tone="ok">{info}</Alert>
                    <PrimaryBtn loading={busy} disabled={mode === 'reset' && (code.length !== 6 || newPw.length < 10)}>{mode === 'forgot' ? 'Send reset code' : 'Reset password'}</PrimaryBtn>
                    <Link to="/login" className={cx('flex items-center justify-center gap-1 text-sm hover:underline', dark ? 'text-sky-100/70' : 'text-slate-500')}><ArrowLeft className="h-4 w-4" /> Back to sign in</Link>
                  </form>
                )}

                {mode === 'done' && (
                  <div className="space-y-5 text-center">
                    <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"><ShieldCheck className="h-8 w-8" /></span>
                    <h2 className="text-2xl font-semibold">Password updated</h2>
                    <p className={dark ? 'text-sky-100/75' : 'text-slate-500'}>You've been signed out everywhere. Sign in with your new password.</p>
                    <Link to="/login" onClick={() => setMode('login')} className="block"><PrimaryBtn type="button">Back to sign in</PrimaryBtn></Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
