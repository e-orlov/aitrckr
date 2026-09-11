/**
 * Deterministic mock data for the analytics page stories (overview, share of
 * voice, opportunities). Values are fixed (no randomness) so screenshots are
 * stable across runs.
 */

/** Build N consecutive YYYY-MM-DD strings ending at `end` (inclusive). */
function buildDates(n: number, end = "2026-06-04"): string[] {
	const [y, m, d] = end.split("-").map(Number);
	const base = new Date(y, m - 1, d);
	const out: string[] = [];
	for (let i = n - 1; i >= 0; i--) {
		const dt = new Date(base);
		dt.setDate(base.getDate() - i);
		out.push(
			`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`,
		);
	}
	return out;
}

const DATES = buildDates(30);
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

// AI visibility: a mild upward wave settling around 72%.
const visibilityTimeSeries = DATES.map((date, i) => ({
	date,
	overall: clamp(58 + i * 0.5 + 7 * Math.sin(i / 3.5)),
	nonBranded: clamp(40 + i * 0.4 + 6 * Math.sin(i / 4)),
	branded: clamp(90 + 4 * Math.sin(i / 5)),
}));

export const mockDashboardSummary = {
	totalPrompts: 42,
	totalRuns: 3120,
	averageVisibility: 68,
	nonBrandedVisibility: 51,
	brandedVisibility: 92,
	lastUpdatedAt: "2026-06-04T09:12:00.000Z",
	visibilityTimeSeries,
	citationTimeSeries: [],
};

// Share of voice: brand hovering in the low-30s against three competitors.
const shareTimeSeries = DATES.map((date, i) => ({
	date,
	share: clamp(29 + i * 0.18 + 4 * Math.sin(i / 4.5)),
}));

// Headline + entries are kept consistent with the trend's last point (35%), the
// way the server now derives them (LVCF current standings).
const sovLastShare = shareTimeSeries[shareTimeSeries.length - 1].share ?? 0;

// Comparison trend: the competitors split what the brand leaves in a fixed
// 29:22:14 ratio, so the last point reads 35 / 29 / 22 / 14 like the entries.
const threeCompetitors = [
	{ key: "competitor-1", name: "Globex", weight: 29 },
	{ key: "competitor-2", name: "Initech", weight: 22 },
	{ key: "competitor-3", name: "Umbrella", weight: 14 },
];
const comparisonTrend = {
	series: [
		{ key: "brand", name: "Acme", kind: "brand" as const },
		...threeCompetitors.map((c) => ({ key: c.key, name: c.name, kind: "competitor" as const })),
	],
	points: shareTimeSeries.map((p) => {
		const rest = 100 - p.share;
		const values: Record<string, number | null> = { brand: p.share };
		for (const c of threeCompetitors) values[c.key] = (rest * c.weight) / 65;
		return { date: p.date, values };
	}),
};

export const mockShareOfVoice = {
	brandName: "Acme",
	brandShare: sovLastShare / 100,
	totalRuns: 3120,
	model: null,
	shareTimeSeries,
	comparisonTrend,
	entries: [
		{ name: "Acme", mentions: 1050, share: 0.35, isBrand: true, prompts: 31 },
		{ name: "Globex", mentions: 870, share: 0.29, isBrand: false, prompts: 28 },
		{ name: "Initech", mentions: 660, share: 0.22, isBrand: false, prompts: 24 },
		{ name: "Umbrella", mentions: 420, share: 0.14, isBrand: false, prompts: 19 },
	],
};

/**
 * Share of voice with nine competitors: six get their own line, the other
 * three are summed into Others. Everything derives from one integer count table
 * per day, so the chart, tooltip, headline, donut and leaderboard reconcile by
 * construction. Counts are chosen so lines cross, one competitor sits at an
 * actual 0% for a stretch, and Others is 0 on the last days but positive earlier.
 */
const DAYS_TOP6 = buildDates(14);
const TOP6_COMPETITORS = [
	"Globex",
	"Initech",
	"Umbrella Corporation International Holdings GmbH & Co. KGaA",
	"Hooli",
	"Vandelay",
	"Wonka",
];
const TAIL_COMPETITORS = ["Tyrell", "Cyberdyne", "Soylent"];

function top6Counts(i: number): { brand: number; competitors: number[]; tail: number[] } {
	// Globex overtakes the brand around the middle and falls back; Hooli is absent
	// (0) on the first five days; the tail disappears on the last three days.
	const brand = 30 + Math.round(6 * Math.sin(i / 2));
	const competitors = [
		20 + i, // Globex rises past the brand and the others
		28 - i, // Initech falls
		15,
		i < 5 ? 0 : 6 + Math.round(i / 2), // Hooli: an actual 0% early on
		9,
		8,
	];
	const tail = i >= DAYS_TOP6.length - 3 ? [0, 0, 0] : [3, 2, 1];
	return { brand, competitors, tail };
}

const top6Points = DAYS_TOP6.map((date, i) => {
	const { brand, competitors, tail } = top6Counts(i);
	const others = tail.reduce((s, c) => s + c, 0);
	const total = brand + competitors.reduce((s, c) => s + c, 0) + others;
	const values: Record<string, number | null> = { brand: (brand / total) * 100 };
	competitors.forEach((c, k) => {
		values[`competitor-${k + 1}`] = (c / total) * 100;
	});
	values.others = (others / total) * 100;
	return { date, values };
});

// End-of-window standings rank the six shown competitors; the series order
// follows that rank (Globex 33, Initech 15, ... , Wonka 8) like the server does.
const lastCounts = top6Counts(DAYS_TOP6.length - 1);
const rankedTop6 = TOP6_COMPETITORS.map((name, k) => ({ name, mentions: lastCounts.competitors[k], slot: k }))
	.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
	.map((c, rank) => ({ ...c, key: `competitor-${rank + 1}` }));
const top6Total = lastCounts.brand + rankedTop6.reduce((s, c) => s + c.mentions, 0);
// Remap the per-slot values onto rank keys so competitor-1 is the top-ranked line.
const rankedPoints = top6Points.map((p) => {
	const values: Record<string, number | null> = { brand: p.values.brand };
	for (const c of rankedTop6) values[c.key] = p.values[`competitor-${c.slot + 1}`];
	values.others = p.values.others;
	return { date: p.date, values };
});

export const mockShareOfVoiceTop6Others = {
	brandName: "Acme",
	brandShare: lastCounts.brand / top6Total,
	totalRuns: 640,
	model: null,
	shareTimeSeries: rankedPoints.map((p) => ({ date: p.date, share: Math.round(p.values.brand as number) })),
	comparisonTrend: {
		series: [
			{ key: "brand", name: "Acme", kind: "brand" as const },
			...rankedTop6.map((c) => ({ key: c.key, name: c.name, kind: "competitor" as const })),
			{ key: "others", name: "Others", kind: "others" as const },
		],
		points: rankedPoints,
	},
	entries: [
		{ name: "Acme", mentions: lastCounts.brand, share: lastCounts.brand / top6Total, isBrand: true, prompts: 12 },
		...rankedTop6.map((c) => ({
			name: c.name,
			mentions: c.mentions,
			share: c.mentions / top6Total,
			isBrand: false,
			prompts: 5,
		})),
	].sort((a, b) => b.mentions - a.mentions || (a.isBrand ? -1 : 1)),
};

/** Expected once-rounded tooltip rows for the Top-6 fixture on a given day index. */
export function top6ExpectedRows(i: number): Array<[string, string]> {
	const p = rankedPoints[i];
	const rows: Array<[string, string]> = [["Acme", `${Math.round(p.values.brand as number)}%`]];
	for (const c of rankedTop6) rows.push([c.name, `${Math.round(p.values[c.key] as number)}%`]);
	rows.push(["Others", `${Math.round(p.values.others as number)}%`]);
	return rows;
}
export const TOP6_DATES = DAYS_TOP6;
export { TAIL_COMPETITORS as TOP6_TAIL_COMPETITORS };

/** A day on which nobody was mentioned: the denominator is zero and every series is null. */
export const mockShareOfVoiceWithNullDay = {
	...mockShareOfVoice,
	shareTimeSeries: shareTimeSeries.map((p, i) => (i === 10 ? { date: p.date, share: null } : p)),
	comparisonTrend: {
		series: comparisonTrend.series,
		points: comparisonTrend.points.map((p, i) =>
			i === 10 ? { date: p.date, values: Object.fromEntries(Object.keys(p.values).map((k) => [k, null])) } : p,
		),
	},
};

/**
 * Share of voice standings for the donut and its brand list. Counts follow the
 * server's leaderboard order (mentions desc, brand ahead on a tie). The
 * production-like set has a three-competitor tail (Others) and rounds to a
 * displayed total of 99% — the integers must stay as they are.
 */
function sovEntries(brand: [string, number], competitors: Array<[string, number]>) {
	const total = brand[1] + competitors.reduce((s, [, m]) => s + m, 0);
	return [
		{ name: brand[0], mentions: brand[1], share: brand[1] / total, isBrand: true, prompts: 12 },
		...competitors.map(([name, mentions]) => ({ name, mentions, share: mentions / total, isBrand: false, prompts: 5 })),
	];
}
export const mockDonutEntriesWithOthers = sovEntries(
	["Acme", 18],
	[
		["Globex", 7],
		["Initech", 6],
		["Umbrella", 5],
		["Hooli", 3],
		["Vandelay", 3],
		["Wonka", 2],
		["Tyrell", 1],
		["Cyberdyne", 1],
		["Soylent", 1],
	],
);
export const mockDonutEntriesWithoutOthers = sovEntries(
	["Acme", 18],
	[
		["Globex", 7],
		["Initech", 6],
		["Umbrella", 5],
		["Hooli", 3],
		["Vandelay", 3],
		["Wonka", 2],
	],
);
export const mockDonutEntriesFewer = sovEntries(
	["Acme", 18],
	[
		["Globex", 7],
		["Initech", 6],
	],
);
export const mockDonutEntriesLongNames = sovEntries(
	["Acme Corporation Worldwide Insurance Services AG", 18],
	[
		["Umbrella Corporation International Holdings GmbH & Co. KGaA", 7],
		["Globex", 6],
		["Initech Rechtsschutz und Versicherungsvermittlung eG", 5],
		["Hooli", 3],
		["Vandelay", 3],
		["Wonka", 2],
		["Tyrell", 1],
	],
);
export const mockDonutEntriesBrandOnly = sovEntries(["Acme", 18], []);

/** Mock opportunities report (the getOpportunitiesFn response shape). */
export const mockOpportunities = {
	reason: null,
	generatedFor: { brandName: "Acme" },
	lastEvaluatedAt: "2026-06-04T09:12:00.000Z",
	report: {
		summary: [
			"Acme is out-cited by Globex and Initech on nearly every unbranded category question.",
			"Those answers lean on review sites and 'best CRM' roundups (G2, Capterra, PCMag) where competitors show up and Acme rarely does.",
			"Fastest wins are wide-open comparison and community surfaces; the entrenched media roundups are higher-effort, longer plays.",
		],
		opportunities: [
			{
				category: "creation",
				title: "Win the 'Acme vs Globex' and 'CRM alternatives' comparisons",
				why: "Buyers comparing CRMs see Globex named in most AI answers and you almost never — a neutral side-by-side gives assistants a reason to put Acme in the conversation.",
				relatedPrompts: [
					{ text: "acme vs globex pricing", promptId: "p8" },
					{ text: "best alternative to spreadsheets for tracking sales", promptId: "p6" },
				],
				yourCitations: [],
				competitorCitations: [
					{ title: "Globex vs the alternatives", domain: "globex.com", url: "https://globex.com/compare" },
				],
			},
			{
				category: "creation",
				title: "Create a link-worthy 'best CRM for small business' resource",
				why: "Globex wins this high-volume question through roundups you're absent from; a strong, citable resource of your own gives editors and assistants something to point to.",
				relatedPrompts: [{ text: "best crm for small business", promptId: "p1" }],
				yourCitations: [],
				competitorCitations: [
					{ title: "Globex for Small Business", domain: "globex.com", url: "https://globex.com/smb" },
				],
			},
			{
				category: "creation",
				title: "Publish a definitive 'CRM for startups' guide",
				why: "No source owns the startup-CRM explainer answers and the citations there keep changing, so a clear guide can claim them before a competitor does.",
				relatedPrompts: [
					{ text: "affordable accounting software for startups", promptId: "p3" },
					{ text: "what is customer relationship management", promptId: "p9" },
				],
				yourCitations: [],
				competitorCitations: [],
			},
			{
				category: "existing-content",
				title: "Shore up your Help Desk guide before it slips",
				why: "You already get cited for this answer, but a Globex page is gaining ground — reinforcing the page you have protects citations you're about to lose.",
				relatedPrompts: [{ text: "what is the best help desk software", promptId: "p4" }],
				yourCitations: [{ title: "Acme Help Desk Guide", domain: "acme.com", url: "https://acme.com/help-desk-guide" }],
				competitorCitations: [{ title: "Globex Help Desk", domain: "globex.com", url: "https://globex.com/help-desk" }],
			},
			{
				category: "outreach",
				title: "Run a verified-review drive on G2 and Capterra",
				why: "Review sites are the pages AI cites most for CRM picks, and competitors out-review you there — more recent reviews are the cheapest way to start getting named.",
				relatedPrompts: [
					{ text: "best crm for small business", promptId: "p1" },
					{ text: "tools for remote team collaboration", promptId: "p5" },
				],
				yourCitations: [{ title: "Acme CRM", domain: "acme.com", url: "https://acme.com" }],
				competitorCitations: [{ title: "Globex CRM", domain: "globex.com", url: "https://globex.com/crm" }],
			},
			{
				category: "outreach",
				title: "Earn inclusion in the major 'best CRM' roundups",
				why: "PCMag, Forbes Advisor and TechRadar are cited again and again for your biggest gaps but list competitors, not you — one inclusion can surface Acme across many related questions.",
				relatedPrompts: [
					{ text: "best crm for small business", promptId: "p1" },
					{ text: "top project management tools", promptId: "p2" },
				],
				yourCitations: [],
				competitorCitations: [
					{ title: "Globex for Small Business", domain: "globex.com", url: "https://globex.com/smb" },
				],
			},
			{
				category: "social",
				title: "Answer recurring 'which CRM' threads on r/CRM",
				why: "These Reddit threads feed a lot of AI answers and rotate often, so genuine, disclosed answers can get Acme surfaced quickly — competitors are already named there.",
				relatedPrompts: [
					{ text: "how do saas companies handle billing", promptId: "p10" },
					{ text: "what is customer relationship management", promptId: "p9" },
				],
				yourCitations: [],
				competitorCitations: [{ title: "Globex CRM overview", domain: "globex.com", url: "https://globex.com/crm" }],
			},
			{
				category: "social",
				title: "Seed honest comparison demos on YouTube",
				why: "Video walkthroughs get pulled into AI answers for evaluation questions, where competitor demos currently dominate and you're not represented.",
				relatedPrompts: [{ text: "best alternative to spreadsheets for tracking sales", promptId: "p6" }],
				yourCitations: [],
				competitorCitations: [],
			},
		],
		risks: [
			"The big media roundups are locked-in and slow to crack — treat them as longer plays, not quick wins.",
			"Several 'vs' queries are answered from competitor-owned domains you can't get listed on; focus on independent comparisons instead.",
			"Skip incentivized or fake reviews — assistants increasingly discount coordinated, inauthentic activity.",
		],
	},
};
