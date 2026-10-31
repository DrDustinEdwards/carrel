// The form and the submit the content-kit screens (posts, media, mentions) hand Capsomer's lists.
// Moving between views (a tab, the filters, a page) is the router's GET, so it stays in the app; a post
// is a plain form, which the list sends through `submit` with script and the browser sends to the
// route's action without.

import type { IntentResult } from "@dustinedwards/site-api/admin";
import type { FormComponent } from "capsomer/react/posts-list";
import { Form, useRevalidator, type FormProps } from "react-router";

export const KitForm: FormComponent = ({ method, action, ...props }) =>
  (method ?? "get").toLowerCase() === "get" ? <Form {...(props as Omit<FormProps, "method" | "action">)} action={typeof action === "string" ? action : undefined} method="get" /> : <form {...props} action={action} method={method} />;

/** With script each intent posts to the screen's JSON endpoint, and the page reads its data again after it. */
export function useKitSubmit(endpoint: string): (form: FormData) => Promise<IntentResult> {
  const revalidator = useRevalidator();
  return async (form) => {
    const response = await fetch(endpoint, { method: "POST", body: form, headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => null)) as IntentResult | { error?: string } | null;
    if (body && "ok" in body) {
      if (!body.confirm) void revalidator.revalidate();
      return body;
    }
    return { ok: false, message: (body && "error" in body && body.error) || `The server answered ${response.status}.` };
  };
}
