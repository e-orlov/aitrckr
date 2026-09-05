import { db } from "@workspace/lib/db/db";
import { type Brand, prompts } from "@workspace/lib/db/schema";
import { assertAllowed, assertPromptSaveAllowed, decidePromptCap, promptSaveDelta } from "@workspace/lib/entitlements";
import { computeSystemTags } from "@workspace/lib/tag-utils";
import { and, eq } from "drizzle-orm";
import { expeditePromptRuns } from "@/lib/expedite-prompts";
import { createMultiplePromptJobSchedulers } from "@/lib/job-scheduler";
import { promptsGainingPremium } from "@/lib/run-config-changes";
import { planPromptSave, type SubmittedPrompt } from "@/server/prompt-save";

export interface SavePromptsDeps {
	/** Enqueues the first job of every newly inserted prompt, after the commit. */
	scheduleNewPrompts: (promptIds: string[]) => Promise<unknown>;
}

const defaultDeps: SavePromptsDeps = { scheduleNewPrompts: createMultiplePromptJobSchedulers };

/**
 * Persist a brand's edited prompt list in one transaction, then hand the new
 * prompts to the scheduler.
 *
 * Scheduling runs after the commit and its failure is logged, not thrown: the
 * rows are already saved, and telling the caller otherwise would make them
 * re-submit a list that is already in the database. Schedule maintenance
 * picks up any prompt that ended up without a job.
 *
 * Callers must have authenticated the user and checked brand access already.
 */
export async function savePromptsForBrand(
	brand: Brand,
	submitted: readonly SubmittedPrompt[],
	deps: SavePromptsDeps = defaultDeps,
) {
	const existingRows = await db
		.select({ id: prompts.id, enabled: prompts.enabled, premiumModels: prompts.premiumModels })
		.from(prompts)
		.where(eq(prompts.brandId, brand.id));
	const existingIds = new Set(existingRows.map((p) => p.id));
	const existingById = new Map(existingRows.map((p) => [p.id, p]));

	const { updates, inserts } = planPromptSave(submitted, existingRows);
	assertAllowed(decidePromptCap(existingRows.length, inserts.length));
	await assertPromptSaveAllowed(brand.organizationId, promptSaveDelta({ updates, inserts }));

	const saved = await db.transaction(async (tx) => {
		for (const { id, prompt, after } of updates) {
			await tx
				.update(prompts)
				.set({
					value: prompt.value,
					enabled: prompt.enabled,
					tags: after.tags,
					systemTags: computeSystemTags(prompt.value, brand.name, brand.website),
					premiumModels: after.premiumModels,
				})
				.where(and(eq(prompts.id, id), eq(prompts.brandId, brand.id)));
		}

		if (inserts.length > 0) {
			await tx.insert(prompts).values(
				inserts.map(({ prompt, after }) => ({
					brandId: brand.id,
					value: prompt.value,
					enabled: prompt.enabled,
					tags: after.tags,
					systemTags: computeSystemTags(prompt.value, brand.name, brand.website),
					premiumModels: after.premiumModels,
				})),
			);
		}

		return tx.query.prompts.findMany({
			where: eq(prompts.brandId, brand.id),
		});
	});

	const newPromptIds = saved.filter((p) => !existingIds.has(p.id)).map((p) => p.id);
	if (newPromptIds.length > 0) {
		deps
			.scheduleNewPrompts(newPromptIds)
			.catch((err) => console.error("Failed to create job schedulers for new prompts:", err));
	}

	// A grounded target added to a prompt that already runs has no history of
	// its own, so it is due immediately — but the prompt's next job is a whole
	// cadence away, and the customer has just paid for the slot.
	await expeditePromptRuns(promptsGainingPremium(existingById, saved));

	return saved;
}
