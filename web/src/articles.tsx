// Articles: the list by topic, one article in each language with what readers made of it, the editor, and writing a
// new one or importing them from another help center.
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  navigate,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  Tabs,
  TextField,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ExternalLink, FileText, PenLine, Plus, Send, ThumbsUp, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Article, ArticleDetail, Format, Member, Settings, State } from "./api.ts";
import { ArticleBody, date, fmt, languageName, Notice, STATE_TONE, topicName, useLoad, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

const stateLabel = (s: State, t: T) => t(`state.${s}`);

function StateBadges({ a }: { a: Article }) {
  const t = useT();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <StatusBadge tone={STATE_TONE[a.state]}>{stateLabel(a.state, t)}</StatusBadge>
      {a.live && a.state !== "published" && <Badge tone="success">{t("articles.live")}</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------- One article, beside the list

function ArticlePanel({ call, id, settings }: { call: Call; id: string; settings: Settings }) {
  const t = useT();
  const [a] = useLoad<ArticleDetail>(call, `/api/v1/articles/${id}`);
  const config = settings.config!;
  const langs = config.site.languages;
  const [lang, setLang] = useState<string | null>(null);
  if (a === undefined) return <Panel aria-label={t("article.region")} className="kb-article-panel" />;
  if (a === null) return <EmptyState title={t("article.failed")} />;
  const current = lang ?? (a.languages.includes(config.site.defaultLanguage) ? config.site.defaultLanguage : (a.languages[0] ?? config.site.defaultLanguage));
  const tr = a.translations.find((x) => x.lang === current);
  const words = tr ? (a.live && tr.published ? tr.published : { title: tr.title, html: tr.html }) : null;
  const planNames = a.plans.map((p) => config.plans.find((x) => x.id === p)?.name ?? p).join(", ");
  return (
    <Panel
      className="kb-article-panel"
      aria-label={t("article.region")}
      title={words?.title ?? a.title}
      description={t("article.byline", { topic: topicName(config, a.topic, t), owner: a.owner.name, updated: date(a.updatedAt) })}
      actions={<StateBadges a={a} />}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {langs.length > 1 && (
            <SegmentedControl
              label={t("article.language")}
              value={current}
              onChange={setLang}
              options={langs.map((l) => ({ value: l, label: a.languages.includes(l) ? languageName(l) : t("article.missing", { language: languageName(l) }) }))}
            />
          )}
          {a.plans.length > 0 && <Badge tone="info">{t("article.plansOnly", { plans: planNames })}</Badge>}
        </div>
        {!words ? (
          <Callout tone="warning" title={t("article.noVersion", { language: languageName(current) })}>
            {t("article.noVersionDetail", { language: languageName(config.site.defaultLanguage) })}
          </Callout>
        ) : (
          <ArticleBody html={words.html} lang={current} className="text-sm leading-relaxed text-fg" />
        )}
        {a.live && (
          <dl className="kb-facts grid gap-x-2 gap-y-1.5 border-t border-line pt-2.5 text-xs">
            <dt className="text-fg-muted">{t("article.views")}</dt>
            <dd className="m-0 font-mono text-fg tabular-nums">{fmt(a.views)}</dd>
            <dt className="text-fg-muted">{t("article.didItHelp")}</dt>
            <dd className="m-0 flex items-center gap-2 text-fg">
              {a.helpful === null ? (
                t("article.noAnswers")
              ) : (
                <>
                  <span className="flex items-center gap-1">
                    <ThumbsUp aria-hidden className="size-3 text-success" />
                    {a.helpful}%
                  </span>
                  <span className="text-fg-muted">{t("article.ofAnswers", { count: a.votes })}</span>
                </>
              )}
            </dd>
            <dt className="text-fg-muted">{t("article.answered")}</dt>
            <dd className="m-0 text-fg">{t("article.answeredDetail", { count: a.answered })}</dd>
            <dt className="text-fg-muted">{t("article.readers")}</dt>
            <dd className="m-0 text-fg">{a.plans.length ? planNames : t("article.everyone")}</dd>
          </dl>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<PenLine />} onClick={() => navigate(`/articles/${a.id}`)}>
            {t("article.edit")}
          </Button>
          {a.url && (
            <Button
              size="sm"
              variant="ghost"
              icon={<ExternalLink />}
              onClick={() => window.open(`${a.url!.replace(/\/[^/]+\/articles\//, `/${current}/articles/`)}`, "_blank", "noopener")}
            >
              {t("article.view")}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- New article and import

function NewArticleDialog({
  call,
  settings,
  members,
  open,
  onOpenChange,
  initial,
  onCreated,
}: {
  call: Call;
  settings: Settings;
  members: Member[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: { title?: string; lang?: string; gap?: { query: string; lang: string }; description?: string; dialogTitle?: string };
  onCreated: (a: ArticleDetail) => void;
}) {
  const t = useT();
  const { me } = useAuth();
  const config = settings.config!;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [lang, setLang] = useState(initial?.lang && config.site.languages.includes(initial.lang) ? initial.lang : config.site.defaultLanguage);
  const [topic, setTopic] = useState("");
  const [owner, setOwner] = useState(me.user.id);
  const [error, setError] = useState<string | null>(null);
  const owners = members.some((m) => m.id === me.user.id) ? members : [{ id: me.user.id, name: me.user.name, email: me.user.email }, ...members];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={initial?.dialogTitle ?? t("new.title")}
      description={initial?.description}
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        void call<ArticleDetail>("/api/v1/articles", {
          method: "POST",
          body: JSON.stringify({ title: title.trim(), lang, topic: topic || null, owner, ...(initial?.gap && { gap: initial.gap }) }),
        }).then(onCreated, (err: Error) => setError(err.message));
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            {t("new.create")}
          </Button>
        </>
      }
    >
      <TextField label={t("new.titleField")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      {config.site.languages.length > 1 && (
        <SelectField
          label={t("new.language")}
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          options={config.site.languages.map((l) => ({ value: l, label: languageName(l) }))}
        />
      )}
      <SelectField
        label={t("new.topic")}
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        options={[{ value: "", label: t("articles.noTopic") }, ...config.topics.map((x) => ({ value: x.slug, label: x.name }))]}
      />
      <SelectField
        label={t("new.owner")}
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        options={owners.map((m) => ({ value: m.id, label: m.name }))}
      />
      {initial?.gap && <p className="text-xs text-fg-muted">{t("gaps.linkedHint")}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </Dialog>
  );
}

function ImportDialog({
  call,
  settings,
  open,
  onOpenChange,
  onDone,
}: {
  call: Call;
  settings: Settings;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (created: number, skipped: number) => void;
}) {
  const t = useT();
  const config = settings.config!;
  const [format, setFormat] = useState<Format>("markdown");
  const [lang, setLang] = useState(config.site.defaultLanguage);
  const [topic, setTopic] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("import.title")}
      description={t("import.description")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!files.length) return;
        setBusy(true);
        void Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() })))
          .then((list) =>
            call<{ created: Article[]; skipped: unknown[] }>("/api/v1/import", {
              method: "POST",
              body: JSON.stringify({ format, lang, topic: topic || null, files: list }),
            }),
          )
          .then(
            (r) => onDone(r.created.length, r.skipped.length),
            (err: Error) => setError(err.message),
          )
          .finally(() => setBusy(false));
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" icon={<Upload />} disabled={!files.length || busy}>
            {t("import.run", { count: files.length })}
          </Button>
        </>
      }
    >
      <SegmentedControl<Format>
        label={t("import.format")}
        value={format}
        onChange={(f) => (setFormat(f), setFiles([]))}
        options={[
          { value: "markdown", label: "Markdown" },
          { value: "html", label: "HTML" },
        ]}
      />
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-fg">{t("import.files")}</span>
        <input
          key={format}
          type="file"
          multiple
          accept={format === "markdown" ? ".md,.markdown,.txt,text/markdown" : ".html,.htm,text/html"}
          onChange={(e) => setFiles([...(e.target.files ?? [])])}
          className="text-sm"
        />
      </label>
      {config.site.languages.length > 1 && (
        <SelectField
          label={t("import.language")}
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          options={config.site.languages.map((l) => ({ value: l, label: languageName(l) }))}
        />
      )}
      <SelectField
        label={t("new.topic")}
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        options={[{ value: "", label: t("articles.noTopic") }, ...config.topics.map((x) => ({ value: x.slug, label: x.name }))]}
      />
      <p className="text-xs text-fg-muted">{t("import.hint")}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- The list

export function ArticlesPage({ call, settings, members, onChanged }: { call: Call; settings: Settings; members: Member[]; onChanged: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const config = settings.config!;
  const [data, reload] = useLoad<{ articles: Article[] }>(call, "/api/v1/articles");
  const [topic, setTopic] = useState("all");
  const [state, setState] = useState<"all" | State>("all");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const all = useMemo(() => data?.articles ?? [], [data]);
  const known = new Set(config.topics.map((x) => x.slug));
  const inTopic = (a: Article, tp: string) => tp === "all" || (tp === "other" ? !a.topic || !known.has(a.topic) : a.topic === tp);
  const words = query.toLocaleLowerCase().trim();
  const rows = all.filter(
    (a) =>
      inTopic(a, topic) && (state === "all" || a.state === state) && (!words || Object.values(a.titles).some((x) => x.toLocaleLowerCase().includes(words))),
  );
  const current = active && all.some((a) => a.id === active) ? active : (rows[0]?.id ?? null);
  const hasOther = all.some((a) => inTopic(a, "other"));
  const topics = [
    { slug: "all", name: t("articles.allTopics") },
    ...config.topics.map((x) => ({ slug: x.slug, name: x.name })),
    ...(hasOther ? [{ slug: "other", name: t("articles.noTopic") }] : []),
  ];
  const columns: Column<Article>[] = [
    {
      id: "title",
      header: t("articles.article"),
      width: "36%",
      sortValue: (a) => a.title,
      cell: (a) => (
        <span className="flex min-w-0 items-center gap-2">
          <FileText aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{a.title}</span>
            <span className="truncate text-2xs text-fg-muted">{topicName(config, a.topic, t)}</span>
          </span>
        </span>
      ),
    },
    {
      id: "langs",
      header: t("articles.languages"),
      cell: (a) => (
        <span className="flex gap-1 whitespace-nowrap">
          {config.site.languages.map((l) => (
            <Badge key={l} mono tone={a.languages.includes(l) ? "neutral" : "warning"}>
              {a.languages.includes(l) ? l.toUpperCase() : t("articles.langMissing", { lang: l.toUpperCase() })}
            </Badge>
          ))}
        </span>
      ),
    },
    { id: "state", header: t("articles.state"), cell: (a) => <StateBadges a={a} /> },
    { id: "views", header: t("articles.views"), align: "right", mono: true, sortValue: (a) => a.views, cell: (a) => (a.views ? fmt(a.views) : "–") },
    {
      id: "helpful",
      header: t("articles.helpful"),
      align: "right",
      sortValue: (a) => a.helpful ?? -1,
      cell: (a) =>
        a.helpful === null ? (
          "–"
        ) : (
          <span className={`font-mono text-xs ${a.helpful < config.helpful.listBelow ? "font-semibold text-danger-text" : ""}`}>{a.helpful}%</span>
        ),
    },
    {
      id: "updated",
      header: t("articles.updated"),
      sortValue: (a) => a.updatedAt,
      cell: (a) => <span className="text-xs whitespace-nowrap">{date(a.updatedAt)}</span>,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("articles.title")}
        description={t("articles.description", {
          languages: config.site.languages.map(languageName).join(", "),
          default: languageName(config.site.defaultLanguage),
        })}
        actions={
          can("editor") && (
            <>
              <Button icon={<Upload />} onClick={() => setImporting(true)}>
                {t("articles.import")}
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                {t("articles.new")}
              </Button>
            </>
          )
        }
      />
      {notice && <Notice>{notice}</Notice>}
      <div className="kb-articles grid gap-2.5">
        <Panel flush aria-label={t("articles.topics")}>
          <ul className="kb-list flex flex-col py-1">
            {topics.map((tp) => (
              <li key={tp.slug}>
                <button
                  type="button"
                  onClick={() => setTopic(tp.slug)}
                  aria-current={tp.slug === topic ? "true" : undefined}
                  className={`kb-topic flex w-full items-center justify-between gap-2 px-3 py-1.5 text-start text-sm ${tp.slug === topic ? "bg-accent-soft text-accent-text" : "text-fg"}`}
                >
                  <span className="truncate">{tp.name}</span>
                  <span className="text-2xs text-fg-muted tabular-nums">{all.filter((a) => inTopic(a, tp.slug)).length}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel flush aria-label={t("articles.list")}>
          <div className="flex flex-wrap items-end justify-between gap-2 px-3 pt-2">
            <Tabs
              label={t("articles.state")}
              value={state}
              onChange={setState}
              items={[
                { value: "all", label: t("articles.all") },
                { value: "published", label: t("state.published") },
                { value: "review", label: t("state.review") },
                { value: "draft", label: t("articles.drafts") },
              ]}
              className="border-b-0"
            />
            <SearchInput
              label={t("articles.search")}
              placeholder={t("articles.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="kb-search pb-1.5"
            />
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("articles.title")}
              columns={columns}
              rows={rows}
              getRowId={(a) => a.id}
              onRowClick={(a) => setActive(a.id)}
              activeRowId={current ?? undefined}
              minWidth={720}
              loading={data === undefined}
              empty={all.length ? t("articles.noMatch") : <EmptyState title={t("articles.none")}>{t("articles.noneDetail")}</EmptyState>}
            />
          </div>
        </Panel>
        {current && <ArticlePanel key={current} call={call} id={current} settings={settings} />}
      </div>
      {creating && (
        <NewArticleDialog
          call={call}
          settings={settings}
          members={members}
          open
          onOpenChange={setCreating}
          onCreated={(a) => {
            onChanged();
            navigate(`/articles/${a.id}`);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          call={call}
          settings={settings}
          open
          onOpenChange={setImporting}
          onDone={(created, skipped) => {
            setImporting(false);
            setNotice(skipped ? t("import.doneSkipped", { count: created, skipped }) : t("import.done", { count: created }));
            reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}

export { NewArticleDialog };

// ---------------------------------------------------------------- The editor

interface Draft {
  title: string;
  body: string;
  format: Format;
}

export function EditorPage({
  call,
  id,
  settings,
  members,
  onChanged,
}: {
  call: Call;
  id: string;
  settings: Settings;
  members: Member[];
  onChanged: () => void;
}) {
  const t = useT();
  const { can, me } = useAuth();
  const config = settings.config!;
  const [a, reload] = useLoad<ArticleDetail>(call, `/api/v1/articles/${id}`);
  const [lang, setLang] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [meta, setMeta] = useState<{ topic: string; owner: string; plans: string[]; slug: string } | null>(null);
  const [preview, setPreview] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!a) return;
    setDrafts(Object.fromEntries(a.translations.map((x) => [x.lang, { title: x.title, body: x.source, format: x.format }])));
    setMeta({ topic: a.topic ?? "", owner: a.owner.id ?? "", plans: a.plans, slug: a.slug });
  }, [a]);

  const current =
    lang ?? (a ? (a.languages.includes(config.site.defaultLanguage) ? config.site.defaultLanguage : (a.languages[0] ?? config.site.defaultLanguage)) : "");
  const draft = drafts[current];

  useEffect(() => {
    if (!draft) return setPreview("");
    const timer = setTimeout(() => {
      void call<{ html: string }>("/api/v1/preview", { method: "POST", body: JSON.stringify({ body: draft.body, format: draft.format }) }).then(
        (r) => setPreview(r.html),
        () => {},
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [call, draft]);

  if (a === undefined || !meta) return <PageHeader title={t("editor.loading")} />;
  if (a === null) return <EmptyState title={t("article.failed")} />;
  const editor = can("editor");
  const changed = a.translations.filter((x) => {
    const d = drafts[x.lang];
    return d && (d.title !== x.title || d.body !== x.source || d.format !== x.format);
  });
  const added = Object.keys(drafts).filter((l) => !a.languages.includes(l));
  const metaChanged = meta.topic !== (a.topic ?? "") || meta.owner !== (a.owner.id ?? "") || meta.slug !== a.slug || meta.plans.join() !== a.plans.join();
  const dirty = changed.length > 0 || added.length > 0 || metaChanged;
  const owners = members.some((m) => m.id === a.owner.id) || !a.owner.id ? members : [{ id: a.owner.id, name: a.owner.name, email: "" }, ...members];
  const ownAndRequired = config.review.required && a.submittedBy?.id === me.user.id;

  const save = async () => {
    const translations = Object.fromEntries([...changed.map((x) => x.lang), ...added].map((l) => [l, drafts[l]!]));
    const body = {
      ...(Object.keys(translations).length && { translations }),
      ...(meta.topic !== (a.topic ?? "") && { topic: meta.topic || null }),
      ...(meta.owner !== (a.owner.id ?? "") && { owner: meta.owner }),
      ...(meta.slug !== a.slug && { slug: meta.slug }),
      ...(meta.plans.join() !== a.plans.join() && { plans: meta.plans }),
    };
    await call(`/api/v1/articles/${a.id}`, { method: "PATCH", body: JSON.stringify(body) });
  };
  const act = (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    void fn().then(
      () => (setNotice(done), reload(), onChanged()),
      (err: Error) => setError(err.message),
    );
  };

  return (
    <>
      <PageHeader
        title={a.title || t("editor.untitled")}
        description={t("editor.description", { topic: topicName(config, a.topic, t), owner: a.owner.name })}
        meta={<StateBadges a={a} />}
        actions={
          editor && (
            <>
              {a.url && (
                <Button icon={<ExternalLink />} variant="ghost" onClick={() => window.open(a.url!, "_blank", "noopener")}>
                  {t("article.view")}
                </Button>
              )}
              <Button disabled={!dirty} onClick={() => act(save, t("editor.saved"))}>
                {t("editor.save")}
              </Button>
              {a.state === "draft" && (
                <Button
                  variant="primary"
                  icon={<Send />}
                  onClick={() =>
                    act(
                      async () => (dirty && (await save()), call(`/api/v1/articles/${a.id}/submit`, { method: "POST" })),
                      config.review.required ? t("editor.sentForReview") : t("editor.published", { address: settings.helpUrl }),
                    )
                  }
                >
                  {config.review.required ? t("editor.submit") : t("editor.publish")}
                </Button>
              )}
            </>
          )
        }
      />
      {notice && <Notice>{notice}</Notice>}
      {error && (
        <Callout tone="danger" title={t("editor.failed")} className="mb-2.5">
          {error}
        </Callout>
      )}
      {a.note && a.state === "draft" && (
        <Callout tone="warning" title={t("editor.sentBack", { name: a.reviewedBy?.name ?? "" })} className="mb-2.5">
          {a.note}
        </Callout>
      )}
      {a.state === "review" && (
        <Callout tone="info" title={t("editor.inReview")} className="mb-2.5">
          {ownAndRequired ? t("editor.inReviewOwn") : t("editor.inReviewDetail")}
        </Callout>
      )}
      {a.live && a.state === "draft" && (
        <Callout tone="info" title={t("editor.liveDraft")} className="mb-2.5">
          {t("editor.liveDraftDetail")}
        </Callout>
      )}
      <div className="kb-editor grid gap-2.5">
        <Panel title={t("editor.words")} aria-label={t("editor.words")}>
          <div className="flex flex-col gap-3">
            {config.site.languages.length > 1 && (
              <SegmentedControl
                label={t("article.language")}
                value={current}
                onChange={setLang}
                options={config.site.languages.map((l) => ({
                  value: l,
                  label: drafts[l] ? languageName(l) : t("article.missing", { language: languageName(l) }),
                }))}
              />
            )}
            {draft ? (
              <>
                <TextField
                  label={t("editor.titleField")}
                  value={draft.title}
                  maxLength={200}
                  disabled={!editor}
                  onChange={(e) => setDrafts({ ...drafts, [current]: { ...draft, title: e.target.value } })}
                />
                <SegmentedControl<Format>
                  label={t("editor.format")}
                  size="sm"
                  value={draft.format}
                  onChange={(f) => editor && setDrafts({ ...drafts, [current]: { ...draft, format: f } })}
                  options={[
                    { value: "markdown", label: "Markdown" },
                    { value: "html", label: "HTML" },
                  ]}
                />
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-fg">{t("editor.body")}</span>
                  <textarea
                    className="kb-textarea"
                    value={draft.body}
                    rows={18}
                    readOnly={!editor}
                    spellCheck
                    lang={current}
                    onChange={(e) => setDrafts({ ...drafts, [current]: { ...draft, body: e.target.value } })}
                  />
                  <span className="text-xs text-fg-muted">{t("editor.bodyHint")}</span>
                </label>
                {editor && a.languages.length > 1 && a.languages.includes(current) && (
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 />}
                      onClick={() =>
                        act(
                          () => call(`/api/v1/articles/${a.id}`, { method: "PATCH", body: JSON.stringify({ translations: { [current]: null } }) }),
                          t("editor.languageRemoved", { language: languageName(current) }),
                        )
                      }
                    >
                      {t("editor.removeLanguage", { language: languageName(current) })}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                title={t("article.noVersion", { language: languageName(current) })}
                action={
                  editor && (
                    <Button
                      icon={<Plus />}
                      onClick={() => {
                        const from = drafts[config.site.defaultLanguage] ?? Object.values(drafts)[0];
                        setDrafts({ ...drafts, [current]: { title: from?.title ?? "", body: from?.body ?? "", format: from?.format ?? "markdown" } });
                      }}
                    >
                      {t("editor.addLanguage", { language: languageName(current) })}
                    </Button>
                  )
                }
              >
                {t("article.noVersionDetail", { language: languageName(config.site.defaultLanguage) })}
              </EmptyState>
            )}
          </div>
        </Panel>
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("editor.preview")} description={t("editor.previewDetail")}>
            {draft ? (
              <article lang={current} className="flex flex-col gap-2">
                <h2 className="text-base font-semibold text-fg">{draft.title}</h2>
                <ArticleBody html={preview} className="text-sm leading-relaxed text-fg" />
              </article>
            ) : (
              <p className="text-sm text-fg-muted">–</p>
            )}
          </Panel>
          <Panel title={t("editor.details")}>
            <div className="flex flex-col gap-3">
              <SelectField
                label={t("new.topic")}
                value={meta.topic}
                disabled={!editor}
                onChange={(e) => setMeta({ ...meta, topic: e.target.value })}
                options={[{ value: "", label: t("articles.noTopic") }, ...config.topics.map((x) => ({ value: x.slug, label: x.name }))]}
              />
              <SelectField
                label={t("new.owner")}
                value={meta.owner}
                disabled={!editor}
                onChange={(e) => setMeta({ ...meta, owner: e.target.value })}
                options={owners.map((m) => ({ value: m.id, label: m.name }))}
              />
              <TextField
                label={t("editor.slug")}
                mono
                value={meta.slug}
                disabled={!editor}
                hint={t("editor.slugHint", { address: `${settings.helpUrl}/${current}/articles/${meta.slug}` })}
                onChange={(e) => setMeta({ ...meta, slug: e.target.value.toLowerCase() })}
              />
              {config.plans.length > 0 && (
                <fieldset className="m-0 flex flex-col gap-1.5 border-0">
                  <legend className="mb-1 text-sm font-medium text-fg">{t("editor.readers")}</legend>
                  {config.plans.map((p) => (
                    <Checkbox
                      key={p.id}
                      label={p.name}
                      checked={meta.plans.includes(p.id)}
                      disabled={!editor}
                      onChange={(e) => setMeta({ ...meta, plans: e.target.checked ? [...meta.plans, p.id] : meta.plans.filter((x) => x !== p.id) })}
                    />
                  ))}
                  <span className="text-xs text-fg-muted">{meta.plans.length ? t("editor.readersPlans") : t("editor.readersEveryone")}</span>
                </fieldset>
              )}
              {editor && (
                <div className="flex flex-wrap gap-1.5 border-t border-line pt-2.5">
                  {a.live && (
                    <Button size="sm" onClick={() => act(() => call(`/api/v1/articles/${a.id}/unpublish`, { method: "POST" }), t("editor.unpublished"))}>
                      {t("editor.unpublish")}
                    </Button>
                  )}
                  <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setDeleting(true)}>
                    {t("editor.delete")}
                  </Button>
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("editor.deleteTitle", { title: a.title })}
        description={t("editor.deleteDetail")}
        onSubmit={(e) => {
          e.preventDefault();
          void call(`/api/v1/articles/${a.id}`, { method: "DELETE" }).then(
            () => (onChanged(), navigate("/articles")),
            (err: Error) => (setDeleting(false), setError(err.message)),
          );
        }}
        footer={
          <>
            <Button type="button" onClick={() => setDeleting(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="danger">
              {t("editor.delete")}
            </Button>
          </>
        }
      />
    </>
  );
}
