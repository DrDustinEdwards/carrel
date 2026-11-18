import { Pill } from "capsomer/react/status";

const LOOK = {
  draft: ["secondary", "Draft"],
  scheduled: ["outline", "Scheduled"],
  published: ["default", "Published"],
} as const;

/** Where a post stands on its site; null means the site has no copy of it yet. */
export function ItemStatus({ status }: { status: keyof typeof LOOK | null }) {
  if (!status) return <Pill variant="outline">Not on the site yet</Pill>;
  const [variant, word] = LOOK[status];
  return <Pill variant={variant}>{word}</Pill>;
}
