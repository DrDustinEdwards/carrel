// The binder beside the editor (design 4.1): the whole book as Capsomer's tree, the open file chosen.
// A scene moves within its chapter or into another, and a chapter among the chapters, by dragging or
// with Alt and the arrow keys. The tree shows the move at once; the book page's action turns the new
// order into one commit of renames. If Git refuses, the tree goes back and says why. When the open
// file is renamed, the page follows it to its new address.

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Tree, type TreeNode } from "capsomer/react/tree";

import { canMoveTo, fileId, orderFromTree, ROOT, type BinderNode, type Rename } from "~/lib/writing/binder";

type ReorderAnswer = { reorder?: { ok: true; renames: Rename[] } | { ok: false; message: string } };

const toTree = (nodes: BinderNode[]): TreeNode[] =>
  nodes.map((n) => ({ id: n.id, label: n.label, href: n.href, meta: n.meta, children: n.children ? toTree(n.children) : undefined }));

const fromTree = (nodes: TreeNode[]): BinderNode[] =>
  nodes.map((n) => ({ id: n.id, label: n.label, href: n.href, meta: typeof n.meta === "string" ? n.meta : undefined, children: n.children ? fromTree(n.children) : undefined }));

export function Binder({ nodes, book, current, canEdit }: { nodes: BinderNode[]; book: string; current: string; canEdit: boolean }) {
  const shown = useMemo(() => toTree(nodes), [nodes]);
  const [tree, setTree] = useState(shown);
  // A fresh order from the server (after a move, a save or a refresh) replaces what the tree holds.
  useEffect(() => setTree(shown), [shown]);
  const mover = useFetcher<ReorderAnswer>();
  const navigate = useNavigate();
  const handled = useRef<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const answer = mover.data?.reorder;
    if (mover.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (!answer.ok) {
      setTree(shown);
      setProblem(answer.message);
      return;
    }
    setProblem(null);
    const moved = answer.renames.find((r) => r.from === current);
    if (moved) void navigate(`/b/${book}/f/${moved.to}`, { replace: true, preventScrollReset: true });
  }, [mover.state, mover.data, current, book, navigate, shown]);

  const chapter = current.startsWith("chapters/") ? `ch:${current.split("/")[1]}` : null;
  const expanded = [ROOT.chapters, ...(chapter ? [chapter] : []), ...(current.startsWith("bible/") ? [ROOT.bible, `group:bible-${current.split("/")[1]}`] : []), ...(current.startsWith("outline/") ? [ROOT.outline] : []), ...(current.startsWith("notes/") ? [ROOT.notes] : [])];

  return (
    <div className="app-stack" data-tight>
      <Tree
        nodes={tree}
        aria-label="Binder"
        selection="single"
        defaultSelected={[fileId(current)]}
        defaultExpanded={expanded}
        canMove={canEdit ? (move) => canMoveTo(move.id, move.to.parent) : () => false}
        onMove={
          canEdit
            ? (_move, next) => {
                setTree(next);
                setProblem(null);
                void mover.submit({ intent: "reorder", order: JSON.stringify(orderFromTree(fromTree(next))) }, { method: "post", action: `/b/${book}` });
              }
            : undefined
        }
      />
      <p role="status" className="cap-muted app-note">
        {mover.state !== "idle" ? "Saving the new order to Git." : ""}
      </p>
      {problem ? <Alert tone="crit">{problem}</Alert> : null}
      {canEdit ? <p className="cap-muted app-note">Drag a scene or a chapter, or press Alt with an arrow key. The corkboard has buttons for each move.</p> : null}
    </div>
  );
}

/** A site project's binder beside the post editor: its writing by kind, the open item chosen. It only finds and opens. */
export function SiteBinder({ nodes, current }: { nodes: BinderNode[]; current: string }) {
  const shown = useMemo(() => toTree(nodes), [nodes]);
  const open = nodes.find((k) => k.children?.some((c) => c.id === `item:${current}`))?.id;
  return <Tree nodes={shown} aria-label="Binder" selection="single" defaultSelected={[`item:${current}`]} defaultExpanded={open ? [open] : []} />;
}
