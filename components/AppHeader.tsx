import Link from 'next/link';
import { ResetDemoButton } from './ResetDemoButton';

export function AppHeader() {
  const demoMode = process.env.DEMO_MODE === 'true';
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white" aria-hidden>FS</span>
          <span>
            <span className="block text-base font-semibold leading-tight text-slate-900">FleetSpend AI</span>
            <span className="block text-xs leading-tight text-slate-500">AI accounts payable for fleet businesses</span>
          </span>
        </Link>
        <div className="flex items-center gap-3">
          {demoMode && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">Demo · PayPal sandbox</span>}
          <ResetDemoButton demoMode={demoMode} />
        </div>
      </div>
    </header>
  );
}
