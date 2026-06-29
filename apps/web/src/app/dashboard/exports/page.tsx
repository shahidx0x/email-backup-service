'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadApi } from '../../../lib/api';

type Mailbox = { _id: string; displayName: string; emailAddress: string };
type ExportJob = {
  _id: string;
  mailboxIds: string[];
  format: 'eml' | 'mbox' | 'zip' | 'json' | 'csv';
  status: string;
  outputFilename?: string;
  outputSizeBytes?: number;
  createdAt: string;
  errorMessage?: string;
  progress: { totalMessages: number; processedMessages: number; percentage: number };
};

export default function ExportsPage() {
  const client = useQueryClient();
  const [mailboxId, setMailboxId] = useState('');
  const [format, setFormat] = useState<ExportJob['format']>('zip');
  const mailboxes = useQuery({ queryKey: ['mailboxes'], queryFn: () => api<Mailbox[]>('/mailboxes') });
  const exportsQuery = useQuery({ queryKey: ['exports'], queryFn: () => api<ExportJob[]>('/exports'), refetchInterval: 5000 });
  const create = useMutation({
    mutationFn: () => api<ExportJob>('/exports', { method: 'POST', body: JSON.stringify({ mailboxIds: [mailboxId], format, includeAttachments: true, includeMetadata: true }) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['exports'] }); },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (mailboxId) create.mutate();
  }
  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div>
        <p className="text-sm uppercase tracking-[.25em] text-sky-400">Portability</p>
        <h1 className="mt-2 text-4xl font-bold">Exports</h1>
        <p className="mt-2 text-slate-400">Generate authenticated, expiring exports from stored MongoDB and GridFS data.</p>
      </div>
      <form onSubmit={submit} className="mt-8 grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 md:grid-cols-[1fr_180px_auto]">
        <label className="grid gap-2 text-sm">Mailbox
          <select value={mailboxId} onChange={(event) => setMailboxId(event.target.value)} required className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
            <option value="">Select a mailbox</option>
            {mailboxes.data?.map((mailbox) => <option key={mailbox._id} value={mailbox._id}>{mailbox.displayName} — {mailbox.emailAddress}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-sm">Format
          <select value={format} onChange={(event) => setFormat(event.target.value as ExportJob['format'])} className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
            <option value="zip">ZIP</option><option value="mbox">MBOX</option><option value="json">JSON</option><option value="csv">CSV</option>
          </select>
        </label>
        <button disabled={create.isPending || !mailboxId} className="self-end rounded-xl bg-sky-400 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50">{create.isPending ? 'Queueing…' : 'Create export'}</button>
        {create.error && <p className="text-sm text-rose-300 md:col-span-3">{create.error.message}</p>}
      </form>
      <section className="mt-8 overflow-hidden rounded-2xl border border-slate-800">
        <div className="divide-y divide-slate-800">
          {exportsQuery.data?.map((job) => (
            <article key={job._id} className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/60 p-5">
              <div>
                <h2 className="font-semibold">{job.outputFilename || `${job.format.toUpperCase()} export`}</h2>
                <p className="mt-1 text-sm text-slate-400">Created {new Date(job.createdAt).toLocaleString()}</p>
                <p className="mt-2 text-sm">{job.progress.processedMessages} / {job.progress.totalMessages} messages · {job.progress.percentage}%</p>
                {job.errorMessage && <p className="mt-2 text-sm text-rose-300">{job.errorMessage}</p>}
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-full border border-slate-700 px-3 py-1 text-xs uppercase">{job.status}</span>
                {job.status === 'completed' && <button onClick={() => downloadApi(`/exports/${job._id}/download`, job.outputFilename || 'email-export')} className="rounded-lg bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950">Download</button>}
              </div>
            </article>
          ))}
          {exportsQuery.data?.length === 0 && <p className="bg-slate-900/60 p-8 text-center text-slate-400">No exports have been requested.</p>}
        </div>
      </section>
    </main>
  );
}
