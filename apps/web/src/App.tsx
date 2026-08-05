import { useEffect, Suspense } from "react";
import { BrowserRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { captureAttribution } from "./lib/leadIntake";
import Header from "./components/Header";
import Footer from "./components/Footer";
import ScrollToTop from "./components/ScrollToTop";
import AnalyticsTracker from "./components/AnalyticsTracker";
import ClickTracker from "./components/ClickTracker";
import ScrollDepthTracker from "./components/ScrollDepthTracker";
import ScrollProgress from "./components/ScrollProgress";
import { TalkToExpertProvider } from "./components/TalkToExpertModal";
import PageErrorBoundary from "./components/PageErrorBoundary";
import lazyPage from "./lib/lazyPage";

// Pages are code-split (lazyPage) so each route loads only its own JS chunk
// instead of one big bundle — faster first paint, better Core Web Vitals.
// Header/Footer and the trackers stay eager (they're on every page).
// lazyPage rather than React's lazy: a deploy replaces every hashed chunk, so
// a session already open asks for files that no longer exist. It reloads once
// to pick up the new index.html, and PageErrorBoundary catches what it can't
// recover — the alternative, seen on staging at /book, is a blank white page.
const Home             = lazyPage(() => import("./pages/Home"));
const Residential      = lazyPage(() => import("./pages/residential/Residential"));
const Communities      = lazyPage(() => import("./pages/Communities"));
const PropertyManagers = lazyPage(() => import("./pages/PropertyManagers"));
const AboutPage        = lazyPage(() => import("./pages/AboutPage"));
const ServiceAreas     = lazyPage(() => import("./pages/ServiceAreas"));
const Reviews          = lazyPage(() => import("./pages/Reviews"));
const Careers          = lazyPage(() => import("./pages/Careers"));
const Contact          = lazyPage(() => import("./pages/Contact"));

const CommonAreaProtection = lazyPage(() => import("./pages/communities/CommonAreaProtection"));
const InUnitService        = lazyPage(() => import("./pages/communities/InUnitService"));
const HOAResources         = lazyPage(() => import("./pages/communities/HOAResources"));
const ForUnitOwners        = lazyPage(() => import("./pages/communities/ForUnitOwners"));

const AntsSpiders             = lazyPage(() => import("./pages/services/AntsSpiders"));
const RodentControl           = lazyPage(() => import("./pages/services/RodentControl"));
const MosquitoTick            = lazyPage(() => import("./pages/services/MosquitoTick"));
const Termite                 = lazyPage(() => import("./pages/services/Termite"));
const Wildlife                = lazyPage(() => import("./pages/services/Wildlife"));
const Cockroach               = lazyPage(() => import("./pages/services/Cockroach"));
const FleaSilverfish          = lazyPage(() => import("./pages/services/FleaSilverfish"));
const WaspHornetBee           = lazyPage(() => import("./pages/services/WaspHornetBee"));
const RodentEntrySealing      = lazyPage(() => import("./pages/services/RodentEntrySealing"));
const RodentAttic             = lazyPage(() => import("./pages/services/RodentAttic"));
const AtticRestoration        = lazyPage(() => import("./pages/services/AtticRestoration"));
const TickProgram             = lazyPage(() => import("./pages/services/TickProgram"));
const TermiteTreatment        = lazyPage(() => import("./pages/services/TermiteTreatment"));
const WoodBoring              = lazyPage(() => import("./pages/services/WoodBoring"));
const HumaneRemoval           = lazyPage(() => import("./pages/services/HumaneRemoval"));

const CondoServices    = lazyPage(() => import("./pages/CondoServices"));
const InUnitServices   = lazyPage(() => import("./pages/InUnitServices"));
const PrivacyPolicy    = lazyPage(() => import("./pages/PrivacyPolicy"));
const TermsOfService   = lazyPage(() => import("./pages/TermsOfService"));
const CityPage         = lazyPage(() => import("./pages/CityPage"));
const LicensedInsured  = lazyPage(() => import("./pages/LicensedInsured"));
const LPQuote          = lazyPage(() => import("./pages/lp/LPQuote"));
const LPProtect        = lazyPage(() => import("./pages/lp/LPProtect"));
const LPCall           = lazyPage(() => import("./pages/lp/LPCall"));
const MAServiceArea    = lazyPage(() => import("./pages/MAServiceArea"));
const RIServiceArea    = lazyPage(() => import("./pages/RIServiceArea"));
const QuotePage        = lazyPage(() => import("./pages/booking/QuotePage"));
const BookPage         = lazyPage(() => import("./pages/booking/BookPage"));
const CancelPage       = lazyPage(() => import("./pages/booking/CancelPage"));
const TrackPage        = lazyPage(() => import("./pages/booking/TrackPage"));

/** Brief, on-brand loader shown while a page's chunk loads (self-contained, no CSS needed). */
function PageFallback() {
  return (
    <div style={{ minHeight: "60vh", display: "grid", placeItems: "center" }} aria-busy="true">
      <svg width="42" height="42" viewBox="0 0 50 50" role="img" aria-label="Loading">
        <circle
          cx="25" cy="25" r="20" fill="none"
          stroke="#7ac142" strokeWidth="5" strokeLinecap="round" strokeDasharray="80 42"
        >
          <animateTransform
            attributeName="transform" type="rotate"
            from="0 25 25" to="360 25 25" dur="0.8s" repeatCount="indefinite"
          />
        </circle>
      </svg>
    </div>
  );
}

function SiteLayout() {
  return (
    <>
      <ScrollProgress />
      <a href="#main-content" className="bk-skip-link">Skip to main content</a>
      <Header />
      <main id="main-content">
        {/* Suspense inside the layout so Header/Footer stay visible while a page
            chunk loads — and the boundary inside the layout for the same reason,
            so a page that fails to load costs the page, not the whole site. */}
        <PageErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </PageErrorBoundary>
      </main>
      <Footer />
    </>
  );
}

/** Standalone (no header/footer) wrapper that still provides a Suspense boundary for LP chunks. */
function BareLayout() {
  return (
    <PageErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <Outlet />
      </Suspense>
    </PageErrorBoundary>
  );
}

export default function App() {
  // First touch wins, so this has to run on the landing page rather than at
  // submit time — by then the ad's utm/gclid params are long gone.
  useEffect(() => {
    captureAttribution();
  }, []);

  return (
    <TalkToExpertProvider>
    <BrowserRouter>
      <ScrollToTop />
      <AnalyticsTracker />
      <ClickTracker />
      <ScrollDepthTracker />
      <Routes>
        {/* Landing pages — standalone, no header/footer (no escape routes) */}
        <Route element={<BareLayout />}>
          <Route path="/lp/quote" element={<LPQuote />} />
          <Route path="/lp/protect" element={<LPProtect />} />
          <Route path="/lp/call" element={<LPCall />} />
          {/* "On My Way" live tracking — private token link from the email,
              standalone (no nav) so the customer just watches the map. */}
          <Route path="/track/:token" element={<TrackPage />} />
        </Route>

        {/* Main site */}
        <Route element={<SiteLayout />}>
          <Route path="/"                     element={<Home />} />

          {/* Audience pages */}
          <Route path="/residential"                                       element={<Residential />} />
          <Route path="/residential/general-pest"                          element={<AntsSpiders />} />
          <Route path="/residential/cockroach"                             element={<Cockroach />} />
          <Route path="/residential/flea-silverfish"                       element={<FleaSilverfish />} />
          <Route path="/residential/wasp-hornet-bee"                       element={<WaspHornetBee />} />
          <Route path="/residential/rodent-control"                        element={<RodentControl />} />
          <Route path="/residential/rodent-control/entry-sealing"          element={<RodentEntrySealing />} />
          <Route path="/residential/rodent-control/attic"                  element={<RodentAttic />} />
          <Route path="/residential/rodent-control/attic-restoration"      element={<AtticRestoration />} />
          <Route path="/residential/mosquito-tick"                         element={<MosquitoTick />} />
          <Route path="/residential/mosquito-tick/tick"                    element={<TickProgram />} />
          <Route path="/residential/termite"                               element={<Termite />} />
          <Route path="/residential/termite/treatment"                     element={<TermiteTreatment />} />
          <Route path="/residential/termite/wood-boring"                   element={<WoodBoring />} />
          <Route path="/residential/wildlife"                              element={<Wildlife />} />
          <Route path="/residential/wildlife/humane-removal"               element={<HumaneRemoval />} />
          <Route path="/communities"                      element={<Communities />} />
          <Route path="/communities/common-areas"         element={<CommonAreaProtection />} />
          <Route path="/communities/in-unit"              element={<InUnitService />} />
          <Route path="/communities/hoa-resources"        element={<HOAResources />} />
          <Route path="/communities/for-owners"           element={<ForUnitOwners />} />
          <Route path="/property-managers"                element={<PropertyManagers />} />

          {/* Services — General Pest */}
          <Route path="/services/general-pest"        element={<AntsSpiders />} />
          <Route path="/services/cockroach"           element={<Cockroach />} />
          <Route path="/services/flea-silverfish"     element={<FleaSilverfish />} />
          <Route path="/services/wasp-hornet-bee"     element={<WaspHornetBee />} />

          {/* Services — Rodent */}
          <Route path="/services/rodent-control"                  element={<RodentControl />} />
          <Route path="/services/rodent-control/entry-sealing"    element={<RodentEntrySealing />} />
          <Route path="/services/rodent-control/attic"            element={<RodentAttic />} />
          <Route path="/services/rodent-control/attic-restoration" element={<AtticRestoration />} />

          {/* Services — Mosquito & Tick */}
          <Route path="/services/mosquito-tick"       element={<MosquitoTick />} />
          <Route path="/services/mosquito-tick/tick"  element={<TickProgram />} />

          {/* Services — Termite */}
          <Route path="/services/termite"                 element={<Termite />} />
          <Route path="/services/termite/treatment"       element={<TermiteTreatment />} />
          <Route path="/services/termite/wood-boring"     element={<WoodBoring />} />

          {/* Services — Wildlife */}
          <Route path="/services/wildlife"                        element={<Wildlife />} />
          <Route path="/services/wildlife/humane-removal"         element={<HumaneRemoval />} />

          {/* About BuzzKill */}
          <Route path="/about"          element={<AboutPage />} />
          <Route path="/service-areas"  element={<ServiceAreas />} />
          <Route path="/reviews"        element={<Reviews />} />
          <Route path="/careers"        element={<Careers />} />
          <Route path="/contact"        element={<Contact />} />

          {/* Legacy audience URLs — still indexed; superseded by /communities */}
          <Route path="/condo-services" element={<CondoServices />} />
          <Route path="/in-unit-services" element={<InUnitServices />} />

          {/* Utility */}
          <Route path="/licensed-insured"           element={<LicensedInsured />} />
          <Route path="/privacy-policy"             element={<PrivacyPolicy />} />
          <Route path="/terms-of-service"           element={<TermsOfService />} />
          <Route path="/pest-control/:slug"         element={<CityPage />} />
          <Route path="/locations/massachusetts"    element={<MAServiceArea />} />
          <Route path="/locations/rhode-island"     element={<RIServiceArea />} />

          {/* Booking funnel — /cancel is linked from confirmation emails,
              so this route must exist for every emailed URL to resolve. */}
          {/* The quote page's two doors each have their own URL, so a link,
              an ad, or a bookmark can land on the one it means. /quote itself
              stays a live route: emailed resume links carry their token in
              its hash, and a redirect would drop it. */}
          <Route path="/quote" element={<QuotePage />} />
          <Route path="/quote/instant" element={<QuotePage />} />
          <Route path="/quote/contact-me" element={<QuotePage />} />
          <Route path="/book" element={<BookPage />} />
          <Route path="/cancel" element={<CancelPage />} />
          {/* The redesign's quote page — the funnel is the one front door. */}
          <Route path="/request-quote" element={<Navigate to="/quote" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </TalkToExpertProvider>
  );
}
