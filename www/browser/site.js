// The page's one module script: wires the letterhead's theme button (Capsomer's theme switch). www/build.mjs bundles it
// into /site.js, so the page needs no inline script.
import { enhance } from "capsomer/behavior/theme-switch";

enhance();
