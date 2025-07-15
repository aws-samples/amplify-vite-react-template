import { defineAuth, secret } from '@aws-amplify/backend';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
    externalProviders: {
      google: {
        clientId: secret('GOOGLE_CLIENT_ID'),
        clientSecret: secret('GOOGLE_CLIENT_SECRET'),
        scopes: ['email'],
      },
      callbackUrls: [
        'http://localhost:3000/profile',
        'https://eye-of-gaia.com/profile'
      ],
      logoutUrls: ['http://localhost:3000/', 'https://eye-of-gaia.com'],
    }
  },
});
