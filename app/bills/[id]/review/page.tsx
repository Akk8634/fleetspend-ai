import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { BillReviewForm } from '@/components/BillReviewForm';
import { BillStatusBadge } from '@/components/BillStatusBadge';
import { BillNotFoundError, getBillById } from '@/lib/db/bills';
import { createServerClient } from '@/lib/db/client';
import { listVendors } from '@/lib/db/vendors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = createServerClient();
  const bill = await getBillById(id, supabase).catch((err) => {
    if (err instanceof BillNotFoundError) notFound();
    throw err;
  });
  if (bill.status !== 'needs_review') redirect('/');

  const [vendors, signed] = await Promise.all([
    listVendors(supabase),
    supabase.storage.from('bills').createSignedUrl(bill.storage_path, 60 * 10),
  ]);
  const fileUrl = signed.data?.signedUrl ?? null;
  const isPdf = bill.storage_path.toLowerCase().endsWith('.pdf');

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-label="Original bill" className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <p className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{bill.original_filename}</p>
        {fileUrl ? (
          isPdf ? (
            <iframe src={fileUrl} title="Bill PDF" className="h-[70vh] w-full rounded-md border border-slate-200" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL from private storage
            <img src={fileUrl} alt={`Bill ${bill.original_filename}`} className="mx-auto max-h-[75vh] w-auto rounded-md border border-slate-200" />
          )
        ) : (
          <p className="p-6 text-sm text-slate-500">The bill file could not be loaded.</p>
        )}
      </section>

      <section aria-labelledby="review-heading" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 id="review-heading" className="text-lg font-semibold text-slate-900">Check the bill details</h1>
          <BillStatusBadge status={bill.status} />
        </div>
        <BillReviewForm
          bill={{
            id: bill.id,
            vendor_id: bill.vendor_id,
            vendor_name_raw: bill.vendor_name_raw,
            amount_text: bill.amount_text,
            currency_code: bill.currency_code,
            bill_date: bill.bill_date,
            invoice_number: bill.invoice_number,
            payee_email: bill.payee_email,
            low_confidence_fields: bill.low_confidence_fields,
            review_message: bill.review_message,
          }}
          vendors={vendors.map((v) => ({ id: v.id, name: v.name, paypal_email: v.paypal_email }))}
        />
      </section>
    </div>
  );
}

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <Link href="/" className="text-sm font-medium text-slate-600 hover:text-slate-900">← Back to bills</Link>
        <div className="mt-4">
          <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-slate-200/60" aria-busy="true" />}>
            <Review params={params} />
          </Suspense>
        </div>
      </main>
    </>
  );
}
