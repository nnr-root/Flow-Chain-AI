"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { errorText, getJson, sendJson } from "@/lib/api";
import type { ChannelView, PostView } from "@/lib/publishing";
import type { SeriesView } from "@/lib/series";
import { Button, ErrorNote, Field, Panel } from "./ui";

/** The account page's channels: the user's own, connected on the platform's consent page, each removable. */
export function Channels({ channels, note }: { channels: ChannelView[]; note?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const remove = (id: string) => {
    setBusy(id);
    setError("");
    sendJson(`/api/channels/${id}`, {}, "DELETE").then(
      () => {
        setBusy("");
        router.refresh();
      },
      (err: unknown) => {
        setError(errorText(err));
        setBusy("");
      },
    );
  };
  return (
    <Panel title="Your channels">
      <div className="space-y-4">
        {note && <p role="status" data-testid="channel-note" className="rounded-[18px] bg-wash px-4 py-3 text-[0.95rem]">{note}</p>}
        {channels.length === 0 ? (
          <p className="max-w-[40rem] text-graphite">Connect your YouTube channel and a finished video can be published to it from its page, in your name. You allow it on Google's own page; the studio never asks for your password, and can upload videos and nothing else.</p>
        ) : (
          <ul className="space-y-2" data-testid="channels">
            {channels.map((c) => (
              <li key={c.id} className="flex items-center gap-4 rounded-[18px] bg-sheet px-5 py-3.5">
                <span className="min-w-0 flex-1 truncate"><span className="font-bold">{c.title || "Your channel"}</span><span className="text-graphite">, YouTube</span></span>
                <Button data-testid="channel-remove" onClick={() => remove(c.id)} disabled={!!busy}>{busy === c.id ? "Removing…" : "Disconnect"}</Button>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote>{error}</ErrorNote>
        {/* a full page load: it leaves the studio for the consent page */}
        <p><a href="/auth/youtube" data-testid="channel-connect" className="inline-block rounded-full bg-wash px-4 py-2 text-[0.95rem] font-bold hover:bg-[#333]">{channels.length === 0 ? "Connect YouTube" : "Connect another channel"}</a></p>
      </div>
    </Panel>
  );
}

/** On a finished video's page: publish it to one of the user's channels, and see what became of that. */
export function RunPublish({ runId }: { runId: string }) {
  const [data, setData] = useState<{ channels: ChannelView[]; posts: PostView[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => getJson<{ channels: ChannelView[]; posts: PostView[] }>(`/api/runs/${runId}/publish`).then(setData, () => {}), [runId]);
  useEffect(() => void load(), [load]);
  // while a post is on its way, ask how it is doing
  const waiting = data?.posts.some((p) => p.status === "queued") ?? false;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [waiting, load]);
  if (!data) return null;
  const publish = (channelId: string) => {
    setBusy(channelId);
    setError("");
    sendJson(`/api/runs/${runId}/publish`, { channelId }).then(
      () => load().then(() => setBusy("")),
      (err: unknown) => {
        setError(errorText(err));
        setBusy("");
      },
    );
  };
  return (
    <Panel title="Publish">
      <div className="space-y-3" data-testid="run-publish">
        {data.channels.length === 0 && <p className="text-graphite">No channel is connected. <a href="/account" className="underline underline-offset-4">Connect your YouTube channel</a> to publish this video to it.</p>}
        {data.channels.map((c) => {
          const post = data.posts.find((p) => p.channelId === c.id);
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[18px] bg-sheet px-5 py-3.5" data-testid="publish-row" data-status={post?.status ?? "none"}>
              <span className="min-w-0 flex-1 truncate"><span className="font-bold">{c.title || "Your channel"}</span><span className="text-graphite">, YouTube</span></span>
              {post?.status === "posted" && post.url ? (
                <a href={post.url} target="_blank" rel="noreferrer" className="font-bold underline underline-offset-4" data-testid="post-link">Published: watch it there</a>
              ) : post?.status === "queued" ? (
                <span className="note text-graphite">Publishing…</span>
              ) : (
                <Button tone="primary" data-testid="publish" onClick={() => publish(c.id)} disabled={!!busy}>{busy === c.id ? "Sending…" : post?.status === "failed" ? "Try again" : "Publish to this channel"}</Button>
              )}
              {post?.status === "failed" && post.error && <p role="alert" className="w-full text-[0.9rem] text-bad" data-testid="post-error">{post.error}</p>}
            </div>
          );
        })}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Panel>
  );
}

/** On a series' page: where its videos go, and whether its owner sees each one before it is published. */
export function SeriesPublishing({ series, channels }: { series: SeriesView; channels: ChannelView[] }) {
  const router = useRouter();
  const [channelId, setChannelId] = useState(series.channelId ?? "");
  const [reviewFirst, setReviewFirst] = useState(series.reviewFirst);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = channelId !== (series.channelId ?? "") || reviewFirst !== series.reviewFirst;
  const save = () => {
    setBusy(true);
    setError("");
    sendJson(`/api/series/${series.id}`, { publishing: { channelId: channelId || null, reviewFirst } }, "PATCH").then(
      () => {
        setBusy(false);
        router.refresh();
      },
      (err: unknown) => {
        setError(errorText(err));
        setBusy(false);
      },
    );
  };
  return (
    <Panel title="Where its videos go">
      <div className="space-y-5">
        {channels.length === 0 ? (
          <p className="text-graphite">Nowhere yet. <a href="/account" className="underline underline-offset-4">Connect your YouTube channel</a> and this series can publish to it.</p>
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Channel">
                <select data-testid="series-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="">None: I publish them myself</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>{c.title || "Your channel"} (YouTube)</option>)}
                </select>
              </Field>
            </div>
            {channelId && (
              <label className="flex max-w-[44rem] items-start gap-3 text-[0.95rem]">
                <input type="checkbox" data-testid="series-review" className="mt-1" checked={reviewFirst} onChange={(e) => setReviewFirst(e.target.checked)} />
                <span>
                  <span className="font-bold">Show me each video first</span>
                  <span className="block text-graphite">{reviewFirst ? "A finished video waits for you: it is published when you press Publish on its page." : "A finished video is published at once, without you seeing it. A video that came out wrong is published too."}</span>
                </span>
              </label>
            )}
            <ErrorNote>{error}</ErrorNote>
            <Button tone="primary" data-testid="save-publishing" onClick={save} disabled={busy || !changed}>{busy ? "Saving…" : "Save"}</Button>
          </>
        )}
      </div>
    </Panel>
  );
}
