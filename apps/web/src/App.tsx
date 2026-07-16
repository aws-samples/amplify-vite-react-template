import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { captureAttribution } from "./lib/leadIntake";
import Header from "./components/Header";
import Footer from "./components/Footer";
import Home from "./pages/Home";
import About from "./pages/About";
import CondoServices from "./pages/CondoServices";
import InUnitServices from "./pages/InUnitServices";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import TermsOfService from "./pages/TermsOfService";
import CityPage from "./pages/CityPage";
import LicensedInsured from "./pages/LicensedInsured";
import LPQuote from "./pages/lp/LPQuote";
import LPProtect from "./pages/lp/LPProtect";
import LPCall from "./pages/lp/LPCall";
import QuotePage from "./pages/booking/QuotePage";
import BookPage from "./pages/booking/BookPage";
import CancelPage from "./pages/booking/CancelPage";
import ScrollToTop from "./components/ScrollToTop";

/** Standard site layout — header + main + footer */
function SiteLayout() {
  return (
    <>
      <a href="#main-content" className="bk-skip-link">
        Skip to main content
      </a>
      <Header />
      <main id="main-content">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

function App() {
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

        {/* Main site — full layout */}
        <Route element={<SiteLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/condo-services" element={<CondoServices />} />
          <Route path="/in-unit-services" element={<InUnitServices />} />
          <Route path="/licensed-insured" element={<LicensedInsured />} />
          <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/terms-of-service" element={<TermsOfService />} />
          <Route path="/pest-control/:slug" element={<CityPage />} />

          {/* Booking funnel — /cancel is linked from confirmation emails,
              so this route must exist for every emailed URL to resolve. */}
          <Route path="/quote" element={<QuotePage />} />
          <Route path="/book" element={<BookPage />} />
          <Route path="/cancel" element={<CancelPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
