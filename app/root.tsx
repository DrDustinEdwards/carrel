import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import { getNonce } from "~/lib/context";

import type { Route } from "./+types/root";
import "./app.css";

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
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
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

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : "Something went wrong";
  return (
    <main className="shell">
      <h1>{title}</h1>
    </main>
  );
}
