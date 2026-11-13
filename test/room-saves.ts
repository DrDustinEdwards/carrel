// The rooms with a save still to come. A room's text reaches D1 `rooms` from y-partyserver's debounced
// save after the last change, which can land after a test has ended and the next one has cleared the
// tables: the insert then fails its foreign key (the "failed to persist" noise, and twice a failed run in
// CI). test/entry.ts's room records each change here and clears it when the save that covers it is done,
// and test/setup.ts waits for none to be left after every test.

const unsaved = new Set<object>();

export function changed(room: object): void {
  unsaved.add(room);
}

export function saved(room: object): void {
  unsaved.delete(room);
}

/** Waits until every room's last change is in D1, up to the debounce's longest wait. */
export async function roomsSaved(): Promise<void> {
  for (let i = 0; i < 600 && unsaved.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
  if (unsaved.size > 0) throw new Error(`${unsaved.size} room(s) still unsaved after 6 s`);
}
