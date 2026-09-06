import { describe, expect, it } from "vitest";
import { availableTagsFor, parseTagFilter, promptIdsMatchingTags } from "@/server/citation-filters";

const prompts = [
	{ id: "b1", tags: ["Monitoring"], systemTags: ["branded"] },
	{ id: "b2", tags: ["comparison"], systemTags: ["branded"] },
	{ id: "u1", tags: ["optimization"], systemTags: ["unbranded"] },
	{ id: "u2", tags: null, systemTags: null },
	{ id: "u3", tags: ["monitoring", "branded"], systemTags: ["unbranded"] },
];

describe("promptIdsMatchingTags", () => {
	it("matches user tags case-insensitively against own and system tags", () => {
		expect(promptIdsMatchingTags(prompts, ["monitoring"])).toEqual(["b1", "u3"]);
		expect(promptIdsMatchingTags(prompts, ["MONITORING"])).toEqual([]);
		expect(promptIdsMatchingTags(prompts, ["optimization", "comparison"])).toEqual(["b2", "u1"]);
	});

	it("resolves the branded/unbranded system tags through the effective status", () => {
		// u3 carries a user "branded" tag, which overrides its unbranded system tag.
		expect(promptIdsMatchingTags(prompts, ["branded"])).toEqual(["b1", "b2", "u3"]);
		expect(promptIdsMatchingTags(prompts, ["unbranded"])).toEqual(["u1", "u2"]);
	});

	it("unions system-tag and user-tag matches", () => {
		expect(promptIdsMatchingTags(prompts, ["unbranded", "comparison"])).toEqual(["b2", "u1", "u2"]);
	});

	it("matches nothing for an unknown tag", () => {
		expect(promptIdsMatchingTags(prompts, ["nope"])).toEqual([]);
	});
});

describe("availableTagsFor", () => {
	it("lists the system tags first and the brand's own tags sorted, without duplicating system tags", () => {
		expect(availableTagsFor(prompts)).toEqual([
			"branded",
			"unbranded",
			"Monitoring",
			"comparison",
			"monitoring",
			"optimization",
		]);
		expect(availableTagsFor([])).toEqual(["branded", "unbranded"]);
	});
});

describe("parseTagFilter", () => {
	it("splits the comma-joined URL value and drops empties", () => {
		expect(parseTagFilter("a,b,,c")).toEqual(["a", "b", "c"]);
		expect(parseTagFilter("")).toEqual([]);
		expect(parseTagFilter(undefined)).toEqual([]);
	});
});
