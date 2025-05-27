import { signInWithRedirect } from 'aws-amplify/auth';

await signInWithRedirect({
    provider: 'Google'
});