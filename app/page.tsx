import { Suspense } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { BillList, BillListSkeleton } from '@/components/BillList';
import { UploadZone } from '@/components/UploadZone';

export default function Home() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Bills to pay</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Every bill is read by AI and checked for duplicates, overcharges, new payees and your spending limit.
            Nothing is paid until you approve it.
          </p>
        </div>
        <UploadZone />
        <Suspense fallback={<BillListSkeleton />}>
          <BillList />
        </Suspense>
      </main>
    </>
  );
}
