/**
 * `restatement-glossary` page type. A STANDALONE glossary: terms the human wants to own,
 * each defined in their own words and critiqued by an async AI evaluator. It is the
 * glossary of `study-notes` without the notes — there is no source text on the page, so
 * the critic judges a definition against the term and the page's subject alone. Reach for
 * `study-notes` instead when the glossary should grow out of reading notes.
 */
import { definePageType, t, z, zodSchema } from "wiki/authoring";
import {
  allTermsDefined,
  GLOSSARY_DESCRIPTION,
  glossaryCommands,
  glossaryRenderSection,
  glossarySection,
  glossaryTermElement,
} from "../shared/glossary";

const empty = z.object({});

export const RestatementGlossary = definePageType({
  type: "restatement-glossary",
  label: "Restatement glossary",
  description:
    "A standalone glossary: terms worth owning, each restated in the human's own words and critiqued. " +
    "There are no notes and no source text on the page — terms are typed straight into the glossary " +
    "studio. Use `study-notes` instead when the glossary should grow out of reading notes.\n\n" +
    GLOSSARY_DESCRIPTION +
    "\n\n" +
    "`finish` is a human gate, refused while any term is still undefined; `reopen` resumes collecting.",
  version: 1,
  initialStatus: "collecting",
  statusTransitions: [
    t("collecting", "finish", "finished", { agency: "human" }),
    t("finished", "reopen", "collecting", { agency: "human" }),
  ],
  sections: {
    glossary: glossarySection({ mutableIn: ["collecting"] }),
  },
  elements: {
    "glossary-term": glossaryTermElement,
  },
  sectionSet: { mode: "closed" },
  commands: {
    ...glossaryCommands,
    finish: {
      description: "Human sign-off: every term in the glossary is defined. Refused while any term is still `marked`.",
      args: zodSchema(empty),
      transition: { level: "page", event: "finish" },
      preconditions: [allTermsDefined],
    },
    reopen: {
      description: "Reopen a finished glossary to collect more terms.",
      args: zodSchema(empty),
      transition: { level: "page", event: "reopen" },
    },
  },
  render: {
    title: "{title}",
    sections: [glossaryRenderSection()],
  },
});
