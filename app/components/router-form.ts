// React Router's forms as the `Form` prop Capsomer's components take. Capsomer's FormComponent gives
// its form the props of a plain <form>, where encType is any string; React Router's Form and a
// fetcher's Form take only the three encodings, so TypeScript refuses one for the other although
// Capsomer never sets encType. The one cast lives here until Capsomer narrows the type.

import { Form, type FetcherWithComponents } from "react-router";
import type { FormComponent } from "capsomer/react/content";

export const RouterForm = Form as unknown as FormComponent;

/** A fetcher's Form (`useFetcher().Form`) as Capsomer's Form prop. */
export const fetcherForm = (form: FetcherWithComponents<unknown>["Form"]) =>
  form as unknown as FormComponent;
