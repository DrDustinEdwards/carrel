import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import { Empty } from "capsomer/react/empty";
import { themeScript } from "capsomer/theme-server";

import { getNonce } from "~/lib/context";

import type { Route } from "./+types/root";
import { LinkPrefetch } from "capsomer/react/link";
import "capsomer/fonts.css";
import "@fontsource-variable/source-serif-4/index.css";
import "@fontsource-variable/source-serif-4/wght-italic.css";
import "./app.css";

// Run before first paint, so a remembered theme never flashes the other one: Capsomer's own
// one-liner; the nonce is what lets the policy run it.
const THEME_SCRIPT = themeScript();

export function meta(): Route.MetaDescriptors {
  return [{ title: "Carrel" }, { name: "robots", content: "noindex, nofollow" }];
}

// Carried through the loader because Layout cannot reach the request context.
export function loader({ context }: Route.LoaderArgs) {
  return { nonce: getNonce(context) };
}

// Paths that act on a GET, so a hovered link never prefetches them (a prefetch runs the loader),
// beyond the family's NEVER_PREFETCH that capsomer/react/link already skips: opening a post or a
// book file seeds its room and moves the person's draft into it (openRoom), and an export
// refreshes the book from Git before it builds the file.
const NO_PREFETCH = ["/p/:project/e/:item", "/b/:project/f", "/b/:project/export"];

export function Layout({ children }: { children: React.ReactNode }) {
  // Layout also renders the error boundary, where the loader may not have run. No fallback: a
  // made-up nonce would satisfy the markup while matching nothing in the header.
  const nonce = useRouteLoaderData<typeof loader>("root")?.nonce;
  return (
    <html lang="en" data-family="olive">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
        {nonce ? <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /> : null}
      </head>
      <body>
        <LinkPrefetch exclude={NO_PREFETCH}>{children}</LinkPrefetch>
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// The last resort, for an error the shell's own boundary could not hold (the layout itself failed).
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : "Something went wrong";
  return (
    <main className="app-page">
      <Empty kind="failed" title={title} action={<a className="cap-btn" href="/">Go to Home</a>}>
        Nothing you wrote is lost.
      </Empty>
    </main>
  );
}
