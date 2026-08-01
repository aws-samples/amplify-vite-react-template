interface LandingPageData {
  slug: string;
  state?: string;
  stateAbbr?: string;
  region?: string;
  headline: string;
  subheadline: string;
  trustSignals: string[];
  urgencyText?: string;
  metaTitle: string;
  metaDescription: string;
}

export const landingPages: LandingPageData[] = [
  {
    slug: "massachusetts",
    state: "Massachusetts",
    stateAbbr: "MA",
    headline: "Massachusetts HOA Insurance — Free Coverage Assessment",
    subheadline: "Get a board-ready coverage review for your MA condominium trust or association. We specialize in Massachusetts HOA master policies, D&O, and HO-6 coordination.",
    trustSignals: [
      "Based in Marlborough, MA — we know the local market",
      "Experienced with MA condominium trust structures",
      "Per-unit water deductible specialists",
    ],
    urgencyText: "MA renewal season is approaching — most carriers require 60+ days lead time",
    metaTitle: "Free Massachusetts HOA Insurance Assessment — ProtectMyHOA",
    metaDescription: "Get a free, board-ready coverage assessment for your Massachusetts HOA or condominium trust. Master policies, D&O, HO-6 coordination. Based in Marlborough, MA.",
  },
  {
    slug: "rhode-island",
    state: "Rhode Island",
    stateAbbr: "RI",
    headline: "Rhode Island HOA Insurance — Free Coverage Assessment",
    subheadline: "Coastal and urban RI associations face unique coverage challenges. Get a personalized review that accounts for wind exposure, flood risk, and loss assessment gaps.",
    trustSignals: [
      "Experienced with RI coastal condominium exposure",
      "Rhode Island Condominium Act compliance",
      "Wind and flood coverage coordination",
    ],
    urgencyText: "Coastal RI carriers are tightening underwriting — review your coverage now",
    metaTitle: "Free Rhode Island HOA Insurance Assessment — ProtectMyHOA",
    metaDescription: "Free coverage assessment for Rhode Island HOA and condominium associations. Coastal exposure, wind, flood, and loss assessment specialists.",
  },
  {
    slug: "new-hampshire",
    state: "New Hampshire",
    stateAbbr: "NH",
    headline: "New Hampshire HOA Insurance — Free Coverage Assessment",
    subheadline: "NH associations face freeze, ice dam, and snow load risks that generic agencies miss. Get a coverage review built for New Hampshire winters.",
    trustSignals: [
      "New England freeze and ice dam claim specialists",
      "NH Condominium Act (RSA 356-B) compliance",
      "Building valuation for current construction costs",
    ],
    urgencyText: "Post-winter is the best time to review — before your renewal locks in",
    metaTitle: "Free New Hampshire HOA Insurance Assessment — ProtectMyHOA",
    metaDescription: "Free coverage assessment for New Hampshire HOA and condominium associations. Freeze damage, ice dams, and winter exposure specialists.",
  },
  {
    slug: "connecticut",
    state: "Connecticut",
    stateAbbr: "CT",
    headline: "Connecticut HOA Insurance — Free Coverage Assessment",
    subheadline: "From Fairfield County to Hartford, CT associations need coverage that addresses water damage, aging buildings, and CIOA requirements. We'll review yours for free.",
    trustSignals: [
      "Connecticut CIOA compliance specialists",
      "Water damage — CT's #1 claim type — is our focus",
      "Fairfield County high-value property experience",
    ],
    urgencyText: "Water damage claims are rising across CT — is your coverage keeping up?",
    metaTitle: "Free Connecticut HOA Insurance Assessment — ProtectMyHOA",
    metaDescription: "Free coverage assessment for Connecticut HOA and condominium associations. CIOA compliance, water damage, and aging building specialists.",
  },
  {
    slug: "new-york",
    state: "New York",
    stateAbbr: "NY",
    headline: "New York HOA Insurance — Free Coverage Assessment",
    subheadline: "NYC co-ops, upstate condos, and everything in between. New York's complex regulatory environment demands specialized HOA coverage. Let us review yours.",
    trustSignals: [
      "NYC Local Law 11 (FISP) compliance experience",
      "High-rise and cooperative corporation specialists",
      "Experienced with NY's demanding insurance requirements",
    ],
    urgencyText: "NY property valuations are shifting — outdated limits leave boards exposed",
    metaTitle: "Free New York HOA Insurance Assessment — ProtectMyHOA",
    metaDescription: "Free coverage assessment for New York HOA, condominium, and cooperative associations. Local Law 11, D&O, high-rise specialists.",
  },
  {
    slug: "oklahoma",
    state: "Oklahoma",
    stateAbbr: "OK",
    headline: "Oklahoma HOA Insurance — Free Coverage Assessment",
    subheadline: "Hail, wind, and tornado exposure make Oklahoma one of the hardest states for HOA insurance. We help boards find coverage that actually holds up after a storm.",
    trustSignals: [
      "Oklahoma catastrophic weather specialists",
      "Carrier market navigation for storm-prone areas",
      "Post-storm replacement cost accuracy",
    ],
    urgencyText: "Storm season is coming — make sure your coverage is ready",
    metaTitle: "Free Oklahoma HOA Insurance Assessment — ProtectMyHOA",
    metaDescription: "Free coverage assessment for Oklahoma HOA and condominium associations. Hail, wind, tornado, and severe storm coverage specialists.",
  },
  {
    slug: "new-england",
    region: "New England",
    headline: "New England HOA Insurance — Free Coverage Assessment",
    subheadline: "Massachusetts, Rhode Island, New Hampshire, and Connecticut associations share common challenges: freeze damage, aging buildings, strict codes, and rising water claims. We're New England's HOA insurance specialists.",
    trustSignals: [
      "Based in Marlborough, MA — serving all of New England",
      "Freeze, ice dam, and water damage claim specialists",
      "Multi-state carrier relationships across the region",
      "Experienced with MA trusts, RI coastal, NH mountain, and CT CIOA requirements",
    ],
    urgencyText: "New England renewal season — get ahead of your board's next decision",
    metaTitle: "Free New England HOA Insurance Assessment — ProtectMyHOA",
    metaDescription: "Free coverage assessment for New England HOA and condominium associations. Serving MA, RI, NH, CT. Freeze damage, water claims, and building code specialists.",
  },
];
