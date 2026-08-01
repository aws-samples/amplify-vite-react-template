interface StateData {
  name: string;
  abbr: string;
  slug: string;
  title: string;
  description: string;
  heroTitle: string;
  intro: string;
  regulations: string[];
  hoaTypes: string[];
  cities: string[];
}

export const states: StateData[] = [
  {
    name: "Massachusetts",
    abbr: "MA",
    slug: "massachusetts",
    title: "HOA Insurance in Massachusetts — ProtectMyHOA",
    description: "HOA master insurance and HO-6 condo coverage for Massachusetts associations. Serving Boston, Worcester, Springfield, Cambridge, and Marlborough.",
    heroTitle: "HOA Insurance in Massachusetts",
    intro: "Massachusetts has one of the highest concentrations of condominium associations in the country. From historic brownstone trusts in Boston to modern condo developments across the suburbs, HOA boards face unique insurance challenges — including strict building codes, freeze and water damage exposure, and complex governing document requirements. We specialize in placing insurance programs built for MA associations.",
    regulations: [
      "Massachusetts condominium trusts are governed by M.G.L. Chapter 183A",
      "Trustees have fiduciary duties that require adequate insurance coverage",
      "Many MA associations use 'all-in' coverage structures tied to governing documents",
      "Per-unit water deductibles are increasingly common in MA master policies",
    ],
    hoaTypes: ["Condominium trusts", "Homeowner associations", "Mixed-use developments", "Historic property conversions"],
    cities: ["Boston", "Worcester", "Springfield", "Cambridge", "Marlborough"],
  },
  {
    name: "Rhode Island",
    abbr: "RI",
    slug: "rhode-island",
    title: "HOA Insurance in Rhode Island — ProtectMyHOA",
    description: "HOA master insurance and HO-6 coverage for Rhode Island condominium associations. Serving Providence, Warwick, and Cranston.",
    heroTitle: "HOA Insurance in Rhode Island",
    intro: "Rhode Island's coastal and urban condominium communities face distinct insurance challenges — from wind and flood exposure along the coast to aging building stock in Providence and surrounding cities. We help RI association boards navigate carrier markets and place programs that account for the state's unique risk profile.",
    regulations: [
      "Rhode Island Condominium Act (R.I. Gen. Laws § 34-36.1) governs association insurance requirements",
      "Coastal properties may require separate wind/flood coverage",
      "Board fiduciary duties include maintaining adequate insurance",
      "Loss assessment exposure is a growing concern for RI unit owners",
    ],
    hoaTypes: ["Coastal condominiums", "Urban condominium trusts", "Townhouse associations", "Waterfront communities"],
    cities: ["Providence", "Warwick", "Cranston"],
  },
  {
    name: "New Hampshire",
    abbr: "NH",
    slug: "new-hampshire",
    title: "HOA Insurance in New Hampshire — ProtectMyHOA",
    description: "HOA master insurance and HO-6 coverage for New Hampshire associations. Serving Manchester, Nashua, and Concord.",
    heroTitle: "HOA Insurance in New Hampshire",
    intro: "New Hampshire associations face winter-driven risks — freeze damage, ice dams, and heavy snow loads — alongside standard HOA insurance needs. Whether your association is in the Lakes Region, the Seacoast, or the Merrimack Valley, we help NH boards place coverage that accounts for these seasonal exposures.",
    regulations: [
      "NH Condominium Act (RSA 356-B) sets baseline insurance obligations",
      "Freeze and ice dam claims are a leading cause of HOA losses in NH",
      "Building valuation must account for current construction costs",
      "D&O coverage is strongly recommended for volunteer board members",
    ],
    hoaTypes: ["Mountain condominiums", "Suburban HOAs", "Townhouse communities", "Resort-area associations"],
    cities: ["Manchester", "Nashua", "Concord"],
  },
  {
    name: "Connecticut",
    abbr: "CT",
    slug: "connecticut",
    title: "HOA Insurance in Connecticut — ProtectMyHOA",
    description: "HOA master insurance and HO-6 coverage for Connecticut associations. Serving Hartford, Stamford, New Haven, and Bridgeport.",
    heroTitle: "HOA Insurance in Connecticut",
    intro: "Connecticut's condominium market spans from Fairfield County's high-value communities to mid-state associations in Hartford and New Haven. CT boards must navigate complex insurance markets, especially as carriers tighten underwriting around water damage and aging buildings. We help Connecticut associations find programs that work.",
    regulations: [
      "Connecticut Common Interest Ownership Act (CIOA) governs HOA insurance duties",
      "Associations must maintain property and liability insurance per governing documents",
      "Water damage is the leading claim type for CT condominiums",
      "CT requires timely disclosure of insurance changes to unit owners",
    ],
    hoaTypes: ["Condominium associations", "Planned communities", "Mixed-use developments", "Age-restricted communities"],
    cities: ["Hartford", "Stamford", "New Haven", "Bridgeport"],
  },
  {
    name: "New York",
    abbr: "NY",
    slug: "new-york",
    title: "HOA Insurance in New York — ProtectMyHOA",
    description: "HOA master insurance and HO-6 coverage for New York condominium and cooperative associations. Serving NYC, Buffalo, Rochester, and Albany.",
    heroTitle: "HOA Insurance in New York",
    intro: "New York's condominium and cooperative landscape is among the most complex in the country. From high-rise co-ops in Manhattan to suburban HOAs upstate, New York associations face demanding insurance requirements, high replacement costs, and evolving regulatory obligations. We help NY boards place coverage that meets these challenges.",
    regulations: [
      "NY Real Property Law and Condominium Act govern association insurance obligations",
      "Local Law 11 (FISP) facade inspection requirements affect building valuation",
      "NYC properties face significantly higher replacement cost valuations",
      "Cooperative corporations have distinct D&O and fidelity exposure",
    ],
    hoaTypes: ["Condominium associations", "Cooperative corporations", "Planned unit developments", "Mixed-use buildings"],
    cities: ["New York City", "Buffalo", "Rochester", "Albany"],
  },
  {
    name: "Oklahoma",
    abbr: "OK",
    slug: "oklahoma",
    title: "HOA Insurance in Oklahoma — ProtectMyHOA",
    description: "HOA master insurance and HO-6 coverage for Oklahoma associations. Serving Oklahoma City, Tulsa, and Norman.",
    heroTitle: "HOA Insurance in Oklahoma",
    intro: "Oklahoma associations face weather-driven risks that many other states don't — hail, tornadoes, and severe storms drive up claims frequency and make carrier selection critical. We help Oklahoma HOA boards find coverage programs that account for the state's unique catastrophic exposure while keeping costs manageable.",
    regulations: [
      "Oklahoma Unit Ownership Estate Act governs condominium association requirements",
      "Hail and wind are the leading cause of HOA property claims in OK",
      "Carrier availability can be limited due to catastrophic weather exposure",
      "Adequate replacement cost coverage is essential given storm frequency",
    ],
    hoaTypes: ["Suburban HOAs", "Condominium associations", "Townhouse communities", "Gated communities"],
    cities: ["Oklahoma City", "Tulsa", "Norman"],
  },
];
