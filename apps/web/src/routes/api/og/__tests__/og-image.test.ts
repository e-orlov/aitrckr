import { DEFAULT_APP_NAME } from "@workspace/config/constants";
import { renderOgImage } from "@workspace/og/render";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

/** Text of every Titan One node in the rendered element tree, in document order. */
function titanOneTexts(node: unknown, out: string[] = []): string[] {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const child of node) titanOneTexts(child, out);
		return out;
	}
	const { props } = node as ReactElement<{ style?: { fontFamily?: string }; children?: unknown }>;
	if (!props) return out;
	if (props.style?.fontFamily === "Titan One" && typeof props.children === "string") out.push(props.children);
	titanOneTexts(props.children, out);
	return out;
}

describe("social image branding", () => {
	it("signs the stock image with the wordmark", () => {
		const texts = titanOneTexts(renderOgImage({ appName: DEFAULT_APP_NAME }));
		expect(texts).toContain("aitrckr");
		expect(texts).not.toContain("elmo");
	});

	it("shows the partner's icon instead of the wordmark on a whitelabel image", () => {
		const texts = titanOneTexts(
			renderOgImage({ appName: "BrandMonitor Pro", iconDataUri: "data:image/png;base64,AAAA" }),
		);
		expect(texts).toEqual([]);
	});
});
