import { useEffect } from "react";
import { useAuthenticator } from '@aws-amplify/ui-react';
import { fetchAuthSession } from '@aws-amplify/auth';

function App() {
  const { user, signOut } = useAuthenticator();
  
  useEffect(() => {
    async function getIDToken() {
      const session = await fetchAuthSession();
      const token = session?.tokens?.idToken;
      console.log(token);
      return token; 
    }
    getIDToken();

  }, []);

  return (
    <main>
      <h1>{JSON.stringify(user)}</h1>
      <h1>{user?.signInDetails?.loginId}'s todos</h1>
      <h1>My todos</h1>
      <button onClick={signOut}>Sign out</button>
    </main>
  );
}


export default App;
