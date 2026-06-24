import "../index.css"
import { Link, Meta, Title } from "@solidjs/meta"
import { createAsync } from "@solidjs/router"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { getRequestEvent } from "solid-js/web"
import { ComparisonCardsSection, modelRefFromCatalog, uniqueComparisonPairs } from "../compare-cards"
import { ComparisonSelector } from "../compare-selector"
import { getModelCatalog, type ModelCatalogEntry } from "../model-catalog"
import {
  applyThemePreference,
  Footer,
  getGitHubStars,
  Header,
  isThemePreference,
  themeStorageKey,
  type HeaderLink,
  type ThemePreference,
} from "../stats-shell"

const compareFallbackUrl = "https://stats.opencode.ai"
const compareTitle = "AI Model Comparison"
const compareDescription =
  "Compare AI models used in OpenCode by context, output, release date, usage, rank, token share, and cost."
const compareHeaderLinks: readonly HeaderLink[] = [
  { href: "#compare-tool", label: "Compare" },
  { href: "#model-comparison", label: "Popular" },
]
const compareFooterLinks: readonly HeaderLink[] = [
  { href: import.meta.env.BASE_URL, label: "Data Home" },
  { href: `${import.meta.env.BASE_URL}#top-models`, label: "Top Models" },
  { href: `${import.meta.env.BASE_URL}#token-cost`, label: "Token Cost" },
  { href: `${import.meta.env.BASE_URL}compare`, label: "Model Compare" },
]

export default function ModelCompareIndex() {
  const event = getRequestEvent()
  event?.response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=86400")
  const catalog = createAsync(() => getModelCatalog())
  const githubStars = createAsync(() => getGitHubStars())
  const [themePreference, setThemePreference] = createSignal<ThemePreference>("system")
  const compareUrl = createMemo(() =>
    new URL(
      `${import.meta.env.BASE_URL}compare`,
      event?.request.url ?? (typeof window === "undefined" ? compareFallbackUrl : window.location.href),
    ).toString(),
  )
  const featuredModels = createMemo(() => (catalog()?.models ?? []).slice(0, 120))
  const pairs = createMemo(() => buildPopularPairs(featuredModels()))
  const updateThemePreference = (preference: ThemePreference) => {
    applyThemePreference(preference)
    setThemePreference(preference)
    if (typeof window === "undefined") return
    window.localStorage.setItem(themeStorageKey, preference)
  }

  onMount(() => {
    if (typeof window === "undefined") return
    const preference = window.localStorage.getItem(themeStorageKey)
    const nextPreference = isThemePreference(preference) ? preference : "system"
    applyThemePreference(nextPreference)
    setThemePreference(nextPreference)
  })

  return (
    <main data-page="stats" data-theme={themePreference()}>
      <Title>{compareTitle}</Title>
      <Meta name="description" content={compareDescription} />
      <Link rel="canonical" href={compareUrl()} />
      <Meta property="og:type" content="website" />
      <Meta property="og:site_name" content="OpenCode" />
      <Meta property="og:title" content={compareTitle} />
      <Meta property="og:description" content={compareDescription} />
      <Meta property="og:url" content={compareUrl()} />
      <Meta name="twitter:card" content="summary" />
      <Meta name="twitter:title" content={compareTitle} />
      <Meta name="twitter:description" content={compareDescription} />
      <Header githubStars={githubStars() ?? "150K"} links={compareHeaderLinks} brandHref={import.meta.env.BASE_URL} />
      <div data-component="container">
        <div data-component="content">
          <section id="compare-tool" data-section="model-hero">
            <a data-slot="model-back-link" href={import.meta.env.BASE_URL}>
              Data
            </a>
            <div data-slot="model-hero-grid">
              <div data-slot="model-hero-copy">
                <span data-slot="model-id-tag">/compare</span>
                <h1>Model Comparison</h1>
                <p>Choose two models and compare usage, cost, limits, and features.</p>
              </div>
              <div data-component="model-rank-panel">
                <span>Model Pairs</span>
                <strong>{formatPairCount(featuredModels().length)}</strong>
                <p>Available pairings from the model list.</p>
              </div>
            </div>
            <div data-slot="model-hero-pattern" aria-hidden="true" />
            <Show
              when={featuredModels().length > 1}
	              fallback={
	                <div data-component="empty-state" data-compact="true">
	                  <strong>No models found</strong>
	                  <p>The model list could not be loaded.</p>
	                </div>
	              }
            >
              <ComparisonSelector models={featuredModels()} />
            </Show>
          </section>
          <ComparisonCardsSection
            pairs={pairs()}
            title="Popular Model Comparisons"
            description="Common model pairs to start with."
          />
        </div>
        <Footer
          themePreference={themePreference()}
          onThemePreferenceChange={updateThemePreference}
          links={compareFooterLinks}
          bridge={{ href: "#compare-tool", label: "MODEL COMPARE" }}
        />
      </div>
    </main>
  )
}

function buildPopularPairs(models: ModelCatalogEntry[]) {
  return uniqueComparisonPairs(
    (
      [
        [0, 1, "Popular pair"],
        [0, 2, "Top alternative"],
        [1, 2, "Nearby pair"],
        [2, 3, "Recent model pair"],
        [3, 4, "Model pair"],
        [4, 5, "Model pair"],
      ] as const
    ).flatMap(([firstIndex, secondIndex, detail]) => {
      const first = models[firstIndex]
      const second = models[secondIndex]
      return first && second ? [{ first: modelRefFromCatalog(first), second: modelRefFromCatalog(second), detail }] : []
    }),
  )
}

function formatPairCount(count: number) {
  if (count < 2) return "0"
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format((count * (count - 1)) / 2)
}
