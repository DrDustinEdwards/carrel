// Carrel's writing surface: Capsomer's markdown editor, given Carrel's blocks, its link targets and its
// image upload, set in the serif prose layout (one column), with "Insert from library" beside it. The
// editor itself, its toolbar, the link palette, the `/` menu and the alt-text step are Capsomer's.

import { useRef } from "react";
import { MarkdownEditor, type LinkTarget } from "capsomer/react/markdown-editor";

import { LibraryInsert } from "~/components/media/library-insert";
import { uploadImage, type EditorMedia } from "~/components/media/upload";
import { SCAFFOLDS } from "~/lib/site-markdown";

export type { LinkTarget };

export function WritingSurface({
  label,
  value,
  onChange,
  readOnly,
  linkTargets,
  media,
}: {
  /** What the surface is called to a screen reader, for example "Post" or "Scene". */
  label: string;
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  linkTargets: LinkTarget[];
  /** The project's media endpoint and the site's figure markup. Absent: no image upload or insert. */
  media?: EditorMedia | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  // Never for a Reader, whatever the parent passes: a read-only editor inserts nothing.
  const images = readOnly ? null : (media ?? null);
  // The editor shows the picture it just uploaded at `src` (an address Carrel's page can load), while
  // the Markdown must carry the site's own address, so each upload remembers which is which.
  const sites = useRef(new Map<string, string>());

  return (
    <div className="app-writing" ref={root}>
      {images ? (
        <div className="app-writing-tools">
          <LibraryInsert media={images} editor={root} />
        </div>
      ) : null}
      <MarkdownEditor
        label={<span className="cap-sr-only">{label}</span>}
        ariaLabel={readOnly ? `${label}, markdown, read only` : `${label}, markdown`}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        placeholder="Write in markdown."
        scaffolds={SCAFFOLDS}
        linkTargets={linkTargets}
        accept={images?.accept}
        onUpload={
          images
            ? async (file) => {
                const uploaded = await uploadImage(images.endpoint, file);
                sites.current.set(uploaded.src, uploaded.url);
                return { url: uploaded.src };
              }
            : undefined
        }
        imageMarkdown={images ? ({ url, alt }) => images.figure(sites.current.get(url) ?? url, alt) : undefined}
      />
    </div>
  );
}
