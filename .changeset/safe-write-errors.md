---
"@workspace/web": patch
---

When saving prompts fails, the editor now shows "Failed to save prompts. Your changes were not saved. Please try again." instead of the database error, which could include the query and the prompt text; other write actions likewise show only messages written for the user.
