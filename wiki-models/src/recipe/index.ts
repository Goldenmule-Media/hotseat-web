/**
 * The `recipe` bundle. Its unit vocabulary is re-exported here as NAMED exports beside the
 * default page-type array: wiki-ui addresses wiki-models only by bundle specifier (there is
 * no `./shared/*` entry in the exports map), and the studio's unit toggles must use exactly
 * the conversions the derived projections use, or a quantity would read one way in the
 * browser and another in the rendered Markdown.
 */
import { Recipe } from "./recipe";

export * from "../shared/units";
export { Recipe };

export const recipePageTypes = [Recipe] as const;
export default recipePageTypes;
