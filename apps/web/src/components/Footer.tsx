import { Link } from "react-router-dom";

const Instagram = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
  </svg>
);
const Facebook = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
  </svg>
);
const LinkedIn = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="bk-footer">
      <div className="bk-container bk-footer-inner">
        <div className="bk-footer-brand">
          <Link to="/" aria-label="BuzzKill Pest Control — Home">
            <img src="/images/logo.png" alt="BuzzKill Pest Control" />
          </Link>
        </div>

        <div className="bk-footer-cols">
          <div className="bk-footer-col">
            <div className="bk-eyebrow bk-on-dark-soft">Get in Touch</div>
            <p className="bk-p bk-on-dark">
              420 Lakeside Ave, Suite 104
              <br />
              Marlborough, MA 01752
            </p>
            <p className="bk-p bk-on-dark">
              <strong>Phone:</strong>{" "}
              <a className="bk-footer-link" style={{ display: "inline" }} href="tel:508-258-9294">
                508-258-9294
              </a>
            </p>
            <p className="bk-p bk-on-dark">
              <strong>Email:</strong>{" "}
              <a
                className="bk-footer-link"
                style={{ display: "inline" }}
                href="mailto:info@pestbuzzkill.com"
              >
                info@pestbuzzkill.com
              </a>
            </p>
            <div className="bk-footer-social">
              <a
                href="https://www.instagram.com/buzzkill_pestcontrol/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Instagram"
              >
                <Instagram />
              </a>
              <a
                href="https://www.facebook.com/people/BuzzKill-Pest-Control/61584954290487/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Facebook"
              >
                <Facebook />
              </a>
              <a
                href="https://www.linkedin.com/company/buzzkill-pest-control/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="LinkedIn"
              >
                <LinkedIn />
              </a>
            </div>
          </div>

          <div className="bk-footer-col">
            <div className="bk-eyebrow bk-on-dark-soft">Services</div>
            <Link className="bk-footer-link" to="/condo-services">
              HOA Common-Area Pest Control
            </Link>
            <Link className="bk-footer-link" to="/in-unit-services">
              In&#8209;Unit Pest Control for Owners
            </Link>
            <Link className="bk-footer-link" to="/about">
              About BuzzKill
            </Link>
            <Link className="bk-footer-link" to="/licensed-insured">
              Licensed &amp; Insured
            </Link>
            <Link className="bk-footer-link" to="/#form">
              Start Service
            </Link>
          </div>

          <div className="bk-footer-col">
            <div className="bk-eyebrow bk-on-dark-soft">Account</div>
            <a
              className="bk-footer-link"
              href="https://buzzkill.fieldportals.com/landing/index"
              target="_blank"
              rel="noopener noreferrer"
            >
              Customer Login
            </a>
            <Link className="bk-footer-link" to="/privacy-policy">
              Privacy Policy
            </Link>
            <Link className="bk-footer-link" to="/terms-of-service">
              Terms of Service
            </Link>
          </div>
        </div>
      </div>

      <div className="bk-container bk-footer-legal">
        <span>© {year} BuzzKill Pest Control. All rights reserved.</span>
        <div className="bk-footer-legal-links">
          <Link to="/privacy-policy">Privacy</Link>
          <Link to="/terms-of-service">Terms</Link>
        </div>
      </div>
    </footer>
  );
}
