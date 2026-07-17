import { Link, NavLink } from "react-router-dom";
import { useState } from "react";
import { PORTAL_URL } from "../lib/portal";

type SubItem   = { label: string; to: string };
type NavGroup  = { label: string; to: string; subItems?: SubItem[] };

const COMMUNITIES_LINKS: SubItem[] = [
  { label: "Common Area Protection", to: "/communities/common-areas" },
  { label: "In-Unit Service",        to: "/communities/in-unit" },
  { label: "HOA & Board Resources",  to: "/communities/hoa-resources" },
  { label: "For Unit Owners",        to: "/communities/for-owners" },
  { label: "Property Managers",      to: "/property-managers" },
];

const SERVICES_LINKS: NavGroup[] = [
  {
    label: "General Pest",
    to: "/services/general-pest",
    subItems: [
      { label: "Ants & Spiders",      to: "/services/general-pest" },
      { label: "Cockroach Control",   to: "/services/cockroach" },
      { label: "Flea & Silverfish",   to: "/services/flea-silverfish" },
      { label: "Wasp / Hornet / Bee", to: "/services/wasp-hornet-bee" },
    ],
  },
  {
    label: "Rodent Control",
    to: "/services/rodent-control",
    subItems: [
      { label: "Mice & Rat Removal",   to: "/services/rodent-control" },
      { label: "Entry Point Sealing",  to: "/services/rodent-control/entry-sealing" },
      { label: "Attic Rodent Control", to: "/services/rodent-control/attic" },
      { label: "Attic Restoration",    to: "/services/rodent-control/attic-restoration" },
    ],
  },
  {
    label: "Mosquito & Tick",
    to: "/services/mosquito-tick",
    subItems: [
      { label: "Yard Mosquito Treatment", to: "/services/mosquito-tick" },
      { label: "Tick Yard Program",       to: "/services/mosquito-tick/tick" },
    ],
  },
  {
    label: "Termite",
    to: "/services/termite",
    subItems: [
      { label: "Termite Inspection",  to: "/services/termite" },
      { label: "Wood Boring Insects", to: "/services/termite/wood-boring" },
    ],
  },
  {
    label: "Wildlife",
    to: "/services/wildlife",
    subItems: [
      { label: "Squirrel, Raccoon & Bat", to: "/services/wildlife" },
    ],
  },
];

const RESIDENTIAL_SERVICES: NavGroup[] = [
  {
    label: "General Pest",
    to: "/residential/general-pest",
    subItems: [
      { label: "Ants & Spiders",      to: "/residential/general-pest" },
      { label: "Cockroach Control",   to: "/residential/cockroach" },
      { label: "Flea & Silverfish",   to: "/residential/flea-silverfish" },
      { label: "Wasp / Hornet / Bee", to: "/residential/wasp-hornet-bee" },
    ],
  },
  {
    label: "Rodent Control",
    to: "/residential/rodent-control",
    subItems: [
      { label: "Mice & Rat Removal",   to: "/residential/rodent-control" },
      { label: "Entry Point Sealing",  to: "/residential/rodent-control/entry-sealing" },
      { label: "Attic Rodent Control", to: "/residential/rodent-control/attic" },
      { label: "Attic Restoration",    to: "/residential/rodent-control/attic-restoration" },
    ],
  },
  {
    label: "Mosquito & Tick",
    to: "/residential/mosquito-tick",
    subItems: [
      { label: "Yard Mosquito Treatment", to: "/residential/mosquito-tick" },
      { label: "Tick Yard Program",       to: "/residential/mosquito-tick/tick" },
    ],
  },
  {
    label: "Termite",
    to: "/residential/termite",
    subItems: [
      { label: "Termite Inspection",  to: "/residential/termite" },
      { label: "Wood Boring Insects", to: "/residential/termite/wood-boring" },
    ],
  },
  {
    label: "Wildlife",
    to: "/residential/wildlife",
    subItems: [
      { label: "Squirrel, Raccoon & Bat", to: "/residential/wildlife" },
    ],
  },
];

const ABOUT_LINKS: SubItem[] = [
  { label: "Our Story",          to: "/" },
  { label: "Service Areas",      to: "/service-areas" },
  { label: "Licensed & Insured", to: "/licensed-insured" },
  { label: "Contact",            to: "/contact" },
];

const CARET = (
  <svg className="bk-nav-caret" width="8" height="5" viewBox="0 0 10 6" fill="none" aria-hidden="true">
    <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const SUB_ARROW = (
  <svg className="bk-sub-arrow" width="6" height="10" viewBox="0 0 6 10" fill="none" aria-hidden="true">
    <path d="M1 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export default function Header() {
  const [menuOpen, setMenuOpen]         = useState(false);
  const [openDropdown, setOpenDropdown] = useState<"residential" | "communities" | "services" | "about" | null>(null);
  const [openSubMenu, setOpenSubMenu]   = useState<string | null>(null);

  const closeAll = () => { setMenuOpen(false); setOpenDropdown(null); setOpenSubMenu(null); };
  const toggleDropdown = (key: "residential" | "communities" | "services" | "about") => {
    setOpenDropdown(d => (d === key ? null : key));
    setOpenSubMenu(null);
  };
  const toggleSubMenu = (label: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenSubMenu(s => (s === label ? null : label));
  };

  return (
    <header className="bk-header">

      {/* ── Top utility bar ── */}
      <div className="bk-topbar">
        <div className="bk-topbar-inner bk-topbar-inner--slim">

          <a href="tel:+15082589294" className="bk-topbar-phone">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 011 1V20a1 1 0 01-1 1C10.74 21 3 13.26 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.24 1.01l-2.21 2.21z"/>
            </svg>
            <span>(508)&nbsp;258&#8209;9294</span>
          </a>

          <a
            href={PORTAL_URL}
            className="bk-topbar-login"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
            </svg>
            Customer Login
          </a>

        </div>
      </div>

      {/* ── Main nav bar ── */}
      <div className="bk-header-main">
        <div className="bk-header-inner">

          <Link to="/" className="bk-logo-link" onClick={closeAll}>
            <img src="/images/logo.png" alt="BuzzKill Pest Control" />
          </Link>

          <button
            className="bk-hamburger"
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(o => !o)}
          >
            <span /><span /><span />
          </button>

          <nav className={`bk-nav${menuOpen ? " is-open" : ""}`} aria-label="Main navigation">

            {/* Residential — dropdown with service categories */}
            <div className={`bk-nav-item${openDropdown === "residential" ? " is-open" : ""}`}>
              <button
                className="bk-nav-link bk-nav-link--btn"
                onClick={() => toggleDropdown("residential")}
                aria-expanded={openDropdown === "residential"}
              >
                Residential {CARET}
              </button>
              <div className="bk-dropdown bk-dropdown--services">
                <NavLink to="/residential" className={({ isActive }) => `bk-dropdown-link${isActive ? " is-active" : ""}`} onClick={closeAll} end>
                  Overview
                </NavLink>
                {RESIDENTIAL_SERVICES.map(link => (
                  <div
                    key={link.label}
                    className={`bk-dropdown-item${openSubMenu === `res-${link.label}` ? " is-open" : ""}`}
                  >
                    <div className="bk-dropdown-item-row">
                      <NavLink
                        to={link.to}
                        className={({ isActive }) => `bk-dropdown-link${isActive ? " is-active" : ""}`}
                        onClick={closeAll}
                        end
                      >
                        {link.label}
                      </NavLink>
                      {link.subItems && (
                        <button
                          className="bk-dropdown-sub-toggle"
                          onClick={(e) => toggleSubMenu(`res-${link.label}`, e)}
                          aria-label={`Expand ${link.label}`}
                        >
                          {SUB_ARROW}
                        </button>
                      )}
                    </div>
                    {link.subItems && (
                      <div className="bk-dropdown-sub">
                        {link.subItems.map(sub => (
                          <NavLink
                            key={sub.label}
                            to={sub.to}
                            className={({ isActive }) => `bk-dropdown-link bk-dropdown-link--sub${isActive ? " is-active" : ""}`}
                            onClick={closeAll}
                          >
                            {sub.label}
                          </NavLink>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Communities — dropdown */}
            <div className={`bk-nav-item${openDropdown === "communities" ? " is-open" : ""}`}>
              <button
                className="bk-nav-link bk-nav-link--btn"
                onClick={() => toggleDropdown("communities")}
                aria-expanded={openDropdown === "communities"}
              >
                Communities {CARET}
              </button>
              <div className="bk-dropdown">
                <NavLink to="/communities" className={({ isActive }) => `bk-dropdown-link${isActive ? " is-active" : ""}`} onClick={closeAll} end>
                  Overview
                </NavLink>
                {COMMUNITIES_LINKS.map(link => (
                  <NavLink
                    key={link.label}
                    to={link.to}
                    className={({ isActive }) => `bk-dropdown-link${isActive ? " is-active" : ""}`}
                    onClick={closeAll}
                  >
                    {link.label}
                  </NavLink>
                ))}
              </div>
            </div>

            {/* Services — dropdown with flyout sub-menus */}
            <div className={`bk-nav-item${openDropdown === "services" ? " is-open" : ""}`}>
              <button
                className="bk-nav-link bk-nav-link--btn"
                onClick={() => toggleDropdown("services")}
                aria-expanded={openDropdown === "services"}
              >
                Services {CARET}
              </button>
              <div className="bk-dropdown bk-dropdown--services">
                {SERVICES_LINKS.map(link => (
                  <div
                    key={link.label}
                    className={`bk-dropdown-item${openSubMenu === link.label ? " is-open" : ""}`}
                  >
                    <div className="bk-dropdown-item-row">
                      <NavLink
                        to={link.to}
                        className={({ isActive }) => `bk-dropdown-link${isActive ? " is-active" : ""}`}
                        onClick={closeAll}
                        end
                      >
                        {link.label}
                      </NavLink>
                      {link.subItems && (
                        <button
                          className="bk-dropdown-sub-toggle"
                          onClick={(e) => toggleSubMenu(link.label, e)}
                          aria-label={`Expand ${link.label}`}
                        >
                          {SUB_ARROW}
                        </button>
                      )}
                    </div>
                    {link.subItems && (
                      <div className="bk-dropdown-sub">
                        {link.subItems.map(sub => (
                          <NavLink
                            key={sub.label}
                            to={sub.to}
                            className={({ isActive }) => `bk-dropdown-link bk-dropdown-link--sub${isActive ? " is-active" : ""}`}
                            onClick={closeAll}
                          >
                            {sub.label}
                          </NavLink>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* About BuzzKill — dropdown */}
            <div className={`bk-nav-item${openDropdown === "about" ? " is-open" : ""}`}>
              <button
                className="bk-nav-link bk-nav-link--btn"
                onClick={() => toggleDropdown("about")}
                aria-expanded={openDropdown === "about"}
              >
                About BuzzKill {CARET}
              </button>
              <div className="bk-dropdown">
                {ABOUT_LINKS.map(link => (
                  <NavLink
                    key={link.label}
                    to={link.to}
                    className={({ isActive }) => `bk-dropdown-link${isActive ? " is-active" : ""}`}
                    onClick={closeAll}
                  >
                    {link.label}
                  </NavLink>
                ))}
              </div>
            </div>

            <span className="bk-nav-spacer" aria-hidden="true" />

            <Link to="/quote" className="bk-btn bk-btn-primary bk-nav-cta-btn" onClick={closeAll}>
              Get Instant Quote
            </Link>

          </nav>

        </div>
      </div>

    </header>
  );
}
