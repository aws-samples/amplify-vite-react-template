/**
 * The four stages of a placement.
 *
 * Shared by the homepage and /why-choose-us. Extracted from index.astro when the
 * second page needed it — two copies of the same four steps would eventually
 * disagree, and this is the sequence the whole proposition rests on.
 *
 * A genuine sequence, so the numbers carry meaning rather than decorating.
 */
export interface Stage {
  num: string;
  title: string;
  desc: string;
}

export const STAGES: Stage[] = [
  {
    num: "01",
    title: "Review",
    desc: "We read the current policies, the loss runs and the governing documents, and identify where the coverage and the bylaws disagree.",
  },
  {
    num: "02",
    title: "Compare",
    desc: "We approach our appointed markets and set the responses beside one another on coverage, deductibles and limits.",
  },
  {
    num: "03",
    title: "Place",
    desc: "We bind the option the board selects and confirm the certificates, mortgagee clauses and lender evidence are correct.",
  },
  {
    num: "04",
    title: "Record",
    desc: "We issue The Board Record so the decision, and the reasoning behind it, is documented for the minutes.",
  },
];
