// The formatted editor's toolbar icons (rich-editor.tsx): 24-unit stroke paths, hidden from screen
// readers because each button carries its own name.

export const GLYPH = {
  bold: ["M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z"],
  italic: ["M15 4h-5M14 20H9M14 4 10 20"],
  link: ["M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1", "M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"],
  heading: ["M6 4v16M18 4v16M6 12h12"],
  code: ["m8 6-6 6 6 6M16 6l6 6-6 6"],
  footnote: ["M4 6h10M4 12h10M4 18h7", "M18 5v6M21 8h-6"],
  image: ["M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "m3 16 5-5 5 5", "M15.5 8.5h.01"],
};

export function Icon({ paths }: { paths: string[] }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
