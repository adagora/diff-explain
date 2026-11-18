import { readFile } from "node:fs/promises";

const activities: Record<string, { scope: string; resources: readonly string[] }> = {
  understand: { scope: "behavior", resources: ["activities/understand.md"] },
  work: { scope: "implementation", resources: ["activities/work.md"] },
  review: { scope: "diff", resources: ["review-policy.md", "activities/review.md"] },
  audit: { scope: "repository", resources: ["review-policy.md", "activities/audit.md"] },
  converge: { scope: "findings", resources: ["review-policy.md", "activities/work.md", "activities/converge.md"] },
};

export const workflowActivities = Object.freeze(Object.keys(activities));
export const workflowScopes = Object.freeze(Object.fromEntries(Object.entries(activities).map(([name, activity]) => [name, activity.scope])));

export async function loadWorkflow(activity?: string) {
  if (activity !== undefined && !Object.hasOwn(activities, activity)) {
    throw new Error(`Unknown columbo activity: ${activity}`);
  }
  const selected = activity === undefined ? undefined : activities[activity];
  const resources = ["README.md", ...(selected?.resources ?? [])];
  const documents = await Promise.all(resources.map(async path => ({
    path: `prime/${path}`,
    content: await readFile(new URL(`../../prime/${path}`, import.meta.url), "utf8"),
  })));
  return {
    kind: "columbo.workflow",
    schema_version: 1,
    activity: activity ?? "orient",
    scope: selected?.scope ?? "orientation",
    execution: "current_session",
    model_called: false,
    resources: documents.map(document => document.path),
    instructions: documents.map(document => document.content).join("\n\n---\n\n"),
    next_action: activity === undefined
      ? `For implementation or fixes, load columbo prime work --json. For explicit read-only requests, select understand, review or audit.`
      : `Apply the ${activity} activity to the user's actual request in the current agent session.`,
  };
}
