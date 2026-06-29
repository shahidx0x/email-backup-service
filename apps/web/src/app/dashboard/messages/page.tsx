'use client';

import { FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloadApi } from '../../../lib/api';

type Address = { name?: string; address: string };
type Message = {
  _id: string;
  mailboxId: string;
  subject?: string;
  from: Address[];
  to: Address[];
  receivedAt?: string;
  bodyPreview?: string;
  hasAttachments: boolean;
  attachmentCount: number;
  sourceDeletedAt?: string;
  backupStatus: string;
};
type Result = { items: Message[]; page: number; limit: number; total: number };

export default function MessagesPage() {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['messages', search, page],
    queryFn: () => api<Result>(`/messages?search=${encodeURIComponent(search)}&page=${page}&limit=25`),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(draft.trim());
  }
  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[.25em] text-sky-400">Archive</p>
          <h1 className="mt-2 text-4xl font-bold">Messages</h1>
          <p className="mt-2 text-slate-400">Search across the mailboxes you are permitted to access.</p>
        </div>
        <form onSubmit={submit} className="flex w-full max-w-xl gap-2">
          <label className="sr-only" htmlFor="message-search">Search messages</label>
          <input id="message-search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Subject, body, sender…" className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 outline-none focus:border-sky-400" />
          <button className="rounded-xl bg-sky-400 px-5 py-3 font-semibold text-slate-950">Search</button>
        </form>
      </div>
      {query.isLoading && <p className="mt-10 text-slate-400">Loading messages…</p>}
      {query.error && <p className="mt-10 rounded-xl bg-rose-950 p-4 text-rose-300">{query.error.message}</p>}
      <div className="mt-8 overflow-hidden rounded-2xl border border-slate-800">
        <div className="divide-y divide-slate-800">
          {query.data?.items.map((message) => (
            <article key={message._id} className="bg-slate-900/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-lg font-semibold">{message.subject || '(no subject)'}</h2>
                  <p className="mt-1 truncate text-sm text-slate-400">From: {message.from.map((item) => item.name || item.address).join(', ') || 'Unknown'}</p>
                  <p className="mt-3 line-clamp-2 text-sm text-slate-300">{message.bodyPreview || 'No text preview available.'}</p>
                </div>
                <div className="text-right text-xs text-slate-400">
                  <p>{message.receivedAt ? new Date(message.receivedAt).toLocaleString() : 'Unknown date'}</p>
                  <p className="mt-2">{message.attachmentCount} attachment{message.attachmentCount === 1 ? '' : 's'}</p>
                  {message.sourceDeletedAt && <p className="mt-2 text-amber-300">Deleted at source</p>}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={() => downloadApi(`/messages/${message._id}/raw`, `${message._id}.eml`)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800">Download EML</button>
                <span className="rounded-lg bg-slate-800 px-3 py-2 text-xs uppercase tracking-wide text-slate-300">{message.backupStatus}</span>
              </div>
            </article>
          ))}
          {query.data && query.data.items.length === 0 && <p className="bg-slate-900/60 p-8 text-center text-slate-400">No messages found.</p>}
        </div>
      </div>
      {query.data && query.data.total > query.data.limit && (
        <div className="mt-6 flex items-center justify-between">
          <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-700 px-4 py-2 disabled:opacity-40">Previous</button>
          <p className="text-sm text-slate-400">Page {page} of {Math.ceil(query.data.total / query.data.limit)}</p>
          <button disabled={page * query.data.limit >= query.data.total} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-700 px-4 py-2 disabled:opacity-40">Next</button>
        </div>
      )}
    </main>
  );
}
