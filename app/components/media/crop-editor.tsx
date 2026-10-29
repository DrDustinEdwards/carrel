// The Crop button for one image (components/media/detail-panel.tsx). The crop dialog itself
// (crop-dialog.tsx, with its canvas and the shape select) loads the first time the button is pressed,
// so the media page carries only the button; the dialog stays mounted after that, so it opens at once.

import { lazy, Suspense, useState, type ComponentProps } from "react";
import { Button } from "capsomer/react/button";

const CropDialog = lazy(() => import("./crop-dialog"));

type Props = Omit<ComponentProps<typeof CropDialog>, "open" | "opener" | "onClose">;

export function CropEditor(props: Props) {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        onClick={(event) => {
          setOpener(event.currentTarget);
          setOpen(true);
        }}
      >
        Crop<span className="cap-sr-only"> {props.name}</span>
      </Button>
      {opener ? (
        <Suspense fallback={null}>
          <CropDialog {...props} open={open} opener={opener} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
