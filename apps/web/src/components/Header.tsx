import { Link, NavLink } from "react-router-dom";
import { useState } from "react";

export default function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="bk-header">
      <div className="bk-header-inner">
        <Link to="/" className="bk-logo-link" onClick={close}>
          <img src="/images/logo.png" alt="BuzzKill Pest Control" />
        </Link>

        <button
          className="bk-hamburger"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span />
          <span />
          <span />
        </button>

        <nav className={`bk-nav ${open ? "is-open" : ""}`}>
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `bk-nav-link ${isActive ? "is-active" : ""}`
            }
            onClick={close}
          >
            Home
          </NavLink>
          <NavLink
            to="/about"
            className={({ isActive }) =>
              `bk-nav-link ${isActive ? "is-active" : ""}`
            }
            onClick={close}
          >
            About
          </NavLink>
          <NavLink
            to="/condo-services"
            className={({ isActive }) =>
              `bk-nav-link ${isActive ? "is-active" : ""}`
            }
            onClick={close}
          >
            Condo Services
          </NavLink>
          <NavLink
            to="/in-unit-services"
            className={({ isActive }) =>
              `bk-nav-link ${isActive ? "is-active" : ""}`
            }
            onClick={close}
          >
            In&#8209;Unit Services
          </NavLink>
          <NavLink
            to="/licensed-insured"
            className={({ isActive }) =>
              `bk-nav-link ${isActive ? "is-active" : ""}`
            }
            onClick={close}
          >
            Licensed &amp; Insured
          </NavLink>
          <a
            className="bk-nav-login"
            href="https://buzzkill.fieldportals.com/landing/index"
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
          >
            Customer Login
          </a>
        </nav>
      </div>
    </header>
  );
}
