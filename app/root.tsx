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

import { getNonce } from "~/lib/context";

import type { Route } from "./+types/root";
import "@fontsource/schibsted-grotesk/400.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/600.css";
import "@fontsource/schibsted-grotesk/800.css";
import "@fontsource/martian-mono/400.css";
import "@fontsource-variable/source-serif-4/index.css";
import "@fontsource-variable/source-serif-4/wght-italic.css";
import "./app.css";

// Run before first paint, so a remembered theme never flashes the other one. It is Capsomer's own
// one-liner (theme-switch.md); the nonce is what lets the policy run it.
const THEME_SCRIPT = 'try{var t=localStorage.getItem("cap-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}';

export function meta(): Route.MetaDescriptors {
  return [{ title: "Carrel" }, { name: "robots", content: "noindex, nofollow" }];
}

// Carried through the loader because Layout cannot reach the request context.
export function loader({ context }: Route.LoaderArgs) {
  return { nonce: getNonce(context) };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Layout also renders the error boundary, where the loader may not have run. No fallback: a
  // made-up nonce would satisfy the markup while matching nothing in the header.
  const nonce = useRouteLoaderData<typeof loader>("root")?.nonce;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <Meta />
        <Links />
        {nonce ? <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} /> : null}
      </head>
      <body>
        {children}
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
