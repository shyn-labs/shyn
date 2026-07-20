// Deterministic synthetic personal corpus for the retrieval eval harness.
//
// 8 themes x 5 docs = 40 docs. Each theme contributes 3 labeled queries:
//   - kw:  shares literal content words with doc 0 of the theme (keyword-answerable)
//   - kw2: shares literal content words with doc 2 of the theme (keyword-answerable,
//          exercises keyword search against a *different* doc than kw)
//   - sem: a paraphrase of doc 0's content that shares NO content words with it
//          (only embeddings/hybrid search can answer this one)
//
// Why kw/kw2 (2 keyword queries) instead of a flat 1:1 keyword:semantic split:
// SQLite FTS5 MATCH with multiple quoted tokens is an implicit AND (verified against
// this repo's search-keyword.ts sanitizeFts, which quotes every token). A semantic
// query that shares zero content words with its target doc can therefore NEVER be
// answered by keyword search -- that's the entire point of having two separate bars.
// But that also means keyword-only recall is hard-capped at (# keyword queries) /
// (# total queries). A strict 1 kw : 1 sem split per theme caps keyword recall at
// 0.5, which can never clear the pre-committed 0.6 keyword bar no matter how the
// engine performs. Using 2 keyword queries per theme (kw, kw2) against 1 semantic
// query raises that ceiling to 0.667, making the 0.6 bar meaningful (achievable, but
// still fails if keyword search is actually broken) while keeping every semantic
// query fully clean (zero content-word overlap with its target doc).

export type EvalDoc = { id: string; source: "file" | "browser" | "notes"; title: string; text: string };
export type EvalQuery = { query: string; relevant: string[]; kind: "keyword" | "semantic" };

type Theme = {
  name: string;
  docs: [string, string][];
  kw: string;   // targets docs[0], literal content-word overlap
  kw2: string;  // targets docs[2], literal content-word overlap
  sem: string;  // targets docs[0], paraphrase with ZERO content-word overlap
};

const themes: Theme[] = [
  { name: "carbon",
    docs: [
      ["Soil carbon pricing", "Voluntary carbon markets set soil credit prices via reverse auctions and vintage discounts."],
      ["Offtake negotiations", "Buyers negotiate multi-year offtakes for durable removals with delivery guarantees."],
      ["Biochar economics", "Biochar projects in arid regions earn premium prices for permanence above 100 years."],
      ["MRV costs", "Measurement reporting and verification eats 30 percent of smallholder project revenue."],
      ["Registry backlogs", "Verra and Gold Standard queues delay issuance by 14 months on average."],
    ],
    kw: "soil carbon credit prices",
    kw2: "biochar arid premium permanence",
    sem: "how much do buyers pay for dirt-based climate offsets" },
  { name: "cooking",
    docs: [
      ["Filter coffee ratios", "South Indian filter coffee needs 1:4 decoction to milk ratio, PB grade chicory blend."],
      ["Dosa batter", "Ferment urad dal and idli rice 12 hours; salt after fermentation in cold weather."],
      ["Biryani layering", "Layer par-cooked basmati over marinated chicken; dum on lowest flame 25 minutes."],
      ["Sambar powder", "Roast chana dal, coriander, byadgi chilies separately before grinding sambar powder."],
      ["Ghee clarification", "Simmer butter until milk solids brown for nutty granular ghee."],
    ],
    kw: "filter coffee decoction ratio",
    kw2: "basmati marinated chicken dum flame",
    sem: "the right strength for traditional drip brew from the subcontinent" },
  { name: "fitness",
    docs: [
      ["Progressive overload basics", "Progressive overload means adding weight, reps, or sets over time so muscles keep adapting during strength training."],
      ["Deload weeks", "Deload weeks cut volume by half every six weeks to let joints recover before the next strength block."],
      ["Protein timing", "Eating 30 grams of protein within two hours after training maximizes muscle protein synthesis."],
      ["Tennis footwork drills", "Split step timing before your opponent contacts the ball improves court coverage on both wings."],
      ["Zone 2 cardio", "Long easy rides at a conversational pace build the aerobic base needed for recovery between sessions."],
    ],
    kw: "progressive overload strength training",
    kw2: "protein muscle synthesis training",
    sem: "why lifters must gradually raise resistance for continuous body growth in the gym" },
  { name: "typescript",
    docs: [
      ["Discriminated unions", "Tagging each variant with a literal kind field enables narrowing inside a switch statement."],
      ["Generic constraints", "Extending a generic parameter with extends keyof restricts callers to valid property names only."],
      ["Utility types", "Partial, Pick, and Omit reshape existing interfaces without duplicating field declarations."],
      ["Async iterators", "For await of loops consume async generators one yielded value at a time."],
      ["Module resolution", "The bundler resolves bare imports using package exports maps defined in package json."],
    ],
    kw: "literal kind field narrowing",
    kw2: "partial pick omit interfaces",
    sem: "how the compiler figures out which shape an object has at runtime" },
  { name: "hiring",
    docs: [
      ["Structured interview scorecards", "Use a structured scorecard with a fixed rubric right after each interview to reduce halo effect bias."],
      ["Take-home exercises", "Cap take-home exercises at ninety minutes so working candidates are not disadvantaged by unpaid time."],
      ["Reference checks", "Ask references for specific examples of conflict resolution rather than generic praise."],
      ["Offer negotiation", "Present a single strong number instead of a wide range to shorten the back and forth."],
      ["Sourcing outreach", "Personalized opening lines referencing a specific project double the response rate on cold messages."],
    ],
    kw: "structured scorecard fixed rubric",
    kw2: "references conflict resolution examples",
    sem: "how do you stop early impressions from skewing who gets the job offer" },
  { name: "travel",
    docs: [
      ["Visa processing times", "Schengen visa appointments book out eight weeks ahead during the summer travel season."],
      ["Packing cubes", "Compressing clothes into cubes by category cuts checked bag weight by nearly a third."],
      ["Currency exchange", "Airport counters mark up exchange rates far more than withdrawing local cash from an ATM after landing."],
      ["Jet lag adjustment", "Shifting meal times to the destination zone two days before departure eases the time change."],
      ["Travel insurance claims", "Keep every receipt and a police report copy or the claim gets rejected for missing documentation."],
    ],
    kw: "schengen visa appointments summer",
    kw2: "airport counters exchange rates",
    sem: "how far in advance should you apply before a european trip in peak months" },
  { name: "personal-finance",
    docs: [
      ["Emergency fund sizing", "Keep an emergency fund of six months essential expenses in a liquid account separate from investment savings."],
      ["Term insurance ladder", "Layering several term policies that expire at different ages lowers total premium versus one large policy."],
      ["Index fund expense ratios", "A ten basis point difference compounds to a meaningful gap in returns after three decades."],
      ["Tax loss harvesting", "Selling losers to offset gains before the deadline reduces the current year tax bill."],
      ["Estate will basics", "Without a will, state succession law decides asset distribution instead of the deceased's wishes."],
    ],
    kw: "emergency fund six months expenses",
    kw2: "basis point difference compounds returns",
    sem: "how big a cash cushion do you need before anything else" },
  { name: "parenting",
    docs: [
      ["Toddler tantrum de-escalation", "Naming the feeling out loud calms a toddler tantrum faster than reasoning or bargaining."],
      ["Screen time limits", "Consistent daily caps matter less than which specific apps and content fill that screen time."],
      ["Sibling rivalry", "Avoid comparing achievements between siblings out loud even when the comparison seems flattering."],
      ["Bedtime routine consistency", "The same three steps every night signal to the brain that sleep is coming next."],
      ["Picky eating phases", "Repeated neutral exposure to a new food without pressure increases acceptance over multiple weeks."],
    ],
    kw: "toddler tantrum feeling calms",
    kw2: "comparing achievements siblings comparison flattering",
    sem: "what actually works when a small child melts down screaming in public" },
];

export function corpus(): { docs: EvalDoc[]; queries: EvalQuery[] } {
  const docs: EvalDoc[] = [], queries: EvalQuery[] = [];
  for (const t of themes) {
    t.docs.forEach(([title, text], i) =>
      docs.push({ id: `${t.name}-${i}`, source: i % 2 ? "notes" : "file", title, text }));
    queries.push({ query: t.kw, relevant: [`${t.name}-0`], kind: "keyword" });
    queries.push({ query: t.kw2, relevant: [`${t.name}-2`], kind: "keyword" });
    queries.push({ query: t.sem, relevant: [`${t.name}-0`], kind: "semantic" });
  }
  return { docs, queries };
}
