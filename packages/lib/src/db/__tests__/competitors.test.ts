import { describe, expect, it } from "vitest";
import { planCompetitorRoster, type StoredCompetitor } from "../competitors";

const alpha: StoredCompetitor = {
	id: "a0000000-0000-4000-8000-000000000001",
	name: "Alpha",
	domains: ["alpha.example"],
	aliases: ["Alpha Insurance"],
	active: true,
};
const beta: StoredCompetitor = {
	id: "b0000000-0000-4000-8000-000000000002",
	name: "Beta",
	domains: ["beta.example", "beta.de"],
	aliases: [],
	active: true,
};
const gone: StoredCompetitor = {
	id: "c0000000-0000-4000-8000-000000000003",
	name: "Gone",
	domains: ["gone.example"],
	aliases: [],
	active: false,
};

const entry = (row: StoredCompetitor) => ({ id: row.id, name: row.name, domains: row.domains, aliases: row.aliases });

describe("planCompetitorRoster (UT-ID-001)", () => {
	it("reports an unchanged roster as unchanged and touches nothing", () => {
		const plan = planCompetitorRoster([alpha, beta, gone], [entry(alpha), entry(beta)]);
		expect(plan).toEqual({ inserts: [], updates: [], deactivate: [], unchanged: [alpha.id, beta.id] });
	});

	it("updates a row in place when name, domains or aliases change, remembering the old name", () => {
		const plan = planCompetitorRoster(
			[alpha, beta],
			[{ ...entry(alpha), name: "Alpha AG", domains: ["alpha.example", "alpha.at"] }, entry(beta)],
		);
		expect(plan.updates).toEqual([
			{
				id: alpha.id,
				name: "Alpha AG",
				domains: ["alpha.example", "alpha.at"],
				aliases: alpha.aliases,
				previousName: "Alpha",
				reactivate: false,
			},
		]);
		expect(plan.inserts).toEqual([]);
		expect(plan.deactivate).toEqual([]);
	});

	it("does not record a previous name when only domains or aliases change", () => {
		const plan = planCompetitorRoster([alpha], [{ ...entry(alpha), aliases: [] }]);
		expect(plan.updates[0]).toMatchObject({ id: alpha.id, previousName: null });
	});

	it("inserts entries without an id that match no stored row", () => {
		const plan = planCompetitorRoster([alpha], [entry(alpha), { name: "New", domains: ["new.example"], aliases: [] }]);
		expect(plan.inserts).toEqual([{ name: "New", domains: ["new.example"], aliases: [] }]);
		expect(plan.unchanged).toEqual([alpha.id]);
	});

	it("deactivates active rows omitted from the submission and leaves inactive rows alone", () => {
		const plan = planCompetitorRoster([alpha, beta, gone], [entry(alpha)]);
		expect(plan.deactivate).toEqual([beta.id]);
		expect(plan.updates).toEqual([]);
		expect(plan.inserts).toEqual([]);
	});

	it("reactivates an inactive row re-added by id", () => {
		const plan = planCompetitorRoster([alpha, gone], [entry(alpha), entry(gone)]);
		expect(plan.updates).toEqual([{ ...entry(gone), previousName: null, reactivate: true }]);
	});

	it("reuses the single stored row that shares a domain when an entry has no id", () => {
		const plan = planCompetitorRoster(
			[alpha, gone],
			[entry(alpha), { name: "Gone Again", domains: ["gone.example", "gone.de"], aliases: ["GA"] }],
		);
		expect(plan.inserts).toEqual([]);
		expect(plan.updates).toEqual([
			{
				id: gone.id,
				name: "Gone Again",
				domains: ["gone.example", "gone.de"],
				aliases: ["GA"],
				previousName: "Gone",
				reactivate: true,
			},
		]);
	});

	it("treats a remove-and-re-add of the same domain in one save as the same competitor", () => {
		const plan = planCompetitorRoster(
			[alpha, beta],
			[entry(alpha), { name: "Beta", domains: ["beta.de"], aliases: [] }],
		);
		expect(plan.deactivate).toEqual([]);
		expect(plan.updates).toEqual([
			{ id: beta.id, name: "Beta", domains: ["beta.de"], aliases: [], previousName: null, reactivate: false },
		]);
	});

	it("never merges by name alone", () => {
		const plan = planCompetitorRoster([gone], [{ name: "Gone", domains: ["other.example"], aliases: [] }]);
		expect(plan.inserts).toHaveLength(1);
		expect(plan.updates).toEqual([]);
	});
});

describe("planCompetitorRoster rejections (UT-ID-002)", () => {
	it("rejects an id the brand does not own", () => {
		expect(() =>
			planCompetitorRoster([alpha], [{ id: gone.id, name: "Smuggled", domains: ["x.example"], aliases: [] }]),
		).toThrow(expect.objectContaining({ code: "competitor-unknown" }));
	});

	it("rejects the same id submitted twice", () => {
		expect(() => planCompetitorRoster([alpha], [entry(alpha), entry(alpha)])).toThrow(
			expect.objectContaining({ code: "competitor-duplicate-id" }),
		);
	});

	it("rejects one domain listed on two submitted competitors", () => {
		expect(() =>
			planCompetitorRoster(
				[],
				[
					{ name: "X", domains: ["shared.example"], aliases: [] },
					{ name: "Y", domains: ["shared.example"], aliases: [] },
				],
			),
		).toThrow(expect.objectContaining({ code: "competitor-domains-duplicate" }));
	});

	it("allows the same domain repeated inside one entry", () => {
		expect(() =>
			planCompetitorRoster([], [{ name: "X", domains: ["x.example", "x.example"], aliases: [] }]),
		).not.toThrow();
	});

	it("rejects an id-less entry whose domain matches two stored rows", () => {
		const twin: StoredCompetitor = { ...gone, id: "d0000000-0000-4000-8000-000000000004", name: "Twin" };
		expect(() =>
			planCompetitorRoster([gone, twin], [{ name: "Gone", domains: ["gone.example"], aliases: [] }]),
		).toThrow(expect.objectContaining({ code: "competitor-reactivation-ambiguous" }));
	});

	it("rejects two id-less entries that both match the same stored row", () => {
		expect(() =>
			planCompetitorRoster(
				[beta],
				[
					{ name: "B1", domains: ["beta.example"], aliases: [] },
					{ name: "B2", domains: ["beta.de"], aliases: [] },
				],
			),
		).toThrow(expect.objectContaining({ code: "competitor-reactivation-ambiguous" }));
	});

	it("rejects an id-less entry that repeats a domain of a row claimed by id", () => {
		expect(() =>
			planCompetitorRoster([beta], [entry(beta), { name: "Copy", domains: ["beta.de"], aliases: [] }]),
		).toThrow(expect.objectContaining({ code: "competitor-domains-duplicate" }));
	});
});
