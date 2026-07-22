import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { captureAttribution } from "./lib/leadIntake";
import Header from "./components/Header";
import Footer from "./components/Footer";
import ScrollToTop from "./components/ScrollToTop";
import ScrollProgress from "./components/ScrollProgress";

import Home             from "./pages/Home";
import Residential      from "./pages/residential/Residential";
import Communities      from "./pages/Communities";
import PropertyManagers from "./pages/PropertyManagers";
import AboutPage        from "./pages/AboutPage";
import ServiceAreas     from "./pages/ServiceAreas";
import Reviews          from "./pages/Reviews";
import Careers          from "./pages/Careers";
import Contact          from "./pages/Contact";

import CommonAreaProtection from "./pages/communities/CommonAreaProtection";
import InUnitService        from "./pages/communities/InUnitService";
import HOAResources         from "./pages/communities/HOAResources";
import ForUnitOwners        from "./pages/communities/ForUnitOwners";

import AntsSpiders             from "./pages/services/AntsSpiders";
import RodentControl           from "./pages/services/RodentControl";
import MosquitoTick            from "./pages/services/MosquitoTick";
import Termite                 from "./pages/services/Termite";
import Wildlife                from "./pages/services/Wildlife";
import Cockroach               from "./pages/services/Cockroach";
import FleaSilverfish          from "./pages/services/FleaSilverfish";
import WaspHornetBee           from "./pages/services/WaspHornetBee";
import RodentEntrySealing      from "./pages/services/RodentEntrySealing";
import RodentAttic             from "./pages/services/RodentAttic";
import AtticRestoration        from "./pages/services/AtticRestoration";
import TickProgram             from "./pages/services/TickProgram";
import TermiteTreatment        from "./pages/services/TermiteTreatment";
import WoodBoring              from "./pages/services/WoodBoring";
import HumaneRemoval           from "./pages/services/HumaneRemoval";

import CondoServices    from "./pages/CondoServices";
import InUnitServices   from "./pages/InUnitServices";
import PrivacyPolicy    from "./pages/PrivacyPolicy";
import TermsOfService   from "./pages/TermsOfService";
import CityPage         from "./pages/CityPage";
import LicensedInsured  from "./pages/LicensedInsured";
import LPQuote          from "./pages/lp/LPQuote";
import LPProtect        from "./pages/lp/LPProtect";
import LPCall           from "./pages/lp/LPCall";
import MAServiceArea    from "./pages/MAServiceArea";
import RIServiceArea    from "./pages/RIServiceArea";
import QuotePage        from "./pages/booking/QuotePage";
import BookPage         from "./pages/booking/BookPage";
import CancelPage       from "./pages/booking/CancelPage";

function SiteLayout() {
  return (
    <>
      <ScrollProgress />
      <a href="#main-content" className="bk-skip-link">Skip to main content</a>
      <Header />
      <main id="main-content">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

export default function App() {
  // First touch wins, so this has to run on the landing page rather than at
  // submit time — by then the ad's utm/gclid params are long gone.
  useEffect(() => {
    captureAttribution();
  }, []);

  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        {/* Landing pages — standalone, no header/footer (no escape routes) */}
        <Route path="/lp/quote" element={<LPQuote />} />
        <Route path="/lp/protect" element={<LPProtect />} />
        <Route path="/lp/call" element={<LPCall />} />

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
          <Route path="/quote" element={<QuotePage />} />
          <Route path="/book" element={<BookPage />} />
          <Route path="/cancel" element={<CancelPage />} />
          {/* The redesign's quote page — the funnel is the one front door. */}
          <Route path="/request-quote" element={<Navigate to="/quote" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
