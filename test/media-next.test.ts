// The media library's site-api v0.10.0 writes: caption, focal point and replace, and several files in
// one upload. Planted: an Editor's replace (it changes every page that shows the file) is refused
// before the site hears anything, and a replacement of another type is refused, since the address
// names the type.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { action as mediaAction } from "~/routes/media";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, nextSite, routeContext } from "./site";

const SLUG = "de-info";
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let site: ReturnType<typeof nextSite>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  await share(await addProject(SLUG, "dustinedwards"), editor, "editor");
  site = nextSite({ media: true });
  env = connectedEnv();
  vi.stubGlobal("fetch", site.fetch);
});

async function seedFile(name = "river.png") {
  const item = await site.adapter.media!.upload({ bytes: PNG, contentType: "image/png", filename: name, alt: "", changeId: `seed-${name}` });
  return { ...item, version: (await site.adapter.media!.get(item.id))!.version! };
}

async function post(fields: Record<string, string | File | (string | File)[]>, email: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) form.append(k, one);
  const request = new Request(`https://carrel.test/p/${SLUG}/media`, { method: "POST", body: form });
  return mediaAction({ request, params: { project: SLUG }, context: await routeContext(env, email) } as never).catch((thrown: unknown) => thrown);
}

const actions = async () => (await testEnv.DB.prepare("SELECT action FROM changes ORDER BY rowid").all<{ action: string }>()).results.map((r) => r.action);
const png = (name: string) => new File([PNG], name, { type: "image/png" });

describe("caption, focal point and replace", () => {
  it("saves an Editor's caption and focal point as the site keeps them, and records each", async () => {
    const file = await seedFile();
    // Each write moves the file's version, so each sends the one the site holds now.
    const held = () => site.adapter.mediaStore.get(file.id)!.item.version!;
    expect(await post({ intent: "set-caption", id: file.id, version: held(), caption: " The river at dusk " }, "editor@test.invalid")).toMatchObject({ ok: true });
    expect(await post({ intent: "set-focus", id: file.id, version: held(), x: "25", y: "50" }, "editor@test.invalid")).toMatchObject({ ok: true });
    expect(site.adapter.mediaStore.get(file.id)?.item).toMatchObject({ caption: "The river at dusk", focus: "0.25x0.5" });
    expect(await post({ intent: "set-focus", id: file.id, version: held(), x: "", y: "50" }, "editor@test.invalid")).toMatchObject({ ok: false, message: "That is not a point on the picture." });
    expect(await post({ intent: "set-focus", id: file.id, version: held(), clear: "yes" }, "editor@test.invalid")).toMatchObject({ ok: true });
    expect(site.adapter.mediaStore.get(file.id)?.item.focus).toBeNull();
    expect(await actions()).toEqual(["media-caption", "media-focus", "media-focus"]);
  });

  it("PLANT: refuses an Editor's replace before the site hears anything, and a replacement of another type", async () => {
    const file = await seedFile();
    site.requests.length = 0;
    expect(((await post({ intent: "replace", id: file.id, version: file.version, file: png("new.png") }, "editor@test.invalid")) as Response).status).toBe(403);
    expect(site.requests.filter((r) => r.startsWith("PUT"))).toEqual([]);
    const jpeg = new File([PNG], "new.jpg", { type: "image/jpeg" });
    expect(await post({ intent: "replace", id: file.id, version: file.version, file: jpeg }, "owner@test.invalid")).toMatchObject({ ok: false, message: expect.stringContaining("same type") });
    expect(await post({ intent: "replace", id: file.id, version: file.version, file: png("new.png") }, "owner@test.invalid")).toMatchObject({ intent: "replace", ok: true, id: file.id, sizesNeedPurge: true });
    expect(await actions()).toEqual(["media-replace"]);
  });
});

describe("several files in one upload", () => {
  it("uploads each file the form posts and names each one", async () => {
    const result = await post({ intent: "upload", file: [png("a.png"), png("b.png")], alt: "ignored for two" }, "editor@test.invalid");
    expect(result).toMatchObject({ intent: "upload", ok: true, refused: [], uploaded: [{ name: "a.png" }, { name: "b.png" }] });
    expect((await site.adapter.media!.list({ limit: 50 })).items.map((i) => i.alt)).toEqual(["", ""]);
  });
});
