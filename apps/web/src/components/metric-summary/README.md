# Metric summary pattern

The top card of a metric page (Share of Voice, AI Visibility, and any future metric such as Sentiment) is composed from two presentation-only components in this folder. Neither fetches, reads URL state, calculates a metric, or knows what a brand is.

## Components

| Export | File | Responsibility |
|---|---|---|
| `MetricSummaryCard` | `metric-summary-card.tsx` | Card shell: `h2` title with an "About {title}" info tip, headline `value`, full-width `description`, optional `meta` line (omitted when absent), then one visual group holding the `visual` and `legend` slots. |
| `MetricCardTitle` | `metric-summary-card.tsx` | The same title + tip for sibling cards of a metric page (trends, leaderboard). |
| `MetricVisualGroup` | `metric-summary-card.tsx` | Chart left / legend right when the card is at least 24 rem wide, chart centred with the legend below otherwise. Driven by a container query on the card content, never by the viewport. |
| `MetricLegend` | `metric-legend.tsx` | Semantic `ul`/`li` list of display-ready rows: colour dot (decorative), label, optional badge, right-aligned value. Renders the items exactly as given. |

```ts
interface MetricSummaryCardProps {
  title: string;              // plain text → accessible "About {title}" button
  infoContent: ReactNode;     // tooltip body
  value: ReactNode;           // preformatted headline
  description: ReactNode;     // primary explanation
  meta?: ReactNode;           // secondary line; omit rather than pass empty text
  visual: ReactNode;          // the metric's chart; pass null when there is nothing to draw
  legend: ReactNode;          // normally <MetricLegend …/>; pass null together with visual
  testId?: string; className?: string;
}

interface MetricLegendItem {
  id: string;                 // stable key, independent of the label (duplicate labels are fine)
  label: string;
  color: string;              // any CSS colour
  valueLabel: string;         // fully formatted: "44%", "3 of 7", "—" … rendered verbatim
  emphasis?: "primary" | "default" | "muted";   // primary = larger dot + medium weight; muted = muted text
  badgeLabel?: string;        // e.g. "You"
  title?: string;             // hover/accessible title when the label may truncate (defaults to label)
}
interface MetricLegendProps { items: readonly MetricLegendItem[]; ariaLabel: string; className?; testId? }
```

## What the caller owns

The caller calculates everything before rendering and hands over display-ready data:

- **order** — the legend keeps the array order; it never sorts, groups, deduplicates or drops rows (including `0%` rows);
- **labels, colours** — taken from the metric's canonical dataset (the same array that feeds the chart, so chart and list always agree);
- **value labels** — formatted once by the caller (`formatPct`, `${percent}%`, `"12 of 20"` …); the legend never appends `%` or rounds;
- **badge and emphasis** — the caller decides which row is `primary` and carries a badge (today: the own brand with `"You"`); nothing is inferred from a label such as "Others";
- **the chart** — a metric-specific component sized by the caller (both current charts use a 220 px stage) and passed through the `visual` slot; the shell never imports Recharts or branches on the metric.

Adapters live beside their metric: `shareOfVoiceLegendItems(slices)` in `../share-of-voice-donut.tsx`, `competitiveVisibilityLegendItems(rings)` in `../competitive-visibility/radial.tsx`.

## Accessibility split

Shell: one `h2` per card, info button with an accessible name and the shared tooltip primitive, value/description/meta in reading order, no fixed heights. Legend: named list, one item per entity, text carries identity (colour is decorative and `aria-hidden`), truncated labels keep their full text and `title`, no tab stops. Chart: its own accessible name/role (`role="img"` with a textual summary) and its own tooltip.

## Future consumer example (display data only)

```tsx
const items: MetricLegendItem[] = categories.map((c) => ({
  id: c.key,
  label: c.label,
  color: c.color,
  valueLabel: `${c.count} of ${total}`,
  emphasis: c.key === "positive" ? "primary" : "default",
}));

<MetricSummaryCard
  title="Sentiment"
  infoContent={SENTIMENT_TIP}
  value={formatPct(positiveShare)}
  description={`${brandName} was described positively in ${positive} of ${total} answers.`}
  meta={`${total} answers in this period`}
  visual={<SentimentChart categories={categories} size={220} />}
  legend={<MetricLegend items={items} ariaLabel="Categories" testId="sentiment-legend" />}
/>
```

`stories/metric-summary.stories.tsx` → "Synthetic category metric" is the layout contract for this case; it is not a product decision or a sentiment formula.
