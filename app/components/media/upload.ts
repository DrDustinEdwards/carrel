// What the editor knows about a project's media. The upload itself is Capsomer's uploadImage (capsomer/behavior/
// media-picker): one file, with its alt text or marked decorative, to Carrel's per-project media endpoint.

export type EditorMedia = {
  /** Carrel's media endpoint for this project: GET lists for the picker, POST uploads. */
  endpoint: string;
  /** The types the site accepts, for the file chooser's `accept`. A hint, not a control: the site checks. */
  accept: string;
  /** The site's own Markdown for an image with its alt text, and its caption when it has one. */
  figure: (url: string, alt: string, caption?: string) => string;
};
