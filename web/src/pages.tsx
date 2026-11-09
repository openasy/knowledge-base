// To review, Gaps, Suggestions, Integrations and Settings.
import {
  Badge,
  BarList,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SegmentedControl,
  TextField,
  useAgo,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Check, FileSearch, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Article, ArticleDetail, Gap, Gaps, Member, Settings, Suggested, Suggestions } from "./api.ts";
import { NewArticleDialog } from "./articles.tsx";
import { ArticleBody, Code, fmt, host, languageName, markChanges, Notice, pct, placeName, topicName, useLoad, type Call } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";

// ---------------------------------------------------------------- To review

function ReviewArticle({
  call,
  id,
  settings,
  onDone,
}: {
  call: Call;
  id: string;
  settings: Settings;
  onDone: (a: ArticleDetail, how: "published" | "back") => void;
}) {
  const t = useT();
  const { me, can } = useAuth();
  const config = settings.config!;
  const [a] = useLoad<ArticleDetail>(call, `/api/v1/articles/${id}`);
  const [lang, setLang] = useState<string | null>(null);
  const [back, setBack] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!a) return <Panel aria-label={t("review.region")} />;
  const current = lang ?? (a.languages.includes(config.site.defaultLanguage) ? config.site.defaultLanguage : a.languages[0]!);
  const tr = a.translations.find((x) => x.lang === current) ?? a.translations[0]!;
  const own = config.review.required && a.submittedBy?.id === me.user.id;
  const act = (path: string, body: unknown, how: "published" | "back") =>
    void call<ArticleDetail>(`/api/v1/articles/${a.id}/${path}`, { method: "POST", body: JSON.stringify(body) }).then(
      (r) => onDone(r, how),
      (err: Error) => setError(err.message),
    );
  return (
    <Panel
      aria-label={t("review.region")}
      title={tr.title}
      description={t("review.byline", {
        topic: topicName(config, a.topic, t),
        owner: a.submittedBy?.name ?? a.owner.name,
        languages: a.languages.map((l) => l.toUpperCase()).join(", "),
      })}
      actions={
        can("editor") && (
          <>
            <Button size="sm" icon={<Undo2 />} onClick={() => setBack(true)}>
              {t("review.sendBack")}
            </Button>
            <Button size="sm" variant="primary" icon={<Check />} disabled={own} onClick={() => act("approve", {}, "published")}>
              {t("review.approve")}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {own && (
          <Callout tone="info" title={t("review.ownTitle")}>
            {t("review.ownDetail")}
          </Callout>
        )}
        {error && (
          <Callout tone="danger" title={t("editor.failed")}>
            {error}
          </Callout>
        )}
        {a.languages.length > 1 && (
          <SegmentedControl
            label={t("article.language")}
            value={current}
            onChange={setLang}
            options={a.languages.map((l) => ({ value: l, label: languageName(l) }))}
          />
        )}
        <ArticleBody html={markChanges(tr.html, tr.published?.html ?? null)} lang={tr.lang} className="kb-measure text-sm leading-relaxed text-fg" />
        <p className="text-xs text-fg-muted">{tr.published ? t("review.changesMarked") : t("review.newArticle")}</p>
      </div>
      <Dialog
        open={back}
        onOpenChange={setBack}
        title={t("review.backTitle")}
        description={t("review.backDetail", { name: a.submittedBy?.name ?? a.owner.name })}
        onSubmit={(e) => {
          e.preventDefault();
          setBack(false);
          act("send-back", { note }, "back");
        }}
        footer={
          <>
            <Button type="button" onClick={() => setBack(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary">
              {t("review.sendBack")}
            </Button>
          </>
        }
      >
        <TextField label={t("review.note")} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </Panel>
  );
}

export function ReviewPage({ call, settings, onChanged }: { call: Call; settings: Settings; onChanged: () => void }) {
  const t = useT();
  const ago = useAgo();
  const [data, reload] = useLoad<{ articles: Article[] }>(call, "/api/v1/articles");
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const items = (data?.articles ?? []).filter((a) => a.state === "review").sort((x, y) => (x.submittedAt ?? "").localeCompare(y.submittedAt ?? ""));
  const current = items.find((a) => a.id === active)?.id ?? items[0]?.id;
  return (
    <>
      <PageHeader title={t("review.title")} description={settings.config!.review.required ? t("review.description") : t("review.descriptionNoReview")} />
      {notice && <Notice>{notice}</Notice>}
      <div className="kb-review grid gap-2.5">
        <Panel flush title={t("review.waiting")} aria-label={t("review.waiting")}>
          {items.length ? (
            <ul className="kb-list flex flex-col py-1">
              {items.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setActive(a.id)}
                    aria-current={a.id === current ? "true" : undefined}
                    className={`kb-topic flex w-full flex-col px-3 py-1.5 text-start ${a.id === current ? "bg-accent-soft text-accent-text" : "text-fg"}`}
                  >
                    <span className="truncate text-sm font-medium">{a.title}</span>
                    <span className="text-2xs text-fg-muted">
                      {a.submittedBy?.name ?? a.owner.name} · {ago(a.submittedAt ?? a.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-sm text-fg-muted">{data === undefined ? "…" : t("review.nothing")}</p>
          )}
        </Panel>
        {current && (
          <ReviewArticle
            key={current}
            call={call}
            id={current}
            settings={settings}
            onDone={(a, how) => {
              setNotice(
                how === "published"
                  ? t("review.publishedNotice", { title: a.title, address: host(settings.helpUrl) })
                  : t("review.backNotice", { title: a.title, name: a.submittedBy?.name ?? a.owner.name }),
              );
              setActive(null);
              reload();
              onChanged();
            }}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Gaps

export function GapsPage({ call, settings, members, onChanged }: { call: Call; settings: Settings; members: Member[]; onChanged: () => void }) {
  const t = useT();
  const ago = useAgo();
  const { can } = useAuth();
  const [data, reload] = useLoad<Gaps>(call, "/api/v1/gaps");
  const [writing, setWriting] = useState<Gap | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = data?.gaps ?? [];
  const id = (g: Gap) => `${g.lang}:${g.query}`;
  const columns: Column<Gap>[] = [
    {
      id: "query",
      header: t("gaps.search"),
      width: "28%",
      sortValue: (g) => g.query,
      cell: (g) => (
        <span className="flex items-center gap-2">
          <Badge mono>{g.lang.toUpperCase()}</Badge>
          <span className="truncate font-mono text-sm">{g.query}</span>
        </span>
      ),
    },
    { id: "count", header: t("gaps.foundNothing"), align: "right", mono: true, sortValue: (g) => g.count, cell: (g) => g.count },
    {
      id: "tickets",
      header: t("gaps.thenTicket"),
      align: "right",
      sortValue: (g) => g.tickets,
      cell: (g) => <span className={`font-mono text-xs ${g.tickets >= 10 ? "font-semibold text-danger-text" : ""}`}>{g.tickets}</span>,
    },
    { id: "where", header: t("gaps.where"), cell: (g) => <span className="text-xs">{g.places.map((p) => placeName(p, t)).join(", ")}</span> },
    { id: "last", header: t("gaps.last"), sortValue: (g) => g.last, cell: (g) => <span className="text-xs whitespace-nowrap">{ago(g.last)}</span> },
    {
      id: "act",
      header: <span className="sr-only">{t("gaps.action")}</span>,
      align: "right",
      cell: (g) =>
        can("editor") && (
          <span className="flex justify-end gap-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void call("/api/v1/gaps/dismiss", { method: "POST", body: JSON.stringify({ query: g.query, lang: g.lang }) }).then(() => {
                  setNotice(t("gaps.dismissed", { query: g.query }));
                  reload();
                  onChanged();
                })
              }
            >
              {t("gaps.dismiss")}
            </Button>
            <Button size="xs" onClick={() => setWriting(g)}>
              {t("gaps.write")}
            </Button>
          </span>
        ),
    },
  ];
  const tot = data?.totals;
  const delta = tot && tot.shareBefore !== null ? Math.round((tot.share - tot.shareBefore) * 1000) / 10 : null;
  return (
    <>
      <PageHeader title={t("gaps.title")} description={t("gaps.description")} />
      {notice && <Notice>{notice}</Notice>}
      {tot && (
        <KpiGrid minWidth={170} className="mb-2.5">
          <KpiCard
            label={t("gaps.noResult")}
            value={fmt(tot.noResult)}
            unit={pct(tot.share)}
            delta={
              delta === null
                ? undefined
                : {
                    label: t("gaps.pointsSince", { points: (delta > 0 ? "+" : "") + delta }),
                    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
                    intent: delta <= 0 ? "good" : "bad",
                  }
            }
          />
          <KpiCard label={t("gaps.thenTicket")} value={fmt(tot.tickets)} tone={tot.tickets ? "warning" : undefined} />
          <KpiCard label={t("gaps.different")} value={fmt(tot.different)} unit={t("gaps.differentUnit")} />
        </KpiGrid>
      )}
      <Panel flush title={t("gaps.table")}>
        <DataTable
          label={t("gaps.table")}
          columns={columns}
          rows={rows}
          getRowId={id}
          defaultSort={{ id: "count", direction: "desc" }}
          minWidth={820}
          loading={data === undefined}
          empty={<EmptyState title={t("gaps.none")}>{t("gaps.noneDetail")}</EmptyState>}
        />
      </Panel>
      {writing && (
        <NewArticleDialog
          key={id(writing)}
          call={call}
          settings={settings}
          members={members}
          open
          onOpenChange={(o) => !o && setWriting(null)}
          initial={{
            lang: writing.lang,
            gap: { query: writing.query, lang: writing.lang },
            dialogTitle: t("gaps.dialogTitle"),
            description: t("gaps.dialogDetail", { query: writing.query, count: writing.count }),
          }}
          onCreated={(a) => {
            setNotice(t("gaps.created", { title: a.title, owner: a.owner.name, query: writing.query }));
            setWriting(null);
            reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Suggestions

export function SuggestionsPage({ call, settings }: { call: Call; settings: Settings }) {
  const t = useT();
  const [data] = useLoad<Suggestions>(call, "/api/v1/suggestions");
  const [subject, setSubject] = useState("");
  const [found, setFound] = useState<Suggested | null>(null);
  const config = settings.config!;
  useEffect(() => {
    if (subject.trim().length < 3) return setFound(null);
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ q: subject, lang: config.site.defaultLanguage, place: "preview", limit: "3" });
      void call<Suggested>(`/api/v1/suggest?${q}`).then(setFound, () => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [call, subject, config.site.defaultLanguage]);
  const tot = data?.totals;
  const diff = tot ? tot.answered - tot.answeredBefore : 0;
  return (
    <>
      <PageHeader title={t("suggestions.title")} description={t("suggestions.description")} />
      {tot && (
        <KpiGrid minWidth={170} className="mb-2.5">
          <KpiCard label={t("suggestions.shown")} value={fmt(tot.shown)} />
          <KpiCard label={t("suggestions.opened")} value={fmt(tot.opened)} unit={tot.shown ? pct(tot.opened / tot.shown) : undefined} />
          <KpiCard
            label={t("suggestions.answered")}
            value={fmt(tot.answered)}
            unit={tot.opened ? t("suggestions.ofOpened", { share: pct(tot.answered / tot.opened) }) : undefined}
            delta={{
              label: t("suggestions.vsBefore", { diff: (diff > 0 ? "+" : "") + diff }),
              direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
              intent: diff >= 0 ? "good" : "bad",
            }}
          />
          <KpiCard label={t("suggestions.stillTicket")} value={fmt(tot.ticket)} delta={{ label: t("suggestions.afterReading"), intent: "neutral" }} />
        </KpiGrid>
      )}
      <div className="kb-split-halves grid gap-2.5">
        <Panel title={t("suggestions.try")} description={t("suggestions.tryDetail")}>
          <div className="flex flex-col gap-3 rounded-md border border-line bg-canvas p-3">
            <TextField
              label={t("suggestions.subject")}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("suggestions.subjectPlaceholder")}
            />
            <section aria-label={t("suggestions.suggested")} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-semibold text-fg-muted">{t("suggestions.mayAnswer")}</h3>
              {found?.articles.length ? (
                <ul className="kb-list flex flex-col gap-1">
                  {found.articles.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 rounded border border-line bg-surface px-2.5 py-1.5 text-sm">
                      <FileSearch aria-hidden className="size-3.5 shrink-0 text-accent" />
                      <span className="truncate text-fg" lang={a.lang}>
                        {a.title}
                      </span>
                      {a.helpful !== null && <span className="ml-auto shrink-0 text-2xs text-fg-muted">{t("suggestions.foundHelpful", { n: a.helpful })}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-fg-muted">{subject.trim().length < 3 ? t("suggestions.typeSome") : t("suggestions.noMatch")}</p>
              )}
            </section>
          </div>
        </Panel>
        <Panel title={t("suggestions.byPlace")} description={t("suggestions.days", { count: 30 })}>
          {data?.byPlace.length ? (
            <BarList label={t("suggestions.byPlace")} items={data.byPlace.map((p) => ({ id: p.place, label: placeName(p.place, t), value: p.answered }))} />
          ) : (
            <EmptyState title={t("suggestions.none")}>{t("suggestions.noneDetail")}</EmptyState>
          )}
          <p className="mt-3 text-xs text-fg-muted">{t("suggestions.helpdeskNote")}</p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Integrations

export function IntegrationsPage({ settings }: { settings: Settings }) {
  const t = useT();
  const origin = window.location.origin;
  const config = settings.config!;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="kb-split-halves grid gap-2.5">
        <Panel title={t("integrations.helpdesk")} description={t("integrations.helpdeskDetail")}>
          <Code label={t("integrations.helpdesk")}>{`<script defer src="${origin}/s/suggest.js"></script>
<input name="subject" data-openasy-kb="helpdesk-form">`}</Code>
        </Panel>
        <Panel title={t("integrations.chat")} description={t("integrations.chatDetail")}>
          <Code label={t("integrations.chat")}>{`<script defer src="${origin}/s/suggest.js"></script>
<script>
  const kb = OpenAsyKB.attach({ input: "#chat-message", place: "live-chat", lang: "${config.site.defaultLanguage}" });
  // when the chat is started anyway: kb.done("ticket"); closed without one: kb.done("closed")
</script>`}</Code>
        </Panel>
        <Panel title={t("integrations.api")} description={t("integrations.apiDetail")}>
          <Code
            label={t("integrations.api")}
          >{`curl -s "${origin}/api/v1/suggest?q=reset+password&lang=${config.site.defaultLanguage}&place=helpdesk-agent&limit=3"`}</Code>
          <p className="mt-2 text-xs">
            <a href="/api/docs/">{t("integrations.reference")}</a>
          </p>
        </Panel>
        <Panel
          title={t("integrations.analytics")}
          description={config.site.analytics ? t("integrations.analyticsOn", { script: config.site.analytics }) : t("integrations.analyticsOff")}
        >
          <Code label={t("integrations.analytics")}>{`site:
  analytics: https://analytics.example.com/s/help.js`}</Code>
        </Panel>
        <Panel title={t("integrations.sites")} description={t("integrations.sitesDetail")}>
          {config.suggest.sites.length ? (
            <ul className="kb-list flex flex-col gap-1 font-mono text-xs">
              {config.suggest.sites.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">{t("integrations.noSites")}</p>
          )}
        </Panel>
        {config.plans.length > 0 && (
          <Panel title={t("integrations.readers")} description={t("integrations.readersDetail", { key: config.readers.key })}>
            <Code label={t("integrations.readers")}>{`${settings.helpUrl}/reader?token=<v1 token>&to=/${config.site.defaultLanguage}/articles/<slug>`}</Code>
          </Panel>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

export function SettingsFilePage({ settings }: { settings: Settings }) {
  const t = useT();
  const ago = useAgo();
  const c = settings.config!;
  const file = settings.file;
  const name = file?.path.split("/").pop() ?? "knowledge-base.yaml";
  const languages = c.site.languages
    .map((l) => (l === c.site.defaultLanguage ? t("settings.defaultLanguage", { language: languageName(l) }) : languageName(l)))
    .join(", ");
  return (
    <FileSettingsPage
      file={name}
      applied={file?.appliedAt ? ago(file.appliedAt) : t("settings.notYet")}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        file && (file.error || file.warnings.length > 0) ? (
          <Callout tone={file.error ? "danger" : "warning"} title={file.error ? t("settings.notApplied") : t("settings.warnings")} className="mb-2.5">
            <ul className="kb-list flex flex-col gap-1">
              {[...(file.error ? [file.error] : []), ...file.warnings].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : undefined
      }
      groups={[
        {
          title: t("settings.helpCenter"),
          items: [
            { label: t("settings.name"), value: c.site.name, path: "site.name" },
            { label: t("settings.address"), value: <span className="font-mono">{settings.helpUrl}</span>, path: "site.address" },
            { label: t("settings.languages"), value: languages, path: "site.languages" },
            { label: t("settings.topics"), value: c.topics.length ? c.topics.map((x) => x.name).join(", ") : t("settings.none"), path: "topics" },
            { label: t("settings.analytics"), value: c.site.analytics ?? t("settings.off"), path: "site.analytics" },
          ],
        },
        {
          title: t("settings.publishing"),
          items: [
            { label: t("settings.review"), value: c.review.required ? t("settings.reviewOn") : t("settings.reviewOff"), path: "review.required" },
            {
              label: t("settings.helpful"),
              value: t("settings.helpfulValue", { share: c.helpful.listBelow, count: c.helpful.minAnswers }),
              path: "helpful.list_below",
            },
            {
              label: t("settings.plans"),
              value: c.plans.length ? t("settings.plansValue", { plans: c.plans.map((p) => p.name).join(", "), key: c.readers.key }) : t("settings.none"),
              path: "plans",
            },
            { label: t("settings.suggestIn"), value: c.suggest.in.map((p) => placeName(p, t)).join(", "), path: "suggest.in" },
            { label: t("settings.sites"), value: c.suggest.sites.length ? c.suggest.sites.join(", ") : t("settings.none"), path: "suggest.sites" },
          ],
        },
      ]}
    />
  );
}
