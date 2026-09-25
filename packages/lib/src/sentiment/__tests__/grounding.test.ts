import { describe, expect, it } from "vitest";
import { segmentAnswer } from "../anchors";
import { groundAnchors, isAttributable, namesOnlyOthers } from "../grounding";
import type { SentimentCandidate } from "../types";

/**
 * CP4 — the deterministic entity–anchor grounding guard: explicit mentions,
 * the three inheritance contexts (table header, colon list intro, paragraph
 * continuation), the boundaries that stop inheritance, and generic anchors.
 */
const ARVO: SentimentCandidate = {
	key: "brand",
	entityType: "brand",
	competitorId: null,
	name: "Arvo",
	aliases: ["Arvo Rechtsschutz"],
};
const BELTRA: SentimentCandidate = {
	key: "c-beltra",
	entityType: "competitor",
	competitorId: "c-beltra",
	name: "Beltra",
	aliases: [],
};
const candidates = [ARVO, BELTRA];

const ground = (answer: string) => {
	const anchors = segmentAnswer(answer);
	return { anchors, map: groundAnchors(answer, anchors, candidates) };
};
const keys = (set: ReadonlySet<string>) => [...set].sort();

describe("grounding guard", () => {
	it("explicit mentions are bounded terms of names and aliases, on the natural text only", () => {
		const { map } = ground(
			"Arvo Rechtsschutz ist gut. Beltra auch. Die Arvos GmbH ist etwas anderes. Siehe [Arvo](https://arvo.example/x).",
		);
		expect(keys(map.get("s0001")!.explicit)).toEqual(["brand"]);
		expect(keys(map.get("s0002")!.explicit)).toEqual(["c-beltra"]);
		// "Arvos" is not "Arvo" (bounded), and a link label is natural text only when it is not the citation itself.
		expect(keys(map.get("s0003")!.explicit)).toEqual([]);
		expect(map.get("s0003")!.context).toBe("paragraph");
		expect(keys(map.get("s0003")!.inherited)).toEqual(["c-beltra"]);
	});

	it("a paragraph continuation inherits the nearest preceding mention and stops at a blank line", () => {
		const { map } = ground(
			"Arvo bietet drei Stufen. Die Premium-Stufe ist umfangreich.\n\nDie Wartezeit beträgt drei Monate.",
		);
		expect(map.get("s0002")).toMatchObject({ context: "paragraph" });
		expect(keys(map.get("s0002")!.inherited)).toEqual(["brand"]);
		expect(map.get("s0003")).toMatchObject({ context: "generic" });
		expect(isAttributable(map.get("s0003")!, "brand")).toBe(false);
	});

	it("a later mention of another candidate takes over the continuation", () => {
		const { map } = ground("Arvo ist teuer. Beltra ist günstig. Der Service ist gut.");
		expect(keys(map.get("s0003")!.inherited)).toEqual(["c-beltra"]);
		expect(isAttributable(map.get("s0003")!, "brand")).toBe(false);
		expect(isAttributable(map.get("s0003")!, "c-beltra")).toBe(true);
	});

	it("a table cell inherits the candidate of its own column header only; label cells and the header itself inherit nothing", () => {
		// s0001 Kriterium · s0002 Arvo · s0003 Beltra · s0004 Preis · s0005 teurer · s0006 günstiger · s0007 Service · s0008 gut · s0009 ok · s0010 Fazit
		const { anchors, map } = ground(
			"| Kriterium | Arvo | Beltra |\n|---|---|---|\n| Preis | teurer | günstiger |\n| Service | gut | ok |\n\nFazit folgt.",
		);
		expect(anchors.map((a) => a.text)).toEqual([
			"Kriterium",
			"Arvo",
			"Beltra",
			"Preis",
			"teurer",
			"günstiger",
			"Service",
			"gut",
			"ok",
			"Fazit folgt.",
		]);
		expect(map.get("s0001")).toMatchObject({ context: "generic" });
		expect(keys(map.get("s0002")!.explicit)).toEqual(["brand"]);
		expect(keys(map.get("s0003")!.explicit)).toEqual(["c-beltra"]);
		expect(map.get("s0004")).toMatchObject({ context: "generic" });
		expect(map.get("s0005")).toMatchObject({ context: "table-header" });
		expect(keys(map.get("s0005")!.inherited)).toEqual(["brand"]);
		expect(map.get("s0006")).toMatchObject({ context: "table-header" });
		expect(keys(map.get("s0006")!.inherited)).toEqual(["c-beltra"]);
		expect(keys(map.get("s0008")!.inherited)).toEqual(["brand"]);
		expect(keys(map.get("s0009")!.inherited)).toEqual(["c-beltra"]);
		expect(map.get("s0010")).toMatchObject({ context: "generic" });
	});

	it("list items inherit a colon-terminated intro line that names a candidate, across blank lines, but not a generic intro", () => {
		const named = ground("Wenn du **Arvo** meinst:\n\n- Schutz ohne Wartezeit.\n- Rückwirkend bis 12 Monate.");
		expect(named.map.get("s0002")).toMatchObject({ context: "list-intro" });
		expect(keys(named.map.get("s0002")!.inherited)).toEqual(["brand"]);
		expect(keys(named.map.get("s0003")!.inherited)).toEqual(["brand"]);
		const generic = ground("Achte vor Abschluss auf:\n- Beitragserhöhungen\n- Selbstbeteiligung");
		expect(generic.map.get("s0002")).toMatchObject({ context: "generic" });
		expect(generic.map.get("s0003")).toMatchObject({ context: "generic" });
	});

	it("a list item that names a candidate itself is explicit and does not inherit", () => {
		const { map } = ground("Empfehlung:\n- Beltra ist günstig.\n- Der Beitrag ist niedrig.");
		expect(map.get("s0002")).toMatchObject({ context: "explicit" });
		// A bullet of its own does not continue the previous bullet's sentence.
		expect(map.get("s0003")).toMatchObject({ context: "generic" });
	});

	it("a heading that names a candidate scopes the generic lines below it until another candidate, heading or table", () => {
		const { map } = ground(
			"## Arvo im Vergleich\n\nDer Tarif ist modular.\n\n- Testsieger 2026\n\nBeltra ist günstig. Der Beitrag ist niedrig.\n\n## Fazit\n\nAlles in allem gut.",
		);
		expect(keys(map.get("s0001")!.explicit)).toEqual(["brand"]);
		expect(map.get("s0002")).toMatchObject({ context: "heading" });
		expect(keys(map.get("s0002")!.inherited)).toEqual(["brand"]);
		expect(map.get("s0003")).toMatchObject({ context: "heading" });
		// A later mention of another candidate ends the heading's scope for what follows it …
		expect(map.get("s0005")).toMatchObject({ context: "paragraph" });
		expect(keys(map.get("s0005")!.inherited)).toEqual(["c-beltra"]);
		// … and a heading without a candidate scopes nothing.
		expect(map.get("s0007")).toMatchObject({ context: "generic" });
	});

	it("an indented continuation line belongs to its list item", () => {
		const { map } = ground(
			"Meine Auswahl:\n\n1. **Arvo Komfort**\n   Leistungsstark, aber etwas teurer.\n2. **Beltra Plus**\n   Günstig.",
		);
		expect(map.get("s0003")).toMatchObject({ context: "list-item" });
		expect(keys(map.get("s0003")!.inherited)).toEqual(["brand"]);
		expect(map.get("s0005")).toMatchObject({ context: "list-item" });
		expect(keys(map.get("s0005")!.inherited)).toEqual(["c-beltra"]);
		expect(isAttributable(map.get("s0005")!, "brand")).toBe(false);
	});

	it("a cell that names the other column's candidate is evidence for that candidate alone, never for its column", () => {
		// s0004 Vergleich · s0005 Arvo-column cell naming Beltra · s0006 Beltra-column cell
		const { map } = ground(
			"| Kriterium | Arvo | Beltra |\n|---|---|---|\n| Vergleich | Etwas besser als Beltra bewertet | Leicht dahinter |",
		);
		expect(keys(map.get("s0005")!.explicit)).toEqual(["c-beltra"]);
		expect(keys(map.get("s0005")!.inherited)).toEqual([]);
		expect(namesOnlyOthers(map.get("s0005")!, "brand")).toBe(true);
		expect(isAttributable(map.get("s0005")!, "brand")).toBe(false);
		expect(keys(map.get("s0006")!.inherited)).toEqual(["c-beltra"]);
		expect(isAttributable(map.get("s0006")!, "brand")).toBe(false);
	});

	it("in a row-per-candidate table the cells after the naming cell belong to that row's candidate only", () => {
		// s0001 Tarif · s0002 Preis · s0003 Arvo Komfort · s0004 teurer · s0005 Beltra Plus · s0006 günstig
		const { map } = ground("| Tarif | Preis |\n|---|---|\n| Arvo Komfort | teurer |\n| Beltra Plus | günstig |");
		expect(map.get("s0004")).toMatchObject({ context: "table-row" });
		expect(keys(map.get("s0004")!.inherited)).toEqual(["brand"]);
		expect(isAttributable(map.get("s0004")!, "c-beltra")).toBe(false);
		expect(map.get("s0006")).toMatchObject({ context: "table-row" });
		expect(keys(map.get("s0006")!.inherited)).toEqual(["c-beltra"]);
		expect(isAttributable(map.get("s0006")!, "brand")).toBe(false);
		// The header's own cells and a label cell before any name belong to nobody.
		expect(map.get("s0001")).toMatchObject({ context: "generic" });
	});

	it("namesOnlyOthers is true exactly for an anchor that names candidates other than the claimed one", () => {
		const { map } = ground("Arvo und Beltra sind gut. Beltra ist günstig. Der Service ist schnell.");
		expect(namesOnlyOthers(map.get("s0001")!, "brand")).toBe(false);
		expect(namesOnlyOthers(map.get("s0002")!, "brand")).toBe(true);
		expect(namesOnlyOthers(map.get("s0002")!, "c-beltra")).toBe(false);
		expect(namesOnlyOthers(map.get("s0003")!, "brand")).toBe(false);
	});

	it("is deterministic and independent of candidate order", () => {
		const answer = "Arvo ist gut.\n\n| A | Arvo | Beltra |\n|---|---|---|\n| x | y | z |";
		const anchors = segmentAnswer(answer);
		const a = groundAnchors(answer, anchors, [ARVO, BELTRA]);
		const b = groundAnchors(answer, anchors, [BELTRA, ARVO]);
		for (const [id, g] of a) {
			expect(keys(b.get(id)!.explicit)).toEqual(keys(g.explicit));
			expect(keys(b.get(id)!.inherited)).toEqual(keys(g.inherited));
			expect(b.get(id)!.context).toBe(g.context);
		}
	});
});
