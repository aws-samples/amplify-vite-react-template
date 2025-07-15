import { defineAuth, secret } from '@aws-amplify/backend';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */

const env = process.env.AWS_BRANCH;
let callbackUrls: string[] = [];
let logoutUrls: string[] = [];

if (env === 'dev') {
  callbackUrls = ['http://localhost:5173/profile', 'https://dev.eye-of-gaia.com/profile'];
  logoutUrls = ['http://localhost:5173/', 'https://dev.eye-of-gaia.com'];
} else if (env === 'qa') {
  callbackUrls = ['https://qa.eye-of-gaia.com/profile'];
  logoutUrls = ['https://qa.eye-of-gaia.com'];
} else if (env === 'main') {
  callbackUrls = ['https://eye-of-gaia.com/profile'];
  logoutUrls = ['https://eye-of-gaia.com'];
} else {
  // Default fallback
  callbackUrls = ['http://localhost:5173/profile'];
  logoutUrls = ['http://localhost:5173/'];
}
export const auth = defineAuth({
  loginWith: {
    email: true,
    externalProviders: {
      google: {
        clientId: secret('GOOGLE_CLIENT_ID'),
        clientSecret: secret('GOOGLE_CLIENT_SECRET'),
        scopes: ['email'],
      },
      callbackUrls,
      logoutUrls
    }
  },
});
