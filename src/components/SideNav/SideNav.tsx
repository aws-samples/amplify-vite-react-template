import React, { Suspense } from "react";

const SideNavContent = React.lazy(() => import("./SideNavContent"));

// Create a loading component
const LoadingNav = () => (
  <div style={{
    width: '220px',
    height: '100vh',
    backgroundColor: '#f5f5f5',
    borderRight: '1px solid #e0e0e0'
  }}>
    <div style={{
      padding: '16px',
      color: '#666',
      fontSize: '14px'
    }}>
      Loading navigation...
    </div>
  </div>
);

export default function SideNav() {
  return (
    <Suspense fallback={<LoadingNav />}>
      <SideNavContent />
    </Suspense>
  );
}
