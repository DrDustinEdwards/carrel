// The page's one module script: starts the page and wires the letterhead's theme button (Capsomer's theme switch). www/build.mjs bundles it
// into /site.js, so the page needs no inline script.
import { startPage } from "@dustinedwards/site-runtime/page-client";
import { enhance } from "capsomer/behavior/theme-switch";

// First, as on every page of the network: the Trusted Types default policy and INP reporting (site-runtime ./page-client).
startPage();
enhance();
