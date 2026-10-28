// Applies the theme the reader chose, before first paint (Capsomer's theme switch). www/build.mjs bundles it into
// /theme.js, loaded as a plain script in the head, so the page never flashes the other theme.
import { applyStoredTheme } from "capsomer/behavior/theme-switch";

applyStoredTheme();
