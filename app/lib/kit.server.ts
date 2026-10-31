// What every content-kit screen (posts, media, mentions) tells the kit about a site and a person: the
// site and its address, and what Carrel's role lets this person do, as the kit's permissions.

import type { ContentSource, IntentResult } from "@dustinedwards/site-api/admin";

import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteConnection, siteEntry } from "~/lib/sites.server";

export function kitBase(env: Env, project: SiteProject): Pick<ContentSource, "site" | "can"> {
  const connection = siteConnection(env, project.site);
  return {
    site: { id: project.site, name: siteEntry(project.site).name, origin: connection.state === "connected" ? connection.origin : "" },
    can: {
      edit: can(project.role, "edit"),
      publish: can(project.role, "publish"),
      deleteContent: can(project.role, "delete_content"),
      deleteMedia: can(project.role, "delete_media"),
      decideMentions: can(project.role, "decide_mention"),
    },
  };
}

/** Runs one posted intent; a site that is not connected or cannot be reached is answered in words, anything else is thrown. */
export async function answer(run: () => Promise<IntentResult>, words: (error: unknown) => string | null): Promise<IntentResult> {
  try {
    return await run();
  } catch (error) {
    const message = words(error);
    if (message === null) throw error;
    return { ok: false, message };
  }
}
