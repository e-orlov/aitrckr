import { describe, expect, it } from "vitest";
import { brandEntity, competitorEntity, containsBoundedTerm, detectEntityMentions, entityTerms } from "../detector";
import { extractAnswerBody, normalizeText } from "../text";

const brand = brandEntity({
	name: "ARAG",
	aliases: [],
	website: "https://arag.de/",
	additionalDomains: ["arag.com"],
});
const huk = competitorEntity({ id: "c-huk", name: "HUK-COBURG", aliases: ["HUK"], domains: ["huk.de"] });
const das = competitorEntity({ id: "c-das", name: "D.A.S.", aliases: [], domains: ["das.de"] });
const wgv = competitorEntity({
	id: "c-wgv",
	name: "WGV",
	aliases: ["Württembergische Gemeinde-Versicherung"],
	domains: ["wgv.de"],
});
const ruv = competitorEntity({ id: "c-ruv", name: "R+V", aliases: [], domains: ["ruv.de"] });
const renamed = competitorEntity({
	id: "c-old",
	name: "Neuer Name",
	aliases: [],
	domains: ["neu.example"],
	previousNames: ["Alter Name"],
});
const all = [brand, huk, das, wgv, ruv, renamed];

describe("UT-SNT-003 deterministic mention detection", () => {
	it("finds names, aliases and domains case-insensitively with one row per entity", () => {
		const text =
			"Die HUK bietet günstigen Schutz; auch huk.de listet Tarife. ARAG und arag.de ebenso. HUK-COBURG erneut.";
		const found = detectEntityMentions(text, all);
		expect(found.map((m) => m.key)).toEqual(["brand", "c-huk"]);
		expect(found[1].matchedTerms).toEqual(["huk-coburg", "huk", "huk.de"]);
	});

	it("respects Unicode token boundaries", () => {
		expect(detectEntityMentions("Schadenfreiheitsrabatt bei hukum", [huk])).toEqual([]);
		expect(detectEntityMentions("adas.de ist keine Versicherung", [das])).toEqual([]);
		expect(detectEntityMentions("Vergleich: D.A.S. gegen ARAG", [das, brand]).map((m) => m.key)).toEqual([
			"c-das",
			"brand",
		]);
		expect(detectEntityMentions("die R+V-Gruppe", [ruv]).map((m) => m.key)).toEqual(["c-ruv"]);
		expect(detectEntityMentions("Württembergische Gemeinde-Versicherung empfohlen", [wgv]).map((m) => m.key)).toEqual([
			"c-wgv",
		]);
		expect(detectEntityMentions("ÄRAG", [brand])).toEqual([]);
	});

	it("normalizes NFKC, case and whitespace identically in text and terms", () => {
		expect(normalizeText("Ｈuk   Coburg")).toBe("huk coburg");
		expect(containsBoundedTerm(normalizeText("Die  HUK–COBURG"), "huk")).toBe(true);
	});

	it("uses previous names for renamed competitors and never merges other entities", () => {
		expect(detectEntityMentions("Der Alter Name war bekannt.", all).map((m) => m.key)).toEqual(["c-old"]);
		expect(entityTerms(renamed)).toContain("alter name");
	});

	it("ignores tiny terms and empty answers", () => {
		const tiny = competitorEntity({ id: "t", name: "X", aliases: [], domains: [] });
		expect(entityTerms(tiny)).toEqual([]);
		expect(detectEntityMentions("", all)).toEqual([]);
	});

	it("preserves the order of the supplied entities (brand first)", () => {
		const found = detectEntityMentions("WGV, dann R+V, dann ARAG", all);
		expect(found.map((m) => m.key)).toEqual(["brand", "c-wgv", "c-ruv"]);
	});
});

describe("answer body extraction guards", () => {
	it("returns the OpenAI-style body and null for sentinels/empty", () => {
		const raw = { choices: [{ message: { content: "ARAG ist gut." } }] };
		expect(extractAnswerBody(raw, "openrouter", "chatgpt")).toBe("ARAG ist gut.");
		expect(extractAnswerBody({}, "stub", "stub")).toBeNull();
		expect(extractAnswerBody({ choices: [{ message: { content: "   " } }] }, "openrouter", "chatgpt")).toBeNull();
	});

	it("does not treat citation metadata as answer text", () => {
		const raw = {
			choices: [
				{
					message: {
						content: "Nur ein Satz.",
						annotations: [
							{ type: "url_citation", url_citation: { url: "https://huk.de/x", title: "HUK-COBURG Tarife" } },
						],
					},
				},
			],
		};
		const body = extractAnswerBody(raw, "openrouter", "chatgpt");
		expect(body).toBe("Nur ein Satz.");
		expect(detectEntityMentions(body ?? "", [huk])).toEqual([]);
	});
});
