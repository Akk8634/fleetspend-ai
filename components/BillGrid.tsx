'use client';

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GetRowIdParams, type ICellRendererParams, type IRowNode, type SelectionChangedEvent } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAYABLE_STATUSES, type BillStatus, type BillWithDetails } from '@/lib/db/types';
import { formatCurrency } from '@/lib/money/formatCurrency';
import { CHECK_LABEL, formatDate, STATUS_LABEL } from '@/lib/ui/labels';
import { BillStatusBadge } from './BillStatusBadge';

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({
  accentColor: '#4f46e5',
  fontFamily: 'inherit',
  fontSize: 13,
  headerBackgroundColor: '#f8fafc',
  headerFontWeight: 600,
  borderColor: '#e2e8f0',
  rowHoverColor: '#f8fafc',
  selectedRowBackgroundColor: '#eef2ff',
  wrapperBorderRadius: 0,
  wrapperBorder: false,
});

type Chip = 'all' | 'ready' | 'flagged' | 'needs_review' | 'payout_pending' | 'paid' | 'payout_failed';
const CHIPS: { id: Chip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'flagged', label: 'Flagged' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'payout_pending', label: 'Paying' },
  { id: 'paid', label: 'Paid' },
  { id: 'payout_failed', label: 'Failed' },
];

/** Text shown (and searched) in the Checks column. */
function checksText(b: BillWithDetails): string {
  switch (b.status) {
    case 'needs_review': return b.review_message ?? 'Please check the extracted details.';
    case 'payout_pending': return 'Sending with PayPal…';
    case 'paid': return `Paid via PayPal${b.payout?.transaction_id ? ` · ${b.payout.transaction_id}` : ''}`;
    case 'payout_failed': return `Payment failed: ${b.payout?.error_message ?? 'PayPal could not complete it.'}`;
    default:
      return b.flags.length ? b.flags.map((f) => `${CHECK_LABEL[f.check_name]}: ${f.reason}`).join(' ') : b.status === 'ready' ? 'All checks passed' : '';
  }
}

function ChecksCell({ data: b }: ICellRendererParams<BillWithDetails>) {
  if (!b) return null;
  if (b.status === 'needs_review') return <span className="text-amber-800">{checksText(b)}</span>;
  if (b.status === 'payout_pending') return <span className="text-indigo-700">{checksText(b)}</span>;
  if (b.status === 'paid') {
    return (
      <span className="text-teal-700">
        Paid via PayPal{b.payout?.transaction_id ? <> · <span className="font-mono text-xs">{b.payout.transaction_id}</span></> : null}
      </span>
    );
  }
  if (b.status === 'payout_failed') return <span className="text-rose-700">{checksText(b)}</span>;
  if (!b.flags.length) return b.status === 'ready' ? <span className="text-slate-400">All checks passed</span> : null;
  return (
    <span className="flex flex-col gap-1 py-1">
      {b.flags.map((f) => (
        <span key={f.check_name} className="leading-snug text-slate-700">
          <span className="mr-1.5 rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700">{CHECK_LABEL[f.check_name]}</span>
          {f.reason}
        </span>
      ))}
    </span>
  );
}

function StatusCell({ data: b }: ICellRendererParams<BillWithDetails>) {
  if (!b) return null;
  return (
    <span className="flex items-center gap-2">
      <BillStatusBadge status={b.status} />
      {b.status === 'needs_review' && (
        <Link href={`/bills/${b.id}/review`} className="rounded-md bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white hover:bg-amber-600">
          Review
        </Link>
      )}
    </span>
  );
}

/**
 * AG Grid Community approval table (approval-agent Requirement 1).
 * Selection is controlled by the parent so the Payment Assistant can set it too.
 */
export function BillGrid({
  bills,
  payPalReady,
  selectedIds,
  onSelectionChange,
}: {
  bills: BillWithDetails[];
  payPalReady: boolean;
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (ids: Set<string>) => void;
}) {
  const gridRef = useRef<AgGridReact<BillWithDetails>>(null);
  const [chip, setChip] = useState<Chip>('all');
  const chipRef = useRef<Chip>('all');
  const [search, setSearch] = useState('');
  const syncing = useRef(false);

  const columnDefs = useMemo<ColDef<BillWithDetails>[]>(() => [
    {
      headerName: 'Vendor', colId: 'vendor', minWidth: 170, flex: 1,
      valueGetter: (p) => p.data?.vendor_name ?? p.data?.vendor_name_raw ?? p.data?.original_filename ?? '',
      filter: 'agTextColumnFilter', cellClass: 'font-medium text-slate-900',
    },
    { headerName: 'Invoice', field: 'invoice_number', width: 115, filter: 'agTextColumnFilter', valueFormatter: (p) => p.value ?? '—' },
    { headerName: 'Bill date', field: 'bill_date', width: 125, valueFormatter: (p) => formatDate(p.value ?? null) },
    {
      headerName: 'Amount', colId: 'amount', width: 120, type: 'rightAligned',
      valueGetter: (p) => p.data?.amount_minor_units ?? null,
      valueFormatter: (p) => (p.value === null || p.value === undefined ? (p.data?.amount_text ? `$${p.data.amount_text}?` : '—') : formatCurrency(p.value)),
      cellClass: 'font-semibold tabular-nums',
    },
    {
      headerName: 'Status', colId: 'status', width: 185,
      valueGetter: (p) => (p.data ? STATUS_LABEL[p.data.status] : ''),
      cellRenderer: StatusCell,
    },
    {
      headerName: 'Checks', colId: 'checks', minWidth: 300, flex: 2,
      valueGetter: (p) => (p.data ? checksText(p.data) : ''),
      cellRenderer: ChecksCell, wrapText: true, autoHeight: true, sortable: false,
    },
    { headerName: 'Payee', field: 'payee_email', minWidth: 200, flex: 1, valueFormatter: (p) => p.value ?? '—', cellClass: 'text-slate-500' },
  ], []);

  const isRowSelectable = useCallback(
    (node: IRowNode<BillWithDetails>) => payPalReady && !!node.data && PAYABLE_STATUSES.includes(node.data.status),
    [payPalReady],
  );

  const rowSelection = useMemo(
    () => (payPalReady
      ? { mode: 'multiRow' as const, isRowSelectable, hideDisabledCheckboxes: true, selectAll: 'filtered' as const, enableClickSelection: false }
      : undefined),
    [payPalReady, isRowSelectable],
  );

  // Push external selection changes (e.g. from the assistant) into the grid.
  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    syncing.current = true;
    api.forEachNode((node) => {
      const want = selectedIds.has(node.id ?? '') && isRowSelectable(node);
      if (!!node.isSelected() !== want) node.setSelected(want);
    });
    syncing.current = false;
  }, [selectedIds, bills, isRowSelectable]);

  const onSelectionChanged = useCallback((e: SelectionChangedEvent<BillWithDetails>) => {
    if (syncing.current) return;
    onSelectionChange(new Set(e.api.getSelectedRows().map((b) => b.id)));
  }, [onSelectionChange]);

  const pickChip = (c: Chip) => {
    chipRef.current = c;
    setChip(c);
    gridRef.current?.api?.onFilterChanged();
  };

  const counts = useMemo(() => {
    const m = new Map<BillStatus, number>();
    bills.forEach((b) => m.set(b.status, (m.get(b.status) ?? 0) + 1));
    return m;
  }, [bills]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
          {CHIPS.map((c) => {
            const n = c.id === 'all' ? bills.length : counts.get(c.id) ?? 0;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => pickChip(c.id)}
                aria-pressed={chip === c.id}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                  chip === c.id ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50'
                }`}
              >
                {c.label} <span className="opacity-60">{n}</span>
              </button>
            );
          })}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search vendor, invoice, payee…"
          aria-label="Search bills"
          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 sm:w-64"
        />
      </div>
      <div className="w-full overflow-hidden border-t border-slate-200">
        <AgGridReact<BillWithDetails>
          ref={gridRef}
          theme={gridTheme}
          rowData={bills}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
          getRowId={(p: GetRowIdParams<BillWithDetails>) => p.data.id}
          rowSelection={rowSelection}
          onSelectionChanged={onSelectionChanged}
          onFirstDataRendered={() => {
            const api = gridRef.current?.api;
            api?.forEachNode((n) => { if (selectedIds.has(n.id ?? '') && isRowSelectable(n)) n.setSelected(true); });
          }}
          quickFilterText={search}
          isExternalFilterPresent={() => chipRef.current !== 'all'}
          doesExternalFilterPass={(node) => node.data?.status === chipRef.current}
          domLayout="autoHeight"
          overlayNoRowsTemplate='<span class="text-sm text-slate-500">No bills yet. Upload a few above, or try the sample bills.</span>'
          animateRows
        />
      </div>
    </div>
  );
}
