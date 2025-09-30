'use client';
import { SafSideNav, SafMenuItem, SafIcon } from "@saffron/core-components/react";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

export default function SideNavContent() {

    const [stateRouter, setStateRouter] = useState<'open' | 'closed'>('open');
    const navigate = useNavigate();
    const isRoot = location.pathname === "/" || location.pathname === "/home";

    return (
        <SafSideNav
          id="with-router-links"
          openAriaLabel="Open Projects and Assessments Navigation"
          closeAriaLabel="Close Projects and Assessments Navigation"
          openIconName="arrow-right-from-line"
          closeIconName="arrow-left-from-line"
          state={stateRouter}
          onOpen={() => setStateRouter('open')}
          onClose={() => setStateRouter('closed')}
        >
          {isRoot ? (
            <>
              {/* <SafMenuItem routerLink url="/projects-and-assessments" navigate={navigate}>
                <SafIcon iconName="house" slot="start"></SafIcon> Overview
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/projects" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Projects
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/assessments" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Assessments
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reviewQueue" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Review Queue
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reports" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Reports
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reports" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Interviews
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reports" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Documents
              </SafMenuItem> */}
            </>
          ) : location.pathname.startsWith("/projects-and-assessments") ? (
            <>
              <SafMenuItem routerLink url="/projects-and-assessments" navigate={navigate}>
                <SafIcon iconName="house" slot="start"></SafIcon> Overview
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/projects" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Projects
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/assessments" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Assessments
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reviewQueue" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Review Queue
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reports" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Reports
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reports" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Interviews
              </SafMenuItem>
              <SafMenuItem routerLink url="/projects-and-assessments/reports" navigate={navigate}>
                <SafIcon iconName="objects-column" slot="start"></SafIcon> Documents
              </SafMenuItem>
            </>
          ) : location.pathname.startsWith("/users-and-organisations") ? (
            <>
              <SafMenuItem routerLink url="/users & organisations/users" navigate={navigate}>
            <SafIcon iconName="house" slot="start"></SafIcon> Users
              </SafMenuItem>
              <SafMenuItem routerLink url="/users & organisations/organisations" navigate={navigate}>
            <SafIcon iconName="objects-column" slot="start"></SafIcon> Organisations
              </SafMenuItem>
              <SafMenuItem routerLink url="/users & organisations/permissions" navigate={navigate}>
            <SafIcon iconName="objects-column" slot="start"></SafIcon> Permissions
              </SafMenuItem>
            </>
            ) : location.pathname.startsWith("/framework-management") ? (   
            <>
            <SafMenuItem routerLink url="/framework-management/frameworks" navigate={navigate}>
                <SafIcon iconName="house" slot="start"></SafIcon> Frameworks
            </SafMenuItem>  
            </>
            ) : location.pathname.startsWith("/projects-and-assessments/projects") ? (
            <>
            </>
          ) : null}
        </SafSideNav>
    );
}
