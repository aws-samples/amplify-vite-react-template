// @ts-nocheck
import { useState, useEffect, useRef } from 'react';
import { Amplify } from 'aws-amplify';
import { signIn, signUp, signOut, getCurrentUser } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/api';
import './App.css';

// Setup AWS Connection
import outputs from '../amplify_outputs.json';
Amplify.configure(outputs);
const client = generateClient();

export default function App() {
  // --- STATE ---
  const [view, setView] = useState('LOGIN'); 
  const [user, setUser] = useState(null);
  
  // Auth Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');

  // App State
  const [activeOrders, setActiveOrders] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [walletBalance, setWalletBalance] = useState(0);
  const [showProfile, setShowProfile] = useState(false);
  const [chatOrderId, setChatOrderId] = useState(null);
  
  const gpsWatchId = useRef(null);

  // --- LOGIC ---
  const handleAuth = async (type) => {
    try {
      if (type === 'SIGNUP') {
        const { userId } = await signUp({ 
            username: email, 
            password,
            options: { userAttributes: { email, name: fullName, phone_number: phone } }
        });
        await client.models.Driver.create({
            id: userId, email, fullName, phoneNumber: phone, status: 'pending', walletBalance: 0
        });
        setView('PENDING');
      } else {
        await signIn({ username: email, password });
        checkDriverStatus();
      }
    } catch (e) { alert("Auth Error: " + e.message); }
  };

  const checkDriverStatus = async () => {
    try {
        const currentUser = await getCurrentUser();
        setUser(currentUser);
        const { data: driverProfile } = await client.models.Driver.get({ id: currentUser.userId });
        
        if (driverProfile?.status === 'pending') {
            setView('PENDING');
        } else if (driverProfile?.status === 'suspended') {
            setView('SUSPENDED');
        } else {
            setWalletBalance(driverProfile?.walletBalance || 0);
            setView('DASHBOARD');
            startOrderListeners(currentUser.userId);
        }
    } catch (e) { setView('LOGIN'); }
  };

  const handleLogout = async () => {
      stopTracking();
      await signOut();
      setUser(null);
      setView('LOGIN');
  };

  const requestWithdrawal = async () => {
      alert("Processing withdrawal request to M-PESA...");
      setWalletBalance(0);
  };

  // --- ORDER MANAGERS ---
  const startOrderListeners = (driverId) => {
      client.models.Order.observeQuery({
          filter: { status: { eq: 'Pending' } }
      }).subscribe(({ items }) => setPendingOrders(items));

      client.models.Order.observeQuery({
          filter: { status: { eq: 'Accepted' }, driverId: { eq: driverId } }
      }).subscribe(({ items }) => {
          setActiveOrders(items);
          if (items.length > 0) startTracking(items[0].id);
          else stopTracking();
      });
  };

  const acceptOrder = async (orderId) => {
      await client.models.Order.update({
          id: orderId,
          status: 'Accepted',
          driverId: user.userId
      });
  };

  const completeOrder = async (orderId, baseFee) => {
      const pin = prompt("Enter 4-digit customer PIN:");
      if (!pin) return;
      
      await client.models.Order.update({ id: orderId, status: 'Completed' });
      
      const payout = baseFee * 0.95;
      setWalletBalance(prev => prev + payout);
      await client.models.Driver.update({ id: user.userId, walletBalance: walletBalance + payout });
      
      alert(`Success! M${payout.toFixed(2)} added to Wallet.`);
  };

  // --- TRACKING MANAGER ---
  const startTracking = (orderId) => {
      if (gpsWatchId.current) return;
      if (!navigator.geolocation) return;
      
      gpsWatchId.current = navigator.geolocation.watchPosition(
          (position) => {
              client.models.Order.update({
                  id: orderId,
                  driverLat: position.coords.latitude,
                  driverLng: position.coords.longitude
              });
          },
          (error) => console.warn(error),
          { enableHighAccuracy: true, timeout: 5000 }
      );
  };

  const stopTracking = () => {
      if (gpsWatchId.current) {
          navigator.geolocation.clearWatch(gpsWatchId.current);
          gpsWatchId.current = null;
      }
  };

  // --- RENDERS ---

  if (view === 'LOGIN') return (
    <div id="login-screen">
        <div className="login-card">
            <h1 className="login-title">Driver Portal</h1>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="login-input" placeholder="Driver Email" />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="login-input" placeholder="Password" />
            <button className="login-btn-submit" onClick={() => handleAuth('LOGIN')}>Secure Login</button>
            <button onClick={() => setView('SIGNUP')} className="login-link">New Driver? Register here.</button>
        </div>
    </div>
  );

  if (view === 'SIGNUP') return (
    <div id="signup-screen" style={{ padding: '40px 20px', maxWidth: '400px', margin: 'auto', minHeight: '100vh', paddingBottom: '120px' }}>
        <h1 style={{ fontSize: '24px', marginBottom: '10px', color: '#111827', fontWeight: '800' }}>Driver Registration</h1>
        <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '20px' }}>Provide your full details for background verification.</p>
        
        <div className="section-title">Personal Details</div>
        <input type="text" className="input-field" placeholder="Full Name (as on ID)" onChange={e => setFullName(e.target.value)} />
        <input type="tel" className="input-field" placeholder="Phone Number" onChange={e => setPhone(e.target.value)} />
        
        <div className="section-title">Account Security</div>
        <input type="email" className="input-field" placeholder="Email Address" onChange={e => setEmail(e.target.value)} />
        <input type="password" className="input-field" placeholder="Create Password" onChange={e => setPassword(e.target.value)} />
        
        <button className="login-btn-submit" onClick={() => handleAuth('SIGNUP')}>Submit Registration</button>
        <button onClick={() => setView('LOGIN')} style={{ width: '100%', marginTop: '15px', background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '14px' }}>Back to Login</button>
    </div>
  );

  if (view === 'PENDING') return (
    <div id="pending-approval-screen" style={{ padding: '60px 20px', textAlign: 'center', maxWidth: '400px', margin: 'auto' }}>
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="var(--mint)" strokeWidth="2" style={{ marginBottom: '20px' }}>
            <circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <h1 style={{ fontSize: '24px', color: 'var(--text)', fontWeight: '800' }}>Account Under Review</h1>
        <p style={{ color: 'var(--light-text)', marginTop: '10px', fontSize: '14px', lineHeight: '1.5' }}>Your registration has been received. Our admin team is currently reviewing your documents. This page will automatically update once you are approved.</p>
        <button onClick={handleLogout} className="btn-outline" style={{ marginTop: '30px', width: '100%' }}>Log Out</button>
    </div>
  );

  if (view === 'SUSPENDED') return (
    <div id="suspended-screen" style={{ padding: '60px 20px', textAlign: 'center', maxWidth: '400px', margin: 'auto' }}>
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" style={{ marginBottom: '20px' }}>
            <circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
        <h1 style={{ fontSize: '24px', color: '#ef4444', fontWeight: '800' }}>Account Suspended</h1>
        <p style={{ color: 'var(--light-text)', marginTop: '10px', fontSize: '14px', lineHeight: '1.5' }}>Your account has been suspended by the administration. Please contact support for more details.</p>
        <button onClick={handleLogout} className="btn-outline" style={{ marginTop: '30px', width: '100%' }}>Log Out</button>
    </div>
  );

  // DASHBOARD
  return (
    <div id="dashboard" style={{ display: 'block' }}>
      <div className="header">
        <h1 style={{ fontSize: '18px', margin: 0, fontWeight: '800', color: '#111827' }}>Bofelo Driver</h1>
        <div className="header-right">
            <button onClick={() => setShowProfile(true)} className="btn-logout" style={{ background: 'transparent', border: 'none', color: '#6b7280' }}>⚙️ Settings</button>
            <div className="status"><div className="dot"></div> Online</div>
        </div>
      </div>

      <div className="container">
        {/* ACTIVE ORDERS SECTION */}
        <div className="section-title">Active Deliveries</div>
        {activeOrders.length === 0 ? (
            <div className="empty-placeholder"><p className="empty-placeholder-title">No active orders</p></div>
        ) : (
            activeOrders.map(o => (
                <div key={o.id} className="order-card">
                    <div className="card-top">
                        <div className="price">M {o.fee || '0.00'}</div>
                        <div className="status-pill status-active">IN PROGRESS</div>
                    </div>
                    <div className="timeline">
                        <div className="t-line"></div>
                        <div className="step"><div className="marker-pickup"></div><div className="label">PICKUP</div><div className="val">{o.pickup || 'Store'}</div></div>
                        <div className="step"><div className="marker-dropoff"></div><div className="label">DROPOFF</div><div className="val">{o.dropoff || 'Customer'}</div></div>
                    </div>
                    <div className="btn-row" style={{marginTop: '15px'}}>
                        <a href={`https://www.google.com/maps/search/?api=1&query=$$$${encodeURIComponent(o.dropoff)}`} target="_blank" rel="noreferrer" className="btn-outline">🗺 Navigate</a>
                        <button className="btn-outline" onClick={() => setChatOrderId(o.id)}>💬 Chat & Call</button>
                    </div>
                    <button className="btn-complete" onClick={() => completeOrder(o.id, o.fee)}>Complete Delivery (PIN)</button>
                </div>
            ))
        )}

        {/* PENDING ORDERS SECTION */}
        <div className="section-title">New Requests</div>
        {activeOrders.length > 0 ? (
            <div className="empty-placeholder"><p className="empty-placeholder-title">Complete your active delivery to see new requests.</p></div>
        ) : pendingOrders.length === 0 ? (
            <div className="empty-placeholder"><p className="empty-placeholder-title">Waiting for orders...</p></div>
        ) : (
            pendingOrders.map(o => (
                <div key={o.id} className="order-card">
                    <div className="card-top">
                        <div className="price">M {o.fee || '0.00'}</div>
                        <div className="status-pill status-new">NEW</div>
                    </div>
                    <div className="timeline">
                        <div className="t-line"></div>
                        <div className="step"><div className="marker-pickup"></div><div className="label">PICKUP</div><div className="val">{o.pickup || 'Store'}</div></div>
                        <div className="step"><div className="marker-dropoff"></div><div className="label">DROPOFF</div><div className="val">{o.dropoff || 'Customer'}</div></div>
                    </div>
                    <div className="btn-row" style={{marginTop: '15px'}}>
                        <button className="btn-complete" onClick={() => acceptOrder(o.id)}>Accept Order</button>
                    </div>
                </div>
            ))
        )}
      </div>

      {/* PROFILE MODAL */}
      {showProfile && (
          <div id="profile-modal" style={{ display: 'block', position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'var(--bg)', zIndex: 3000, overflowY: 'auto', paddingBottom: '40px' }}>
              <div className="header">
                  <h1 style={{ fontSize: '18px', margin: 0, fontWeight: '800', color: '#111827' }}>Profile & Analytics</h1>
                  <button onClick={() => setShowProfile(false)} style={{ background: 'none', border: 'none', fontSize: '28px', cursor: 'pointer', color: '#6b7280' }}>×</button>
              </div>
              <div className="container">
                  <div className="order-card" style={{ background: 'linear-gradient(135deg, #111827, #1f2937)', color: 'white', padding: '24px', marginTop: '24px', marginBottom: '24px', border: 'none', boxShadow: '0 10px 25px rgba(0,0,0,0.15)' }}>
                      <div className="card-top" style={{ marginBottom: '12px' }}>
                          <div style={{ fontSize: '13px', fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Available to Withdraw</div>
                          <div className="status-pill" style={{ background: 'rgba(255,255,255,0.1)', color: 'white', border: '1px solid rgba(255,255,255,0.2)' }}>M-PESA</div>
                      </div>
                      <div className="price" style={{ marginBottom: '20px', fontSize: '36px', color: '#4ade80' }}>M {walletBalance.toFixed(2)}</div>
                      <button onClick={requestWithdrawal} className="btn-complete" style={{ background: 'white', color: '#111827', padding: '14px', fontSize: '15px', fontWeight: '800', borderRadius: '12px' }}>Withdraw Earnings</button>
                  </div>
                  <button onClick={handleLogout} className="btn-outline" style={{ width: '100%', color: '#ef4444', borderColor: '#ef4444' }}>Secure Log Out</button>
              </div>
          </div>
      )}

      {/* CHAT MODAL */}
      {chatOrderId && (
          <div id="chat-modal" style={{ display: 'block', position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', zIndex: 1000 }}>
              <div className="chat-container" style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '85%', background: '#0b141a', borderTopLeftRadius: '24px', borderTopRightRadius: '24px', display: 'flex', flexDirection: 'column' }}>
                  <div className="chat-header" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'white', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span>Chat & Call</span>
                      <button className="close-chat" onClick={() => setChatOrderId(null)} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: 'white' }}>×</button>
                  </div>
                  <div style={{ padding: '20px', color: 'white', textAlign: 'center' }}>
                      <p>Chat interface active for Order {chatOrderId}</p>
                      <p style={{color: '#6b7280', fontSize: '14px'}}>(Full Chat Component injection point)</p>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}
