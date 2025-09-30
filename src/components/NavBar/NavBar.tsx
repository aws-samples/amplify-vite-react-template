import { Link } from "react-router-dom";
import { SafProductHeader, SafProductHeaderItem } from '@saffron/core-components/react';
						

export default function NavBar() {
  return (
    <SafProductHeader>
      <a slot="logo" href="/">
        <img src="/logo.png" alt="SONCA Logo" className="sonca-logo" style={{ height: 32 }} />
      Home
      </a>
      <SafProductHeaderItem slot="tasks">
        <Link to="/projects-and-assessments">Projects & Assessments</Link>
      </SafProductHeaderItem>
      <SafProductHeaderItem slot="tasks">
        <Link to="/users-and-organisations">Users & Organisations</Link>
      </SafProductHeaderItem>
      <SafProductHeaderItem slot="tasks">
        <Link to="/framework-management">Framework Management</Link>
      </SafProductHeaderItem>
      <SafProductHeaderItem slot="global">
        <Link to="/notifications">Notifications</Link>
      </SafProductHeaderItem>
    </SafProductHeader>
  );
}