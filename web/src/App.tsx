import {
  AppShell,
  Badge,
  BarList,
  BrandProvider,
  Button,
  Callout,
  CHART_COLORS,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  TimeSeriesChart,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  ExternalLink,
  FileText,
  KeyRound,
  LayoutDashboard,
  Library,
  Lightbulb,
  LogIn,
  LogOut,
  PenLine,
  Plug,
  SearchX,
  Settings as SettingsIcon,
  ThumbsDown,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Article, Member, ProductLink, Report, Settings, Summary } from "./api.ts";
import { ArticlesPage, EditorPage } from "./articles.tsx";
import { date, fmt, host, languageIn, languageName, placeName, topicName, useApi, useLoad, type Call } from "./common.tsx";
import { useT, viewerLocale, setViewerLocale } from "./i18n.ts";
import { GapsPage, IntegrationsPage, ReviewPage, SettingsFilePage, SuggestionsPage } from "./pages.tsx";

const PAGES = ["articles", "review", "gaps", "suggestions", "integrations", "settings", "account", "members", "signin", "tokens", "about"] as const;
type Route = { page: "overview" | (typeof PAGES)[number] } | { page: "article"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "articles" && id) return { page: "article", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ call, settings }: { call: Call; settings: Settings }) {
  const t = useT();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  const [r] = useLoad<Report>(call, "/api/v1/report?days=30");
  const config = settings.config!;
  const change = r && r.totals.viewsBefore ? Math.round(((r.totals.views - r.totals.viewsBefore) / r.totals.viewsBefore) * 100) : null;
  return (
    <>
      <PageHeader
        title={t("overview.title")}
        description={t("overview.description", {
          address: host(settings.helpUrl),
          languages: config.site.languages.map((l) => languageIn(l, locale)).join(", "),
        })}
        actions={
          <Button icon={<ExternalLink />} onClick={() => window.open(`${settings.helpUrl}/`, "_blank", "noopener")}>
            {t("overview.open")}
          </Button>
        }
      />
      {r === null && <EmptyState title={t("overview.failed")} />}
      {r && (
        <>
          <KpiGrid minWidth={170} className="mb-2.5">
            <KpiCard
              label={t("overview.views")}
              value={fmt(r.totals.views)}
              trend={r.series.map((d) => Object.values(d.views).reduce((a, b) => a + b, 0))}
              delta={
                change === null
                  ? undefined
                  : {
                      label: t("overview.viewsChange", { change: (change > 0 ? "+" : "") + change }),
                      direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
                      intent: change >= 0 ? "good" : "bad",
                    }
              }
            />
            <KpiCard
              label={t("overview.searches")}
              value={fmt(r.totals.searches)}
              delta={{
                label: t("overview.foundNothing", { share: r.totals.searches ? Math.round((r.totals.noResult / r.totals.searches) * 1000) / 10 : 0 }),
                intent: "neutral",
              }}
            />
            <KpiCard label={t("overview.answered")} value={fmt(r.totals.answered)} delta={{ label: t("overview.answeredDetail"), intent: "good" }} />
            <KpiCard
              label={t("overview.helpful")}
              value={r.totals.helpful === null ? "–" : `${r.totals.helpful}%`}
              delta={{ label: t("overview.ofAnswers", { count: r.totals.votes }), intent: "neutral" }}
            />
            <KpiCard
              label={t("overview.published")}
              value={fmt(r.totals.live)}
              unit={t("overview.ofArticles", { count: r.totals.articles })}
              delta={{ label: t("overview.waiting", { count: r.totals.review }), intent: "neutral" }}
            />
          </KpiGrid>
          <div className="kb-split-side mb-2.5 grid gap-2.5">
            <Panel title={t("overview.viewsChart")} description={t("overview.viewsChartDetail")}>
              <TimeSeriesChart
                label={t("overview.viewsChartLabel")}
                labels={r.series.map((d) =>
                  new Date(`${d.day}T00:00:00Z`).toLocaleDateString(viewerLocale(), { day: "numeric", month: "short", timeZone: "UTC" }),
                )}
                height={200}
                xTicks={7}
                format={(v) => fmt(Math.round(v))}
                series={r.languages.map((l, i) => ({
                  id: l,
                  name: languageName(l),
                  data: r.series.map((d) => d.views[l] ?? 0),
                  color: CHART_COLORS[i % CHART_COLORS.length]!,
                }))}
              />
            </Panel>
            <Panel title={t("overview.sources")}>
              {r.sources.length ? (
                <BarList label={t("overview.sourcesLabel")} items={r.sources.map((s) => ({ id: s.source, label: placeName(s.source, t), value: s.views }))} />
              ) : (
                <EmptyState title={t("overview.noViews")} />
              )}
            </Panel>
          </div>
          <div className="kb-split-halves grid gap-2.5">
            <Panel title={t("overview.mostRead")} flush>
              {r.mostRead.length ? (
                <ol aria-label={t("overview.mostRead")} className="kb-list flex flex-col">
                  {r.mostRead.map((a, i) => (
                    <li key={a.id} className="flex items-center gap-2 border-b border-line px-3 py-2">
                      <span className="w-4 text-xs text-fg-muted tabular-nums">{i + 1}</span>
                      <a href={`/articles/${a.id}`} className="flex min-w-0 grow flex-col text-fg no-underline">
                        <span className="truncate text-sm text-fg">{a.title}</span>
                        <span className="text-2xs text-fg-muted">{topicName(config, a.topic, t)}</span>
                      </a>
                      <span className="shrink-0 text-end font-mono text-xs tabular-nums">
                        {fmt(a.views)}
                        <span className="block text-2xs text-fg-muted">{t("overview.answeredCount", { count: a.answered })}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState title={t("overview.noViews")} />
              )}
            </Panel>
            <Panel title={t("overview.lowHelpful")} description={t("overview.lowHelpfulDetail", { share: config.helpful.listBelow })} flush>
              {r.lowHelpful.length ? (
                <ul aria-label={t("overview.lowHelpful")} className="kb-list flex flex-col">
                  {r.lowHelpful.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 border-b border-line px-3 py-2">
                      <ThumbsDown aria-hidden className="size-3.5 shrink-0 text-danger-text" />
                      <a href={`/articles/${a.id}`} className="flex min-w-0 grow flex-col no-underline">
                        <span className="truncate text-sm text-fg">{a.title}</span>
                        <span className="text-2xs text-fg-muted">{t("overview.ownerUpdated", { owner: a.owner.name, updated: date(a.updatedAt) })}</span>
                      </a>
                      <Badge tone="danger">{t("overview.helpfulShare", { share: a.helpful })}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 text-sm text-fg-muted">{t("overview.noneLow")}</p>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [settings, setSettings] = useState<Settings>();
  const [members, setMembers] = useState<Member[]>([]);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(
          r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "knowledge-base" && (PRODUCT_IDS as readonly string[]).includes(p.id)),
        ),
      () => {},
    );
    void call<{ members: Member[] }>("/api/v1/team").then(
      (r) => setMembers(r.members),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds articles by title in any language.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<{ articles: Article[] }>("/api/v1/articles", { signal });
      const words = q.toLocaleLowerCase();
      return r.articles
        .filter((a) => Object.values(a.titles).some((x) => x.toLocaleLowerCase().includes(words)))
        .slice(0, 10)
        .map((a) => ({
          id: `article:${a.id}`,
          label: a.title,
          detail: msg(`state.${a.state}`),
          kind: msg("search.article"),
          icon: FileText,
          href: `/articles/${a.id}`,
        }));
    },
    [call, msg],
  );

  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "articles", label: msg("nav.articles"), icon: Library },
    { id: "review", label: msg("nav.review"), icon: PenLine, count: summary?.articles.review || undefined },
    { id: "gaps", label: msg("nav.gaps"), icon: SearchX, count: summary?.gaps || undefined },
    { id: "suggestions", label: msg("nav.suggestions"), icon: Lightbulb },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "article" ? "articles" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const ready = settings?.config ? settings : undefined;
  const onChanged = reload;

  return (
    <AppShell
      product="knowledge-base"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {summary?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {summary.file.error}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : !ready ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "articles" ? (
        <ArticlesPage call={call} settings={ready} members={members} onChanged={onChanged} />
      ) : route.page === "article" ? (
        <EditorPage key={route.id} call={call} id={route.id} settings={ready} members={members} onChanged={onChanged} />
      ) : route.page === "review" ? (
        <ReviewPage call={call} settings={ready} onChanged={onChanged} />
      ) : route.page === "gaps" ? (
        <GapsPage call={call} settings={ready} members={members} onChanged={onChanged} />
      ) : route.page === "suggestions" ? (
        <SuggestionsPage call={call} settings={ready} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage settings={ready} />
      ) : route.page === "settings" ? (
        <SettingsFilePage settings={ready} />
      ) : (
        <OverviewPage call={call} settings={ready} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Knowledge Base">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
